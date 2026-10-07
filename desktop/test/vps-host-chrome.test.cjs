// Runs the real VPS browser host against a real headless Chromium to prove the
// agent URL barrier holds for redirects, userinfo, pop-ups, frames, workers and
// subresources. Skipped when no Chrome is found (set HERMES_TEST_CHROME).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { CDP } = require('../src/cdp.cjs');

function findChrome() {
  const home = os.homedir();
  const globs = (dir, rx) => { try { return fs.readdirSync(dir).filter((n) => rx.test(n)).map((n) => path.join(dir, n)); } catch { return []; } };
  const candidates = [
    process.env.HERMES_TEST_CHROME,
    ...globs(path.join(home, '.agent-browser', 'browsers'), /^chrome-/).map((d) => path.join(d, 'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')),
    ...globs(path.join(home, 'Library/Caches/ms-playwright'), /^chromium-\d+$/).flatMap((d) => globs(d, /^chrome-/).map((e) => path.join(e, 'Chromium.app/Contents/MacOS/Chromium'))),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ...['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'].flatMap((n) => (process.env.PATH || '').split(path.delimiter).map((d) => path.join(d, n))),
  ];
  return candidates.find((file) => file && fs.existsSync(file));
}
const chrome = findChrome();
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

let dir, profile, browser, host, site, secret, pa, pb, hits, connection, stderr = '', cdpPort;
const api = (route, method = 'GET', body, epoch) =>
  fetch(connection.url + route, {
    method,
    headers: { Authorization: `Bearer ${connection.token}`, 'X-Hermes-Bot': 'chrome-bot', 'X-Control-Epoch': String(epoch ?? ''), 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => ({ status: r.status, data: await r.json() }));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const call = (conn, appToken) => (route, method = 'GET', body, { bot = 'chrome-bot', human = false, epoch } = {}) =>
  fetch(conn.url + route, {
    method,
    headers: {
      Authorization: `Bearer ${human ? appToken : conn.token}`,
      'X-Hermes-Bot': bot,
      'X-Hermes-Human': human ? '1' : '0',
      'X-Control-Epoch': String(epoch ?? ''),
      'Content-Type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => ({ status: r.status, data: await r.json() }));
const extraHosts = [];
async function spawnHost(env) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-vps-reap-'));
  const data = path.join(d, 'data');
  fs.mkdirSync(data);
  const probe = http.createServer();
  const port = await new Promise((r) => { probe.listen(0, '127.0.0.1', () => { const n = probe.address().port; probe.close(() => r(n)); }); });
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ cdpUrl: `http://127.0.0.1:${cdpPort}`, port }));
  const hostEnv = { ...process.env, HERMES_VPS_BROWSER_DATA: data, ...env };
  delete hostEnv.HERMES_WORKSPACE_ALLOW_LOOPBACK;
  const child = spawn(process.execPath, [path.join(__dirname, '../scripts/vps-browser-host.cjs'), 'serve'], {
    env: hostEnv,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const rec = { child, dir: d, stderr: '' };
  child.stderr.on('data', (c) => { rec.stderr += c; });
  extraHosts.push(rec);
  for (let i = 0; i < 100 && !fs.existsSync(path.join(data, 'connection.json')); i++) await wait(100);
  assert.ok(fs.existsSync(path.join(data, 'connection.json')), `extra host never wrote connection.json: ${rec.stderr}`);
  rec.api = call(
    JSON.parse(fs.readFileSync(path.join(data, 'connection.json'))),
    JSON.parse(fs.readFileSync(path.join(data, 'app-token.json'))).token,
  );
  return rec;
}

before(async () => {
  if (!chrome) return;
  hits = [];
  secret = http.createServer((req, res) => { hits.push(req.method + ' ' + req.url); res.setHeader('content-type', 'text/html'); res.end('SECRET'); });
  secret.on('upgrade', (req, socket) => { hits.push('UPGRADE ' + req.url); socket.destroy(); });
  pb = await listen(secret);
  const T = `http://127.0.0.1:${pb}/secret`;
  const page = (html) => (res) => { res.setHeader('content-type', 'text/html'); res.end(html); };
  const routes = {
    '/redir': (res) => { res.writeHead(302, { Location: T + '?redir' }); res.end(); },
    '/redir-cred': (res) => { res.writeHead(302, { Location: `http://u:p@127.0.0.1:${pb}/secret?cred` }); res.end(); },
    '/redir-dec': (res) => { res.writeHead(302, { Location: `http://2130706433:${pb}/secret?dec` }); res.end(); },
    '/sub': page(`<script>fetch('${T}?fetch',{mode:'no-cors'}).catch(()=>{});var x=new XMLHttpRequest();x.open('GET','${T}?xhr');x.send();new Image().src='${T}?img';try{new WebSocket('ws://127.0.0.1:${pb}/ws')}catch(e){}navigator.sendBeacon('${T}?beacon','x')</script>sub`),
    '/iframe': page(`<iframe src="${T}?iframe"></iframe>`),
    '/form': page(`<form id=f method=post action="${T}?form"><input name=a value=1></form><script>f.submit()</script>`),
    '/worker.js': (res) => { res.setHeader('content-type', 'application/javascript'); res.end(`fetch('${T}?worker',{mode:'no-cors'})`); },
    '/worker': page(`<script>new Worker('/worker.js')</script>worker`),
    '/pop': page(`<script>setTimeout(()=>window.open("${T}?pop"),300)</script>pop`),
    '/pop-userinfo': page(`<script>setTimeout(()=>window.open("http://u:p@127.0.0.1:${pb}/secret?popcred"),300)</script>pop`),
    '/pop-blank': page(`<script>setTimeout(()=>{var w=window.open("about:blank");w.location="${T}?popblank"},300)</script>pop`),
    '/ok': page('<p id=ok>ok</p>' + '<img src="/i.png?1"><img src="/i.png?2"><img src="/i.png?3">'),
    '/i.png': (res) => { res.setHeader('content-type', 'image/png'); res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')); },
  };
  site = http.createServer((req, res) => (routes[new URL(req.url, 'http://x').pathname] || page('fixture'))(res));
  pa = await listen(site);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-vps-chrome-'));
  profile = path.join(dir, 'profile');
  browser = spawn(chrome, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-sandbox',
    '--host-resolver-rules=MAP test.example 127.0.0.1', 'about:blank'], { stdio: 'ignore' });
  const portFile = path.join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !fs.existsSync(portFile); i++) await wait(100);
  cdpPort = fs.readFileSync(portFile, 'utf8').split('\n')[0];
  const data = path.join(dir, 'data');
  fs.mkdirSync(data);
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ cdpUrl: `http://127.0.0.1:${cdpPort}`, port: await new Promise((r) => { const p = http.createServer(); p.listen(0, '127.0.0.1', () => { const n = p.address().port; p.close(() => r(n)); }); }) }));
  const env = { ...process.env, HERMES_VPS_BROWSER_DATA: data };
  delete env.HERMES_WORKSPACE_ALLOW_LOOPBACK;
  host = spawn(process.execPath, [path.join(__dirname, '../scripts/vps-browser-host.cjs'), 'serve'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  host.stderr.on('data', (c) => { stderr += c; });
  for (let i = 0; i < 100 && !fs.existsSync(path.join(data, 'connection.json')); i++) await wait(100);
  connection = JSON.parse(fs.readFileSync(path.join(data, 'connection.json')));
});
const exited = (child) => new Promise((resolve) => {
  if (!child || child.exitCode !== null || child.signalCode) return resolve();
  const force = setTimeout(() => child.kill('SIGKILL'), 3000);
  child.once('exit', () => { clearTimeout(force); resolve(); });
  child.kill();
});
after(async () => {
  site?.close();
  secret?.close();
  // Chrome keeps writing to its profile until it is gone, so wait for both exits.
  await Promise.all([exited(host), exited(browser), ...extraHosts.map((h) => exited(h.child))]);
  // Chrome's helper processes can outlive it on Linux; a leftover temp dir must not fail the run.
  for (const d of [dir, ...extraHosts.map((h) => h.dir)]) {
    if (d) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {} }
  }
});

