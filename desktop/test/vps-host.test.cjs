// Runs the real scripts/vps-browser-host.cjs broker against a stub CDP socket.
// No Chromium launches; the fixture answers just enough DevTools protocol to
// exercise the overseer role and the human-controlled read gate end to end.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
function wsAccept(key) {
  return crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
}
function wsFrame(data) {
  const payload = Buffer.from(data);
  let header;
  if (payload.length < 126) header = Buffer.from([0x81, payload.length]);
  else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81; header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81; header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  return Buffer.concat([header, payload]);
}
function wsParse(buffer) {
  const frames = [];
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const opcode = buffer[offset] & 0x0f,
      masked = buffer[offset + 1] & 0x80;
    let length = buffer[offset + 1] & 0x7f,
      cursor = offset + 2;
    if (length === 126) {
      if (cursor + 2 > buffer.length) break;
      length = buffer.readUInt16BE(cursor); cursor += 2;
    } else if (length === 127) {
      if (cursor + 8 > buffer.length) break;
      length = Number(buffer.readBigUInt64BE(cursor)); cursor += 8;
    }
    let mask;
    if (masked) {
      if (cursor + 4 > buffer.length) break;
      mask = buffer.subarray(cursor, cursor + 4); cursor += 4;
    }
    if (cursor + length > buffer.length) break;
    let payload = buffer.subarray(cursor, cursor + length);
    if (mask) {
      const clear = Buffer.alloc(length);
      for (let i = 0; i < length; i++) clear[i] = payload[i] ^ mask[i % 4];
      payload = clear;
    }
    frames.push({ opcode, payload });
    offset = cursor + length;
  }
  return { frames, rest: buffer.subarray(offset) };
}
function stubEvaluate(pages, sessionId, expression) {
  const page = pages.get(sessionId) || { url: 'about:blank', title: 'Stub page' };
  if (expression.includes('items.push'))
    return { title: page.title, url: page.url, text: 'stub page text',
      elements: [{ ref: 's1-1', role: 'button', name: 'Stub button', type: '', value: '', href: '', disabled: false }],
      viewport: { width: 900, height: 700, deviceScaleFactor: 1 }, iframes: [] };
  if (expression.includes('document.readyState')) {
    if (String(page.url).includes('slow.example')) return { url: page.url, title: page.title, ready: 'loading' };
    return { url: page.url, title: page.title, ready: 'complete' };
  }
  if (expression.includes('drafts.push')) return { url: page.url, title: page.title, scroll: { x: 0, y: 0 }, drafts: [] };
  if (expression.includes('c.drafts')) {
    const c = JSON.parse(/const c = (.*);\n/.exec(expression)[1]);
    return { verification: expression.includes('needs-review.example') || page.url !== c.url ? 'review_required' : 'ready', restored: 0, skipped: 0 };
  }
  if (expression.includes('link[rel~=icon]')) return '';
  if (expression.includes('innerWidth')) return { width: 900, height: 700, deviceScaleFactor: 1 };
  return null;
}
function createStubCdp() {
  const pages = new Map();
  let created = 0, active;
  const dispatch = (message) => {
    const { method, params = {}, sessionId } = message;
    const page = pages.get(sessionId);
    server.calls.push({ method, params, sessionId });
    switch (method) {
      case 'Target.getTargets': return { targetInfos: server.targets };
      case 'Target.createTarget': return { targetId: `stub-target-${++created}` };
      case 'Target.attachToTarget': {
        const id = `stub-session-${params.targetId}`;
        const known = server.targets.find((t) => t.targetId === params.targetId);
        pages.set(id, { url: known?.url || 'about:blank', title: known?.title || 'Stub page' });
        return { sessionId: id };
      }
      case 'Page.navigate':
        if (String(params.url).includes('fail.example')) return { __error: 'net::ERR_FAILED' };
        if (page) page.url = String(params.url).includes('redirect.example') ? 'https://login.example/' : params.url;
        return {};
      case 'Network.setCookies':
        return params.cookies.some((c) => c.name === 'bad') ? { __error: 'Invalid cookie fields' } : {};
      case 'Page.captureScreenshot': return { data: PNG };
      case 'Page.getNavigationHistory': return { currentIndex: 0, entries: [] };
      case 'Runtime.evaluate': return { result: { value: stubEvaluate(pages, sessionId, params.expression) } };
      default: return {};
    }
  };
  const server = http.createServer((req, res) => {
    if (req.url === '/json/version')
      return res.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}/devtools/browser/stub` }));
    res.writeHead(404);
    res.end();
  });
  server.calls = [];
  server.targets = [];
  server.send = (method, params, sessionId) => active.write(wsFrame(JSON.stringify({ method, params, sessionId })));
  server.on('upgrade', (req, socket) => {
    active = socket;
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${wsAccept(req.headers['sec-websocket-key'])}\r\n\r\n`,
    );
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const { frames, rest } = wsParse(buffer);
      buffer = rest;
      for (const frame of frames) {
        if (frame.opcode === 8) { socket.end(); return; }
        if (frame.opcode === 9) continue;
        if (frame.opcode !== 1) continue;
        const message = JSON.parse(frame.payload.toString());
        if (message.id) {
          const reply = dispatch(message);
          socket.write(wsFrame(JSON.stringify(reply?.__error ? { id: message.id, error: { message: reply.__error } } : { id: message.id, result: reply })));
        }
        if (message.method === 'Page.reload')
          setTimeout(() => socket.write(wsFrame(JSON.stringify({ method: 'Page.loadEventFired', sessionId: message.sessionId, params: {} }))), 300);
      }
    });
  });
  return server;
}