test('real Chromium: an agent page cannot reach loopback or metadata by redirect, pop-up, frame, form, worker or subresource', { skip: !chrome && 'no Chrome found (set HERMES_TEST_CHROME)', timeout: 60000 }, async () => {
  const cases = ['redir', 'redir-cred', 'redir-dec', 'sub', 'iframe', 'form', 'worker', 'pop', 'pop-userinfo', 'pop-blank'];
  await Promise.all(cases.map((name) => api('/v1/tabs', 'POST', { url: `http://test.example:${pa}/${name}` })));
  await wait(3000);
  // WebSocket handshakes are invisible to the Fetch domain: a documented gap, so only they may arrive.
  const reached = hits.filter((h) => !h.startsWith('UPGRADE '));
  assert.deepEqual(reached, [], `loopback server was reached: ${reached.join(', ')}\n${stderr}`);
  const tabs = (await api('/v1/tabs')).data.tabs;
  assert.ok(tabs.some((t) => t.blocked), 'at least one tab reports why it was stopped');
  assert.ok(tabs.every((t) => !/127\.0\.0\.1/.test(t.url)), 'no agent tab rests on a loopback page');
  for (const tab of tabs) await api(`/v1/tabs/${tab.id}`, 'DELETE', undefined, tab.epoch);

  const ok = (await api('/v1/tabs', 'POST', { url: `http://test.example:${pa}/ok` })).data;
  const loadedImages = await api(`/v1/tabs/${ok.id}/actions`, 'POST', { action: 'eval', code: "[...document.images].filter((i) => i.complete && i.naturalWidth).length", epoch: ok.epoch });
  assert.equal(loadedImages.data.value, 3, 'ordinary subresources still load through the filter');
  const viaEval = await api(`/v1/tabs/${ok.id}/actions`, 'POST', { action: 'eval', code: `location.href='http://u@127.0.0.1:${pb}/secret?eval';1`, epoch: ok.epoch });
  assert.equal(viaEval.status, 200);
  await wait(1500);
  assert.deepEqual(hits.filter((h) => !h.startsWith('UPGRADE ')), [], 'script navigation is stopped too');
});

test('real Chromium: opening past a bot\'s tab cap closes its least recently used agent tabs and reports them', { skip: !chrome && 'no Chrome found (set HERMES_TEST_CHROME)', timeout: 60000 }, async () => {
  const h = await spawnHost({ ALANS_WAY_VM_MAX_TABS: '2' });
  const ha = h.api;
  const open = (opts) => ha('/v1/tabs', 'POST', { url: `http://test.example:${pa}/ok` }, { bot: 'cap-bot', ...opts });
  // A tab created straight on the browser (as if opened over VNC) is not the
  // host's to close.
  const direct = await CDP.connect(`http://127.0.0.1:${cdpPort}`);
  const foreign = (await direct.send('Target.createTarget', { url: 'about:blank' })).targetId;
  try {
    const t1 = (await open()).data;
    const second = await open();
    assert.equal(second.data.closedTabs, undefined, 'nothing is closed while under the cap');
    const t2 = second.data;
    const third = await open();
    assert.deepEqual(third.data.closedTabs, [{ tabId: t1.id, url: t1.url }], 'the coldest tab is reported and closed');
    assert.equal((await ha(`/v1/tabs/${t1.id}/snapshot`, 'GET', undefined, { bot: 'cap-bot' })).status, 404);
    const stale = await ha(`/v1/tabs/${t1.id}/actions`, 'POST', { action: 'eval', code: '1', epoch: t1.epoch }, { bot: 'cap-bot' });
    assert.equal(stale.status, 404);
    assert.equal(stale.data.error, 'VPS tab not found.');
    const t3 = third.data;
    // Touching t2 makes it more recently used than t3, so t3 is the next to go.
    assert.equal((await ha(`/v1/tabs/${t2.id}/snapshot`, 'GET', undefined, { bot: 'cap-bot' })).status, 200);
    const fourth = await open();
    assert.deepEqual((fourth.data.closedTabs || []).map((t) => t.tabId), [t3.id], 'LRU order, not age order');
    const t4 = fourth.data;
    // A human-controlled tab of the same bot is never a reaping candidate.
    const mine = (await ha('/v1/tabs', 'POST', { url: `http://test.example:${pa}/ok` }, { bot: 'cap-bot', human: true })).data;
    assert.equal(mine.controller, 'human');
    const fifth = await open();
    assert.deepEqual((fifth.data.closedTabs || []).map((t) => t.tabId), [t2.id]);
    const listed = (await ha('/v1/tabs', 'GET', undefined, { bot: 'cap-bot' })).data.tabs.map((t) => t.id).sort();
    assert.deepEqual(listed, [t4.id, fifth.data.id, mine.id].sort(), 'the two freshest plus the human tab remain');
    const targets = (await direct.send('Target.getTargets')).targetInfos.map((t) => t.targetId);
    assert.ok(targets.includes(foreign), 'a tab the host never opened is untouched');
    assert.equal((await ha(`/v1/tabs/${mine.id}`, 'GET', undefined, { human: true })).status, 200, 'the human tab survives too');
  } finally {
    direct.socket.close();
  }
});