const hosts = [];
async function startHost({ env = {}, config = {}, tabs, targets, mirror } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-vps-host-'));
  const stub = createStubCdp();
  if (targets) stub.targets = targets;
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  const probe = http.createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ cdpUrl: `http://127.0.0.1:${stub.address().port}`, port, ...config }));
  if (tabs) fs.writeFileSync(path.join(dir, 'tabs.json'), JSON.stringify(tabs));
  if (mirror) fs.writeFileSync(path.join(dir, 'mirror.json'), JSON.stringify({ bots: mirror }));
  const child = spawn(process.execPath, [path.join(__dirname, '../scripts/vps-browser-host.cjs'), 'serve'], {
    env: { ...process.env, HERMES_VPS_BROWSER_DATA: dir, ...env },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const host = { dir, stub, child, stderr: '' };
  child.stderr.on('data', (chunk) => { host.stderr += chunk; });
  hosts.push(host);
  const connectionFile = path.join(dir, 'connection.json');
  for (const deadline = Date.now() + 60000; !fs.existsSync(connectionFile);) {
    assert.equal(child.exitCode, null, `VPS host exited early: ${host.stderr}`);
    assert.ok(Date.now() < deadline, `VPS host never wrote connection.json: ${host.stderr}`);
    await new Promise((r) => setTimeout(r, 50));
  }
  host.connection = JSON.parse(fs.readFileSync(connectionFile));
  host.appToken = JSON.parse(fs.readFileSync(path.join(dir, 'app-token.json'))).token;
  host.api = (route, method = 'GET', body, { bot = 'bot-a', human = false, epoch, token } = {}) =>
    fetch(host.connection.url + route, {
      method,
      headers: {
        Authorization: `Bearer ${token ?? (human ? host.appToken : host.connection.token)}`,
        'X-Hermes-Bot': bot,
        'X-Hermes-Human': human ? '1' : '0',
        'X-Control-Epoch': String(epoch ?? ''),
        'Content-Type': 'application/json',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }).then(async (response) => ({ status: response.status, data: await response.json() }));
  return host;
}

let main, api;
before(async () => {
  main = await startHost({ env: { HERMES_OVERSEER_BOT_IDS: 'overseer-1, overseer-2' } });
  api = main.api;
});
after(() => {
  for (const host of hosts) { host.child.kill(); host.stub.close(); }
});

test('an overseer lists every tab while regular bots see only their own', async () => {
  const a = (await api('/v1/tabs', 'POST', { url: 'http://alpha.example/' })).data;
  const b = (await api('/v1/tabs', 'POST', { url: 'http://beta.example/' }, { bot: 'bot-b' })).data;
  const aList = (await api('/v1/tabs')).data.tabs.map((t) => t.id);
  const bList = (await api('/v1/tabs', 'GET', undefined, { bot: 'bot-b' })).data.tabs.map((t) => t.id);
  const overseerList = (await api('/v1/tabs', 'GET', undefined, { bot: 'overseer-1' })).data.tabs.map((t) => t.id);
  assert.ok(aList.includes(a.id) && !aList.includes(b.id), 'bot-a sees only its tabs');
  assert.ok(bList.includes(b.id) && !bList.includes(a.id), 'bot-b sees only its tabs');
  assert.ok(overseerList.includes(a.id) && overseerList.includes(b.id), 'overseer sees every tab');
});

test('a continued page returns its tab without waiting for a slow load', async () => {
  const started = Date.now();
  const opened = await api('/v1/tabs', 'POST', { url: 'https://slow.example/doc', settle: false });
  assert.equal(opened.status, 201);
  assert.ok(Date.now() - started < 4000, 'settle:false must not wait out the load');
  assert.equal(opened.data.url, 'https://slow.example/doc');
});

test('bots cannot read a human-controlled tab until control is taken', async () => {
  const held = (await api('/v1/tabs', 'POST', { url: 'http://review.example/' }, { human: true })).data;
  assert.equal(held.controller, 'human');
  assert.equal((await api(`/v1/tabs/${held.id}/snapshot`, 'GET', undefined, { bot: 'bot-b' })).status, 403);
  for (const bot of ['bot-a', 'overseer-1']) {
    for (const read of ['snapshot', 'screenshot']) {
      const blocked = await api(`/v1/tabs/${held.id}/${read}`, 'GET', undefined, { bot });
      assert.equal(blocked.status, 409, `${bot} ${read} on a human tab`);
      assert.equal(blocked.data.error, 'Tab is under human control.');
    }
  }
  const meta = await api(`/v1/tabs/${held.id}`, 'GET', undefined, { bot: 'overseer-1' });
  assert.equal(meta.status, 200);
  assert.equal(meta.data.controller, 'human', 'metadata still reports who holds the tab');
  assert.equal((await api(`/v1/tabs/${held.id}/snapshot`, 'GET', undefined, { human: true })).status, 200);
  const checkpoint = await api(`/v1/tabs/${held.id}/checkpoint`, 'POST', { includeDrafts: true }, { human: true });
  assert.equal(checkpoint.status, 200);
  assert.equal(checkpoint.data.url, 'http://review.example/');
  const seized = await api(`/v1/tabs/${held.id}/control`, 'POST', { controller: 'agent' }, { bot: 'overseer-1' });
  assert.equal(seized.status, 200);
  assert.equal(seized.data.controller, 'agent');
  assert.equal((await api(`/v1/tabs/${held.id}/snapshot`, 'GET', undefined, { bot: 'overseer-1' })).status, 200);
});

test('snapshot bounds, since-dedupe and screenshot format params round-trip', async () => {
  const tab = (await api('/v1/tabs', 'POST', { url: 'http://bounds.example/' })).data;
  const first = await api(`/v1/tabs/${tab.id}/snapshot?maxChars=100&maxElements=10`);
  assert.equal(first.status, 200);
  assert.equal(first.data.text, 'stub page text');
  assert.ok(Number.isInteger(first.data.generation), 'snapshot reports its generation');
  const repeat = await api(`/v1/tabs/${tab.id}/snapshot?since=${first.data.generation}`);
  assert.equal(repeat.status, 200);
  assert.equal(repeat.data.unchanged, true, 'identical content with the last generation dedupes');
  assert.ok(repeat.data.generation > first.data.generation, 'dedupe still advances generation');
  assert.equal(repeat.data.text, undefined, 'an unchanged snapshot carries no payload');
  const chained = await api(`/v1/tabs/${tab.id}/snapshot?since=${repeat.data.generation}`);
  assert.equal(chained.data.unchanged, true, 'dedupe chains across consecutive generations');
  const nav = await api(`/v1/tabs/${tab.id}/actions`, 'POST',
    { action: 'navigate', url: 'http://bounds.example/moved', epoch: tab.epoch });
  assert.equal(nav.status, 200);
  const moved = await api(`/v1/tabs/${tab.id}/snapshot?since=${chained.data.generation}`);
  assert.notEqual(moved.data.unchanged, true, 'a url change breaks the hash and returns a full snapshot');
  assert.equal(moved.data.url, 'http://bounds.example/moved');
  const jpeg = await api(`/v1/tabs/${tab.id}/screenshot?format=jpeg&quality=50&maxWidth=400`);
  assert.equal(jpeg.status, 200);
  assert.equal(jpeg.data.mimeType, 'image/jpeg');
  assert.equal((await api(`/v1/tabs/${tab.id}/screenshot?format=png`)).data.mimeType, 'image/png');
  assert.equal((await api(`/v1/tabs/${tab.id}/screenshot?format=tiff`)).status, 400, 'unknown formats are rejected');
  assert.equal((await api(`/v1/tabs/${tab.id}/snapshot?maxChars=abc`)).status, 400, 'non-integer bounds are rejected');
});

test('an overseer releases and retakes another bot tab; a stranger cannot', async () => {
  const runaway = (await api('/v1/tabs', 'POST', { url: 'http://runaway.example/' }, { bot: 'bot-a' })).data;
  assert.equal(runaway.controller, 'agent');
  assert.equal((await api(`/v1/tabs/${runaway.id}/control`, 'POST', { controller: 'human' }, { bot: 'bot-b' })).status, 403);
  const released = await api(`/v1/tabs/${runaway.id}/control`, 'POST', { controller: 'human' }, { bot: 'overseer-2' });
  assert.equal(released.status, 200);
  assert.equal(released.data.controller, 'human');
  assert.equal((await api(`/v1/tabs/${runaway.id}/snapshot`, 'GET', undefined, { bot: 'bot-a' })).status, 409,
    'the read gate binds the owner too once the tab is human-controlled');
  assert.equal((await api(`/v1/tabs/${runaway.id}/checkpoint`, 'POST', {}, { human: true })).status, 200,
    'human checkpoint still works on a human-controlled tab');
  const retaken = await api(`/v1/tabs/${runaway.id}/control`, 'POST', { controller: 'agent' }, { bot: 'overseer-2' });
  const nav = await api(`/v1/tabs/${runaway.id}/actions`, 'POST',
    { action: 'navigate', url: 'http://halt.example/', epoch: retaken.data.epoch }, { bot: 'overseer-2' });
  assert.equal(nav.status, 200, 'overseer may act on the tab it controls');
  assert.equal((await api(`/v1/tabs/${runaway.id}/checkpoint`, 'POST', {}, { human: true })).status, 409,
    'checkpoint still requires human control');
  const foreign = await api(`/v1/tabs/${runaway.id}/actions`, 'POST',
    { action: 'reload', epoch: retaken.data.epoch + 1 }, { bot: 'bot-b' });
  assert.equal(foreign.status, 403, 'a stranger bot still cannot act');
});

test('reload answers only after the page load event arrives', async () => {
  const tab = (await api('/v1/tabs', 'POST', { url: 'http://reload.example/' })).data;
  const started = Date.now();
  const reload = await api(`/v1/tabs/${tab.id}/actions`, 'POST', { action: 'reload', epoch: tab.epoch });
  assert.equal(reload.status, 200);
  assert.ok(Date.now() - started >= 280, 'the action waited for Page.loadEventFired');
});

test('handed-off tabs refuse agent claims until the human gives them over', async () => {
  const source = (await api('/v1/tabs', 'POST', { url: 'http://source.example/' }, { human: true })).data;
  const retired = await api(`/v1/tabs/${source.id}/control`, 'POST',
    { controller: 'human', handoff: { id: 'h1', phase: 'handed_off', destinationHost: 'mac', destinationTabId: 'mac-tab' } }, { human: true });
  assert.equal(retired.data.handoff.phase, 'handed_off');
  const blocked = await api(`/v1/tabs/${source.id}/control`, 'POST', { controller: 'agent' });
  assert.equal(blocked.status, 409);
  assert.match(blocked.data.error, /handoff_source.*mac tab mac-tab/);
  assert.equal((await api(`/v1/tabs/${source.id}/control`, 'POST', { controller: 'agent' }, { bot: 'overseer-1' })).status, 409,
    'an overseer cannot reopen a handed-off source either');
  const given = await api(`/v1/tabs/${source.id}/control`, 'POST', { controller: 'agent' }, { human: true });
  assert.equal(given.data.handoff.phase, 'reviewed');
  assert.equal(given.data.controller, 'agent');
  await api(`/v1/tabs/${source.id}/control`, 'POST', { controller: 'human' }, { human: true });
  const locked = await api(`/v1/tabs/${source.id}/control`, 'POST', { controller: 'agent' });
  assert.equal(locked.status, 409, 'an explicit human takeover seals the tab to bots');
  assert.match(locked.data.error, /human_has_control/);
  assert.equal((await api(`/v1/tabs/${source.id}/control`, 'POST', { controller: 'agent' }, { human: true })).status, 200,
    'the human hands it back');
  await api(`/v1/tabs/${source.id}/control`, 'POST', { controller: 'human' });
  assert.equal((await api(`/v1/tabs/${source.id}/control`, 'POST', { controller: 'agent' })).status, 200,
    'a bot release stays retakeable');

  const restore = async (url) => {
    const tab = (await api('/v1/tabs', 'POST', { url }, { human: true })).data;
    const checkpoint = { url, title: '', scroll: { x: 0, y: 0 }, drafts: [] };
    await api(`/v1/tabs/${tab.id}/restore`, 'POST', { checkpoint, handoff: { id: tab.id, phase: 'review_required' } }, { human: true });
    return tab;
  };
  const unverified = await restore('http://needs-review.example/');
  const waiting = await api(`/v1/tabs/${unverified.id}/control`, 'POST', { controller: 'agent' });
  assert.equal(waiting.status, 409);
  assert.match(waiting.data.error, /handoff_review_required/);
  await api(`/v1/tabs/${unverified.id}/control`, 'POST', { controller: 'agent' }, { human: true });
  const verified = await restore('http://destination.example/');
  assert.equal((await api(`/v1/tabs/${verified.id}/control`, 'POST', { controller: 'agent' })).status, 200,
    'a verified destination continues without a human step');
});

test('the cdp action refuses cookie, storage, fetch and script-injection methods', async () => {
  const tab = (await api('/v1/tabs', 'POST', { url: 'http://cdp.example/' })).data;
  for (const method of ['Fetch.enable', 'Storage.getCookies', 'Network.getAllCookies', 'Network.setCookies', 'Page.addScriptToEvaluateOnNewDocument', 'Page.navigateToHistoryEntry', 'DOM.setFileInputFiles']) {
    const refused = await api(`/v1/tabs/${tab.id}/actions`, 'POST', { action: 'cdp', method, params: {}, epoch: tab.epoch });
    assert.equal(refused.status, 400, method);
  }
  const allowed = await api(`/v1/tabs/${tab.id}/actions`, 'POST', { action: 'cdp', method: 'Emulation.setTouchEmulationEnabled', params: { enabled: false }, epoch: tab.epoch });
  assert.equal(allowed.status, 200);
});

test('agents cannot reach loopback, link-local or metadata addresses; humans still can', async () => {
  for (const url of ['http://169.254.169.254/latest/meta-data/', 'http://127.0.0.1:9465/v1/tabs', 'http://localhost/', 'http://[::1]/']) {
    const refused = await api('/v1/tabs', 'POST', { url });
    assert.equal(refused.status, 400, `open ${url}`);
  }
  const tab = (await api('/v1/tabs', 'POST', { url: 'http://navguard.example/' })).data;
  const act = (body) => api(`/v1/tabs/${tab.id}/actions`, 'POST', { ...body, epoch: tab.epoch });
  assert.equal((await act({ action: 'navigate', url: 'http://169.254.169.254/' })).status, 400);
  assert.equal((await act({ action: 'cdp', method: 'Page.navigate', params: { url: 'http://127.0.0.1/' } })).status, 400);
  assert.equal((await act({ action: 'cdp', method: 'Page.navigate', params: {} })).status, 400);
  assert.equal((await act({ action: 'batch', steps: [{ action: 'navigate', url: 'http://localhost/' }] })).data.results[0].error, 'Agents cannot open loopback, link-local or metadata addresses.');
  const ok = await act({ action: 'cdp', method: 'Page.navigate', params: { url: 'navguard.example/ok' } });
  assert.equal(ok.status, 200);
  assert.ok(main.stub.calls.some((c) => c.method === 'Page.navigate' && c.params.url === 'https://navguard.example/ok'), 'cdp navigation goes through the normalized agent URL');
  const human = await api('/v1/tabs', 'POST', { url: 'http://127.0.0.1:8080/' }, { human: true });
  assert.equal(human.status, 201, 'the human may open a local page');
});

test('the agent token cannot claim to be the human or touch the mirror', async () => {
  const forged = await api('/v1/tabs', 'GET', undefined, { human: true, token: main.connection.token });
  assert.equal(forged.status, 403);
  const mirror = await api('/v1/mirror', 'POST', { bot: 'bot-a', tabs: [] });
  assert.equal(mirror.status, 403, 'mirror writes need the app token');
  assert.equal((await api('/v1/mirror', 'POST', { bot: 'bot-a', tabs: [] }, { human: true })).status, 200);
  const connection = fs.readFileSync(path.join(main.dir, 'connection.json'), 'utf8');
  assert.ok(!connection.includes(main.appToken), 'the agent connection file never carries the app token');
  assert.equal(fs.statSync(path.join(main.dir, 'app-token.json')).mode & 0o777, 0o600);
  const stranger = await fetch(main.connection.url + '/v1/tabs', { headers: { Authorization: 'Bearer nope', 'X-Hermes-Bot': 'bot-a' } });
  assert.equal(stranger.status, 401);
});

test('request mode sends the app token only for human and mirror operations', async () => {
  const run = (input) => new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, '../scripts/vps-browser-host.cjs'), 'request'], { env: { ...process.env, HERMES_VPS_BROWSER_DATA: main.dir } });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.on('close', () => resolve(JSON.parse(out)));
    child.stdin.end(JSON.stringify(input));
  });
  const human = await run({ path: '/v1/tabs', human: true, botId: 'bot-a' });
  assert.equal(human.status, 200);
  assert.ok(human.data.tabs.some((t) => t.botId === 'bot-b'), 'human lists every bot');
  const agent = await run({ path: '/v1/tabs', botId: 'bot-b' });
  assert.ok(agent.data.tabs.every((t) => t.botId === 'bot-b'));
  assert.equal((await run({ path: '/v1/mirror', method: 'POST', body: { bot: 'bot-a', tabs: [] }, botId: 'bot-a' })).status, 200, 'mirror push is an app operation');
});

test('request mode answers in ASCII only so a PowerShell shell cannot mangle UTF-8', async () => {
  const run = (input) => new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, '../scripts/vps-browser-host.cjs'), 'request'], { env: { ...process.env, HERMES_VPS_BROWSER_DATA: main.dir } });
    const chunks = [];
    child.stdout.on('data', (c) => chunks.push(c));
    child.on('close', () => resolve(Buffer.concat(chunks)));
    child.stdin.end(JSON.stringify(input));
  });
  const tab = (await api('/v1/tabs', 'POST', { url: 'http://ascii.example/' })).data;
  const info = { targetInfo: { targetId: tab.targetId, type: 'page', url: 'http://ascii.example/', title: 'Caf\u00e9 \u65e5\u672c \ud83d\ude00' } };
  main.stub.send('Target.targetInfoChanged', info);
  await until(async () => (await api(`/v1/tabs/${tab.id}`)).data.title === 'Café 日本 😀');
  const raw = await run({ path: '/v1/tabs', human: true, botId: 'bot-a' });
  assert.ok(raw.every((byte) => byte < 0x80), 'every byte is ASCII');
  const listed = JSON.parse(raw.toString('latin1')).data.tabs.find((t) => t.id === tab.id);
  assert.equal(listed.title, 'Caf\u00e9 \u65e5\u672c \ud83d\ude00', 'the escapes decode back to the same text');
});