test('real Chromium: agent tabs idle past the limit are closed lazily on the bot\'s next open', { skip: !chrome && 'no Chrome found (set HERMES_TEST_CHROME)', timeout: 30000 }, async () => {
  const h = await spawnHost({ ALANS_WAY_VM_MAX_TABS: '9', ALANS_WAY_VM_TAB_IDLE_MINUTES: '0.02' });
  const ha = h.api;
  const open = () => ha('/v1/tabs', 'POST', { url: `http://test.example:${pa}/ok` }, { bot: 'idle-bot' });
  const i1 = (await open()).data;
  const i2 = (await open()).data;
  const i3 = (await open()).data;
  assert.equal(i3.closedTabs, undefined, 'fresh tabs are never idle-reaped');
  await wait(1500);
  assert.equal((await ha(`/v1/tabs/${i3.id}/snapshot`, 'GET', undefined, { bot: 'idle-bot' })).status, 200, 'a snapshot counts as use');
  const reaped = await open();
  assert.deepEqual((reaped.data.closedTabs || []).map((t) => t.tabId).sort(), [i1.id, i2.id].sort(), 'both idle tabs close on the next open');
  assert.equal((await ha(`/v1/tabs/${i3.id}`, 'GET', undefined, { bot: 'idle-bot' })).status, 200, 'the refreshed tab survives');
  const gone = await ha(`/v1/tabs/${i2.id}/actions`, 'POST', { action: 'eval', code: '1', epoch: i2.epoch }, { bot: 'idle-bot' });
  assert.equal(gone.status, 404);
  assert.equal(gone.data.error, 'VPS tab not found.');
});

test('real Chromium: a tab mid-action is never reaped', { skip: !chrome && 'no Chrome found (set HERMES_TEST_CHROME)', timeout: 30000 }, async () => {
  const h = await spawnHost({ ALANS_WAY_VM_MAX_TABS: '2' });
  const ha = h.api;
  const open = () => ha('/v1/tabs', 'POST', { url: `http://test.example:${pa}/ok` }, { bot: 'busy-bot' });
  const busy = (await open()).data;
  const pending = ha(`/v1/tabs/${busy.id}/actions`, 'POST', { action: 'wait', text: 'never-appears-xyzzy', timeout: 2500, epoch: busy.epoch }, { bot: 'busy-bot' });
  await wait(300);
  const other = (await open()).data;
  const third = await open();
  assert.deepEqual((third.data.closedTabs || []).map((t) => t.tabId), [other.id], 'only the idle sibling is reaped');
  assert.equal((await ha(`/v1/tabs/${busy.id}`, 'GET', undefined, { bot: 'busy-bot' })).status, 200, 'the busy tab survives');
  assert.equal((await pending).status, 408, 'its pending wait still resolves normally');
});

test('real Chromium: a human takeover seals a VM tab to bot claims until the human hands it back', { skip: !chrome && 'no Chrome found (set HERMES_TEST_CHROME)', timeout: 30000 }, async () => {
  const h = await spawnHost({ HERMES_OVERSEER_BOT_IDS: 'overseer-1' });
  const ha = h.api;
  const tab = (await ha('/v1/tabs', 'POST', { url: `http://test.example:${pa}/ok` }, { bot: 'own-bot' })).data;
  assert.equal(tab.controller, 'agent');
  const taken = await ha(`/v1/tabs/${tab.id}/control`, 'POST', { controller: 'human' }, { human: true });
  assert.equal(taken.status, 200);
  assert.equal(taken.data.controller, 'human');
  for (const bot of ['own-bot', 'overseer-1']) {
    const claim = await ha(`/v1/tabs/${tab.id}/control`, 'POST', { controller: 'agent' }, { bot });
    assert.equal(claim.status, 409, `${bot} must not reclaim a human-held tab`);
    assert.match(claim.data.error, /human_has_control/);
  }
  // The takeover awaits persist(), so the seal is already on disk.
  const saved = JSON.parse(fs.readFileSync(path.join(h.dir, 'data', 'tabs.json'))).find((t) => t.id === tab.id);
  assert.equal(saved.humanLock, true, 'the seal survives a broker restart');
  const back = await ha(`/v1/tabs/${tab.id}/control`, 'POST', { controller: 'agent' }, { human: true });
  assert.equal(back.status, 200);
  assert.equal(back.data.controller, 'agent');
  const act = await ha(`/v1/tabs/${tab.id}/actions`, 'POST', { action: 'eval', code: '1', epoch: back.data.epoch }, { bot: 'own-bot' });
  assert.equal(act.status, 200, 'the owner acts again once the human hands the tab over');
});

test('real Chromium: the default cap is six agent tabs per bot', { skip: !chrome && 'no Chrome found (set HERMES_TEST_CHROME)', timeout: 60000 }, async () => {
  const opened = [];
  for (let i = 0; i < 6; i++) opened.push((await api('/v1/tabs', 'POST', { url: `http://test.example:${pa}/ok` })).data);
  const seventh = await api('/v1/tabs', 'POST', { url: `http://test.example:${pa}/ok` });
  assert.deepEqual((seventh.data.closedTabs || []).map((t) => t.tabId), [opened[0].id], 'the seventh open retires the first tab');
  const listed = (await api('/v1/tabs')).data.tabs.map((t) => t.id);
  for (const t of [...opened.slice(1), seventh.data]) assert.ok(listed.includes(t.id), `${t.id} still open`);
});