test('a title-only change keeps the snapshot refs; a navigation drops them', async () => {
  const tab = (await api('/v1/tabs', 'POST', { url: 'http://refs.example/' })).data;
  const snap = (await api(`/v1/tabs/${tab.id}/snapshot`)).data;
  const click = () => api(`/v1/tabs/${tab.id}/actions`, 'POST', { action: 'click', ref: snap.elements[0].ref, epoch: tab.epoch });
  const info = (url, title) => ({ targetInfo: { targetId: tab.targetId, type: 'page', url, title } });
  main.stub.send('Target.targetInfoChanged', info('http://refs.example/', 'New title (1)'));
  await until(async () => (await api(`/v1/tabs/${tab.id}`)).data.title === 'New title (1)');
  const kept = await click();
  assert.ok(!/Stale or unknown/.test(kept.data.error || ''), 'unread-count title churn must not invalidate refs');
  main.stub.send('Target.targetInfoChanged', info('http://refs.example/next', 'Next'));
  await until(async () => (await api(`/v1/tabs/${tab.id}`)).data.url === 'http://refs.example/next');
  const dropped = await click();
  assert.equal(dropped.status, 409);
  assert.match(dropped.data.error, /Stale or unknown/);
});

test('a repeat snapshot asks the page to restamp the held refs', async () => {
  const tab = (await api('/v1/tabs', 'POST', { url: 'http://restamp.example/' })).data;
  await api(`/v1/tabs/${tab.id}/snapshot`);
  const before = main.stub.calls.length;
  await api(`/v1/tabs/${tab.id}/snapshot`);
  const read = main.stub.calls.slice(before).find((c) => c.method === 'Runtime.evaluate' && c.params.expression.includes('tokens.add'));
  assert.ok(read, 'the second snapshot ran the page expression');
  assert.ok(!read.params.expression.includes('if (-1 >= 0) tokens'), 'restamp is on once a baseline exists');
});

test('a failed navigation closes the tab it opened instead of leaking it', async () => {
  const before = (await api('/v1/tabs')).data.tabs.length;
  const failed = await api('/v1/tabs', 'POST', { url: 'http://fail.example/' });
  assert.equal(failed.status, 502);
  assert.equal((await api('/v1/tabs')).data.tabs.length, before);
  const created = main.stub.calls.filter((c) => c.method === 'Target.createTarget').length;
  const closed = main.stub.calls.filter((c) => c.method === 'Target.closeTarget').map((c) => c.params.targetId);
  assert.ok(closed.includes(`stub-target-${created}`), 'the half-opened target is closed');
});

test('a restarted broker reopens tabs whose targets are gone and keeps agent control', async () => {
  const saved = (id, targetId, extra) => ({ id, targetId, title: 'Saved', url: 'http://saved.example/' + id, botId: 'bot-a', allowedBots: [], controller: 'agent', epoch: 3, host: 'vps', ...extra });
  const host = await startHost({
    tabs: [saved('t-alive', 'alive-1'), saved('t-gone', 'gone-1'), saved('t-human', 'gone-2', { controller: 'human' }), saved('t-locked', 'gone-3', { controller: 'human', humanLock: true })],
    targets: [{ targetId: 'alive-1', type: 'page', url: 'http://alive.example/', title: 'Alive' }],
  });
  const list = (await host.api('/v1/tabs')).data.tabs;
  const by = Object.fromEntries(list.map((t) => [t.id, t]));
  assert.deepEqual(Object.keys(by).sort(), ['t-alive', 't-gone', 't-human', 't-locked']);
  assert.equal(by['t-alive'].url, 'http://alive.example/');
  for (const id of ['t-alive', 't-gone']) {
    assert.equal(by[id].controller, 'agent', `${id} stays with the agent`);
    assert.equal(by[id].epoch, 4, `${id} epoch moves on so stale refs are refused`);
  }
  assert.equal(by['t-human'].controller, 'human');
  assert.notEqual(by['t-gone'].targetId, 'gone-1');
  assert.ok(host.stub.calls.some((c) => c.method === 'Page.navigate' && c.params.url === 'http://saved.example/t-gone'), 'the saved URL is reopened');
  assert.equal((await host.api(`/v1/tabs/${list.find((t) => t.id === 't-gone').id}/snapshot`)).status, 200);
  const locked = await host.api(`/v1/tabs/${by['t-locked'].id}/control`, 'POST', { controller: 'agent' });
  assert.equal(locked.status, 409, 'a persisted takeover seal survives the restart');
  assert.match(locked.data.error, /human_has_control/);
  const plain = await host.api(`/v1/tabs/${by['t-human'].id}/control`, 'POST', { controller: 'agent' });
  assert.equal(plain.status, 200, 'a human-held tab that was never sealed stays claimable');
});

test('a port collision exits with a clear message and a distinct status', async () => {
  const probe = http.createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port;
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-vps-host-'));
    const stub = createStubCdp();
    await new Promise((r) => stub.listen(0, '127.0.0.1', r));
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ cdpUrl: `http://127.0.0.1:${stub.address().port}`, port }));
    const child = spawn(process.execPath, [path.join(__dirname, '../scripts/vps-browser-host.cjs'), 'serve'], { env: { ...process.env, HERMES_VPS_BROWSER_DATA: dir }, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (c) => { stderr += c; });
    const code = await new Promise((r) => child.on('close', r));
    stub.close();
    assert.equal(code, 78);
    assert.match(stderr, new RegExp(`127\\.0\\.0\\.1:${port}.*already in use`));
  } finally { probe.close(); }
});

test('a mirrored bot restores its tabs with cookies, scroll and drafts, once', async () => {
  const host = await startHost();
  const future = Math.floor(Date.now() / 1000) + 3600;
  const cookie = (extra) => ({ name: 'sid', value: 'abc', domain: '.shop.example', path: '/', expires: -1, httpOnly: true, secure: true, session: true, sameSite: 'Lax', ...extra });
  const tabsBody = [
    { id: 'mac-1', url: 'https://shop.example/cart', title: 'Cart', scroll: { x: 0, y: 120 },
      drafts: [{ selector: '#note', tag: 'INPUT', type: 'text', editable: false, value: 'hello' }, { selector: '#pw', tag: 'INPUT', type: 'password', editable: false, value: 'hunter2' }],
      cookies: [cookie(), cookie({ name: 'host', domain: 'shop.example', session: false, expires: future, sameSite: 'None' }), cookie({ name: 'old', session: false, expires: 5 })] },
    { id: 'mac-2', url: 'http://127.0.0.1/admin', title: 'Local', scroll: { x: 0, y: 0 }, drafts: [], cookies: [] },
  ];
  assert.equal((await host.api('/v1/mirror', 'POST', { bot: 'bot-m', tabs: tabsBody }, { human: true })).status, 200);
  const stored = JSON.parse(fs.readFileSync(path.join(host.dir, 'mirror.json'), 'utf8')).bots['bot-m'];
  assert.equal(fs.statSync(path.join(host.dir, 'mirror.json')).mode & 0o777, 0o600);
  assert.ok(stored.updatedAt > 0);
  assert.deepEqual(stored.tabs[0].drafts.map((d) => d.selector), ['#note'], 'password fields are never stored');

  const asStranger = await host.api('/v1/restore', 'POST', { bot: 'bot-m' }, { bot: 'bot-x' });
  assert.equal(asStranger.status, 403);
  const first = await host.api('/v1/restore', 'POST', { bot: 'bot-m' }, { bot: 'bot-m' });
  assert.equal(first.status, 200);
  assert.deepEqual(Object.keys(first.data.map), ['mac-1'], 'a loopback page is not reopened for the agent');
  const vmTab = first.data.map['mac-1'];
  const calls = host.stub.calls;
  const cookieCall = calls.find((c) => c.method === 'Network.setCookies');
  assert.deepEqual(cookieCall.params.cookies.map((c) => c.name), ['sid', 'host'], 'expired cookies are skipped');
  assert.equal(cookieCall.params.cookies[0].domain, '.shop.example');
  assert.equal(cookieCall.params.cookies[0].expires, undefined, 'a session cookie carries no expiry');
  assert.equal(cookieCall.params.cookies[1].url, 'https://shop.example/', 'a host-only cookie is set by url');
  assert.ok(calls.indexOf(cookieCall) < calls.findIndex((c) => c.method === 'Page.navigate' && c.params.url === 'https://shop.example/cart'), 'cookies land before the page loads');
  assert.ok(calls.some((c) => c.method === 'Runtime.evaluate' && c.params.expression.includes('"y":120') && c.params.expression.includes('hello') && !c.params.expression.includes('hunter2')), 'scroll and drafts are restored');
  const listed = (await host.api('/v1/tabs', 'GET', undefined, { bot: 'bot-m' })).data.tabs;
  assert.deepEqual(listed.map((t) => [t.id, t.controller, t.url]), [[vmTab, 'agent', 'https://shop.example/cart']]);
  // Ids are random hex and can hold the substring 'abc' by chance, so compare
  // the fields an agent could actually read.
  assert.ok(!JSON.stringify(listed.map(({ id, targetId, ...rest }) => rest)).includes('abc'), 'cookies are never readable through the tab API');

  const created = () => calls.filter((c) => c.method === 'Target.createTarget').length;
  const before = created();
  const second = await host.api('/v1/restore', 'POST', { bot: 'bot-m' }, { bot: 'bot-m' });
  assert.deepEqual(second.data.map, first.data.map, 'a second restore returns the same map');
  assert.equal(created(), before, 'and opens nothing new');
  const parallel = await Promise.all([1, 2].map(() => host.api('/v1/restore', 'POST', { bot: 'bot-m' }, { human: true })));
  assert.deepEqual(parallel.map((r) => r.data.map), [first.data.map, first.data.map]);

  await host.api(`/v1/tabs/${vmTab}`, 'DELETE', undefined, { bot: 'bot-m', epoch: 1 });
  const reopened = await host.api('/v1/restore', 'POST', { bot: 'bot-m' }, { bot: 'bot-m' });
  assert.notEqual(reopened.data.map['mac-1'], vmTab, 'a closed restored tab is reopened');
  assert.deepEqual((await host.api('/v1/restore', 'POST', { bot: 'nobody' }, { human: true })).data.map, {});
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// The stub socket records the broker's replies asynchronously; await the
// condition instead of trusting a fixed sleep on a busy runner.
const until = async (fn, ms = 10000) => {
  for (const deadline = Date.now() + ms; ;) {
    const value = await fn();
    if (value || Date.now() > deadline) return value;
    await wait(20);
  }
};
const sessionOf = (tab) => `stub-session-${tab.targetId}`;

test('a page that lands on a blocked address is sent back to about:blank, and such popups are closed', async () => {
  const host = await startHost();
  const tab = (await host.api('/v1/tabs', 'POST', { url: 'http://landing.example/' })).data;
  const navigations = () => host.stub.calls.filter((c) => c.method === 'Page.navigate' && c.sessionId === sessionOf(tab));
  for (const url of ['http://127.0.0.1:8082/secret', 'http://169.254.169.254/latest/meta-data/']) {
    const before = navigations().length;
    host.stub.send('Target.targetInfoChanged', { targetInfo: { targetId: tab.targetId, type: 'page', url, title: '' } });
    await until(() => navigations().length > before);
    assert.deepEqual(navigations().slice(before).map((c) => c.params.url), ['about:blank'], url);
  }
  const noted = (await host.api(`/v1/tabs/${tab.id}`)).data;
  assert.equal(noted.blocked.url, 'http://169.254.169.254/latest/meta-data/');
  assert.match(noted.blocked.reason, /loopback, link-local or metadata/);

  host.stub.send('Target.targetCreated', { targetInfo: { targetId: 'popup-bad', type: 'page', url: 'http://127.0.0.1:8082/secret', title: '', openerId: tab.targetId } });
  host.stub.send('Target.targetCreated', { targetInfo: { targetId: 'popup-ok', type: 'page', url: 'http://popup.example/', title: '', openerId: tab.targetId } });
  await until(() => host.stub.calls.some((c) => c.method === 'Target.closeTarget' && c.params.targetId === 'popup-bad'));
  // The good popup's attach is asynchronous too, so list it by condition.
  const urls = await until(async () => {
    const listed = (await host.api('/v1/tabs')).data.tabs.map((t) => t.url);
    return listed.includes('http://popup.example/') && listed;
  });
  assert.ok(urls && !urls.some((u) => u.includes('127.0.0.1')));

  const mine = (await host.api('/v1/tabs', 'POST', { url: 'http://mine.example/' }, { human: true })).data;
  const before = host.stub.calls.filter((c) => c.method === 'Page.navigate' && c.sessionId === sessionOf(mine)).length;
  host.stub.send('Target.targetInfoChanged', { targetInfo: { targetId: mine.targetId, type: 'page', url: 'http://127.0.0.1:3000/', title: '' } });
  // The reported url updates inside the same handler that would navigate, so
  // the readback proves the event was processed without racing it.
  await until(async () => (await host.api(`/v1/tabs/${mine.id}`, 'GET', undefined, { human: true })).data.url === 'http://127.0.0.1:3000/');
  assert.equal(host.stub.calls.filter((c) => c.method === 'Page.navigate' && c.sessionId === sessionOf(mine)).length, before, 'the human may browse local pages');
});

test('every request an agent tab makes is checked before it leaves, redirects, userinfo and subresources included', async () => {
  const host = await startHost();
  const tab = (await host.api('/v1/tabs', 'POST', { url: 'http://redir.example/' })).data;
  const enable = host.stub.calls.find((c) => c.method === 'Fetch.enable' && c.sessionId === sessionOf(tab));
  assert.deepEqual(enable.params.patterns, [{ urlPattern: '*' }], 'all resource types, not just documents');
  const paused = async (url, sessionId = sessionOf(tab), resourceType = 'XHR') => {
    const replies = () => host.stub.calls.filter((c) => /^Fetch\.(failRequest|continueRequest)$/.test(c.method) && c.params.requestId === url).map((c) => c.method);
    host.stub.send('Fetch.requestPaused', { requestId: url, request: { url }, resourceType }, sessionId);
    await until(() => replies().length);
    return replies();
  };
  for (const url of ['http://127.0.0.1:8082/secret', 'http://[::1]/x', 'http://u:p@127.0.0.1:8082/cred', 'http://2130706433/dec', 'http://169.254.169.254/latest'])
    assert.deepEqual(await paused(url, sessionOf(tab), 'Document'), ['Fetch.failRequest'], url);
  assert.deepEqual(await paused('http://localhost:9/img', sessionOf(tab), 'Image'), ['Fetch.failRequest']);
  assert.deepEqual(await paused('https://ok.example/x'), ['Fetch.continueRequest']);
  assert.deepEqual(await paused('https://user:pw@ok.example/x'), ['Fetch.continueRequest'], 'userinfo on a public host is not the barrier');
  assert.deepEqual(await paused('data:text/plain,hi'), ['Fetch.continueRequest']);
  const mine = (await host.api('/v1/tabs', 'POST', { url: 'http://mine2.example/' }, { human: true })).data;
  assert.ok(!host.stub.calls.some((c) => c.method === 'Fetch.enable' && c.sessionId === sessionOf(mine)), 'human tabs are not intercepted at all');
  assert.deepEqual(await paused('http://127.0.0.1:3000/dev', sessionOf(mine)), ['Fetch.continueRequest']);
  await host.api(`/v1/tabs/${mine.id}/control`, 'POST', { controller: 'agent' }, { human: true });
  assert.ok(host.stub.calls.some((c) => c.method === 'Fetch.enable' && c.sessionId === sessionOf(mine)), 'taking a tab for an agent turns the filter on');
  assert.ok(host.stub.calls.some((c) => c.method === 'Page.addScriptToEvaluateOnNewDocument' && c.sessionId === sessionOf(mine)), 'and seeds the settle tracker for new documents');
  await host.api(`/v1/tabs/${mine.id}/control`, 'POST', { controller: 'human' }, { human: true });
  assert.ok(host.stub.calls.some((c) => c.method === 'Fetch.disable' && c.sessionId === sessionOf(mine)), 'and giving it back turns it off');
  assert.ok(host.stub.calls.some((c) => /^Page\.remove(All)?ScriptsToEvaluateOnNewDocument$/.test(c.method) && c.sessionId === sessionOf(mine)), 'and lifts the seed');
  const refused = await host.api(`/v1/tabs/${tab.id}/actions`, 'POST', { action: 'cdp', method: 'Fetch.disable', epoch: tab.epoch });
  assert.equal(refused.status, 400, 'the agent cannot switch the filter off');
});

test('popups and frames are guarded from their first request, before the page resumes', async () => {
  const host = await startHost();
  const tab = (await host.api('/v1/tabs', 'POST', { url: 'http://opener.example/' })).data;
  assert.ok(host.stub.calls.some((c) => c.method === 'Target.setAutoAttach' && !c.sessionId && c.params.waitForDebuggerOnStart), 'browser-level auto-attach catches new pages');
  assert.ok(host.stub.calls.some((c) => c.method === 'Target.setAutoAttach' && c.sessionId === sessionOf(tab) && c.params.waitForDebuggerOnStart), 'page-level auto-attach catches frames and workers');
  const order = (sessionId) => host.stub.calls.filter((c) => c.sessionId === sessionId).map((c) => c.method);
  host.stub.send('Target.attachedToTarget', { sessionId: 'auto-popup', waitingForDebugger: true, targetInfo: { targetId: 'popup-1', type: 'page', url: '', openerId: tab.targetId } });
  await until(() => order('auto-popup').includes('Runtime.runIfWaitingForDebugger'));
  assert.deepEqual(order('auto-popup').filter((m) => m !== 'Target.setAutoAttach'), ['Fetch.enable', 'Page.addScriptToEvaluateOnNewDocument', 'Runtime.runIfWaitingForDebugger'], 'the filter and settle seed are on before the popup is released');
  host.stub.send('Target.attachedToTarget', { sessionId: 'auto-frame', waitingForDebugger: true, targetInfo: { targetId: 'frame-1', type: 'iframe', url: 'http://127.0.0.1:8082/' } }, sessionOf(tab));
  await until(() => order('auto-frame').includes('Runtime.runIfWaitingForDebugger'));
  assert.deepEqual(order('auto-frame').filter((m) => m !== 'Target.setAutoAttach'), ['Fetch.enable', 'Page.addScriptToEvaluateOnNewDocument', 'Runtime.runIfWaitingForDebugger'], 'a cross-process frame of an agent page is guarded');
  host.stub.send('Fetch.requestPaused', { requestId: 'frame-req', request: { url: 'http://127.0.0.1:8082/in-frame' }, resourceType: 'Document' }, 'auto-frame');
  assert.ok(await until(() => host.stub.calls.some((c) => c.method === 'Fetch.failRequest' && c.sessionId === 'auto-frame')), 'the frame request is denied');
  const mine = (await host.api('/v1/tabs', 'POST', { url: 'http://human-opener.example/' }, { human: true })).data;
  host.stub.send('Target.attachedToTarget', { sessionId: 'auto-human', waitingForDebugger: true, targetInfo: { targetId: 'popup-2', type: 'page', url: '', openerId: mine.targetId } });
  host.stub.send('Target.attachedToTarget', { sessionId: 'auto-stranger', waitingForDebugger: true, targetInfo: { targetId: 'popup-3', type: 'page', url: '' } });
  await until(() => order('auto-human').includes('Runtime.runIfWaitingForDebugger') && order('auto-stranger').includes('Runtime.runIfWaitingForDebugger'));
  for (const id of ['auto-human', 'auto-stranger']) {
    assert.ok(!order(id).includes('Fetch.enable'), id + ' is not filtered');
    assert.ok(order(id).includes('Runtime.runIfWaitingForDebugger'), id + ' is still released');
  }
});

test('a mirrored page that redirects to a login is reported for review', async () => {
  const host = await startHost();
  const tab = (url) => ({ id: 'mac-r', url, title: '', scroll: { x: 0, y: 0 }, drafts: [], cookies: [] });
  await host.api('/v1/mirror', 'POST', { bot: 'bot-r', tabs: [tab('https://redirect.example/account')] }, { human: true });
  const restored = await host.api('/v1/restore', 'POST', { bot: 'bot-r' }, { bot: 'bot-r' });
  assert.equal(restored.data.verification['mac-r'], 'review_required');
});

test('stale mirror entries are pruned at startup and never restored', async () => {
  const entry = (age) => ({ updatedAt: Date.now() - age, tabs: [{ id: 'm1', url: 'https://old.example/', title: '', scroll: { x: 0, y: 0 }, drafts: [], cookies: [] }], restored: {} });
  const host = await startHost({ mirror: { 'bot-old': entry(25 * 3600000), 'bot-new': entry(3600000) } });
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(host.dir, 'mirror.json'))).bots), ['bot-new']);
  assert.deepEqual((await host.api('/v1/restore', 'POST', { bot: 'bot-old' }, { bot: 'bot-old' })).data.map, {});
  assert.deepEqual(Object.keys((await host.api('/v1/restore', 'POST', { bot: 'bot-new' }, { bot: 'bot-new' })).data.map), ['m1']);
});

test('a newer mirror is re-applied to the tab a previous restore opened', async () => {
  const host = await startHost();
  const tab = (url, y) => ({ id: 'mac-n', url, title: '', scroll: { x: 0, y }, drafts: [], cookies: [] });
  await host.api('/v1/mirror', 'POST', { bot: 'bot-n', tabs: [tab('https://news.example/a', 10)] }, { human: true });
  const first = (await host.api('/v1/restore', 'POST', { bot: 'bot-n' }, { bot: 'bot-n' })).data.map['mac-n'];
  const navs = () => host.stub.calls.filter((c) => c.method === 'Page.navigate').length;
  const after = navs();
  assert.equal((await host.api('/v1/restore', 'POST', { bot: 'bot-n' }, { bot: 'bot-n' })).data.map['mac-n'], first);
  assert.equal(navs(), after, 'an unchanged mirror is not re-applied');
  await wait(5);
  await host.api('/v1/mirror', 'POST', { bot: 'bot-n', tabs: [tab('https://news.example/b', 99)] }, { human: true });
  const created = host.stub.calls.filter((c) => c.method === 'Target.createTarget').length;
  assert.equal((await host.api('/v1/restore', 'POST', { bot: 'bot-n' }, { bot: 'bot-n' })).data.map['mac-n'], first, 'the same VM tab is reused');
  assert.equal(host.stub.calls.filter((c) => c.method === 'Target.createTarget').length, created);
  assert.equal(host.stub.calls.filter((c) => c.method === 'Page.navigate').at(-1).params.url, 'https://news.example/b');
  assert.ok(host.stub.calls.some((c) => c.method === 'Runtime.evaluate' && c.params.expression.includes('"y":99')), 'the newer scroll is applied');
  assert.equal((await host.api(`/v1/tabs/${first}`, 'GET', undefined, { bot: 'bot-n' })).data.controller, 'agent');
});

test('one malformed cookie does not stop the rest being set', async () => {
  const host = await startHost();
  const cookie = (name) => ({ name, value: 'v', domain: '.jar.example', path: '/', expires: -1, httpOnly: false, secure: true, session: true });
  await host.api('/v1/mirror', 'POST', { bot: 'bot-c', tabs: [{ id: 'mac-c', url: 'https://jar.example/', title: '', scroll: { x: 0, y: 0 }, drafts: [], cookies: [cookie('good1'), cookie('bad'), cookie('good2')] }] }, { human: true });
  const restored = await host.api('/v1/restore', 'POST', { bot: 'bot-c' }, { bot: 'bot-c' });
  assert.ok(restored.data.map['mac-c'], 'the tab still opens');
  const singles = host.stub.calls.filter((c) => c.method === 'Network.setCookie').map((c) => c.params.name);
  assert.deepEqual(singles, ['good1', 'bad', 'good2'], 'falls back to one cookie at a time');
});

test('a restore of several slow pages runs in parallel and reports them for review', { timeout: 40000 }, async () => {
  const host = await startHost();
  const tabs = [1, 2, 3, 4].map((n) => ({ id: `slow-${n}`, url: `https://slow.example/${n}`, title: '', scroll: { x: 0, y: 0 }, drafts: [], cookies: [] }));
  await host.api('/v1/mirror', 'POST', { bot: 'bot-s', tabs }, { human: true });
  const started = Date.now();
  const restored = await host.api('/v1/restore', 'POST', { bot: 'bot-s' }, { bot: 'bot-s' });
  const took = Date.now() - started;
  assert.equal(Object.keys(restored.data.map).length, 4, 'every tab is opened');
  assert.ok(tabs.every((t) => restored.data.verification[t.id] === 'review_required'));
  // Serial would cost four full 5s load budgets plus eval round-trips; under
  // a loaded runner those trips stretch, so the bound stays well under serial.
  assert.ok(took >= 4500 && took < 15000, `four 5s waits overlap (took ${took}ms)`);
  const again = Date.now();
  const second = await host.api('/v1/restore', 'POST', { bot: 'bot-s' }, { bot: 'bot-s' });
  assert.deepEqual(second.data.map, restored.data.map);
  assert.ok(Date.now() - again < 5000, 'an idempotent repeat does not wait again');
});

test('a restore never takes a tab back from the human or overwrites agent work', async () => {
  const host = await startHost();
  const tab = (url, y) => ({ id: 'mac-h', url, title: '', scroll: { x: 0, y }, drafts: [], cookies: [] });
  const restore = () => host.api('/v1/restore', 'POST', { bot: 'bot-h' }, { bot: 'bot-h' });
  const navs = () => host.stub.calls.filter((c) => c.method === 'Page.navigate').length;
  await host.api('/v1/mirror', 'POST', { bot: 'bot-h', tabs: [tab('https://held.example/a', 0)] }, { human: true });
  const vm = (await restore()).data.map['mac-h'];
  const epoch = (await host.api(`/v1/tabs/${vm}`, 'GET', undefined, { bot: 'bot-h' })).data.epoch;

  const taken = await host.api(`/v1/tabs/${vm}/control`, 'POST', { controller: 'human' }, { human: true });
  await wait(5);
  await host.api('/v1/mirror', 'POST', { bot: 'bot-h', tabs: [tab('https://held.example/b', 50)] }, { human: true });
  const before = navs();
  const again = await restore();
  assert.equal(again.data.map['mac-h'], vm);
  assert.equal(again.data.verification['mac-h'], 'human_has_control');
  assert.equal(navs(), before, 'a human-held tab is not navigated');
  const held = (await host.api(`/v1/tabs/${vm}`, 'GET', undefined, { bot: 'bot-h' })).data;
  assert.equal(held.controller, 'human');
  assert.equal(held.epoch, taken.data.epoch, 'no epoch bump either');

  await host.api(`/v1/tabs/${vm}/control`, 'POST', { controller: 'agent' }, { human: true });
  const live = (await host.api(`/v1/tabs/${vm}`, 'GET', undefined, { bot: 'bot-h' })).data;
  await host.api(`/v1/tabs/${vm}/actions`, 'POST', { action: 'navigate', url: 'https://agent-went-here.example/', epoch: live.epoch }, { bot: 'bot-h' });
  await wait(5);
  await host.api('/v1/mirror', 'POST', { bot: 'bot-h', tabs: [tab('https://held.example/c', 70)] }, { human: true });
  const beforeWork = navs();
  const kept = await restore();
  assert.equal(kept.data.map['mac-h'], vm);
  assert.equal(navs(), beforeWork, 'a tab the agent has moved on with is left alone');
  assert.ok(epoch >= 1);
});
