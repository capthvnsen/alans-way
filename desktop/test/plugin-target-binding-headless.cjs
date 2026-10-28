// Actual public MCP -> router -> coherent VPS host -> real headless Chromium.
// Localhost only, private temporary profile, no Electron/native focus.
// ALANS_WAY_AGENTS=<plugin checkout> HERMES_TEST_CHROME=<Chromium executable>
// HERMES_BINDING_EVIDENCE=<output dir> node test/plugin-target-binding-headless.cjs
// Optional HERMES_FROZEN_DESKTOP tests that exact whole desktop, without overlays.
// Historical baseline requires an explicit matching before desktop and router.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const crypto = require('node:crypto');

const primary = path.resolve(__dirname, '../..');
const desktop = path.resolve(process.env.HERMES_FROZEN_DESKTOP || path.join(primary, 'desktop'));
for (const file of ['src/cdp.cjs', 'src/agent-input.cjs', 'src/browser-page.cjs', 'scripts/browser-mcp.cjs', 'scripts/vps-browser-host.cjs']) assert.ok(fs.existsSync(path.join(desktop, file)), 'HERMES_FROZEN_DESKTOP must name a complete coherent desktop candidate (or omit it to test the current checkout). Missing: ' + file);
const plugin = process.env.ALANS_WAY_AGENTS;
assert.ok(plugin, 'ALANS_WAY_AGENTS must name the plugin checkout');
const routerFile = process.env.HERMES_BINDING_ROUTER || path.join(plugin, 'alans-way/scripts/workspace-router.cjs');
assert.ok(fs.existsSync(routerFile), 'Set ALANS_WAY_AGENTS to a plugin checkout or HERMES_BINDING_ROUTER to its workspace-router.cjs.');
const evidence = process.env.HERMES_BINDING_EVIDENCE;
assert.ok(evidence, 'HERMES_BINDING_EVIDENCE must name a receipt directory');
fs.mkdirSync(evidence, { recursive: true });
const baseline = process.env.HERMES_BINDING_BASELINE === '1';
assert.ok(!baseline || (process.env.HERMES_FROZEN_DESKTOP && process.env.HERMES_BINDING_ROUTER), 'Historical baseline requires HERMES_FROZEN_DESKTOP and HERMES_BINDING_ROUTER pointing to a matching before candidate.');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-binding-headless-'));
const { CDP } = require(path.join(desktop, 'src/cdp.cjs'));
const chrome = process.env.HERMES_TEST_CHROME;
assert.ok(chrome && fs.existsSync(chrome), 'Set HERMES_TEST_CHROME to an installed Chromium executable; this real-browser regression cannot skip.');
const children = [], servers = [], wire = [], httpWire = [], results = [], counters = { pay: 0, help: 0, button: 0, clicks: [] };
let browser, host, cdp, client, connection, root, cdpPort;
const wait = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, label) => { for (const end = Date.now() + 30000;;) { const v = await fn(); if (v) return v; assert.ok(Date.now() < end, `Timed out: ${label}`); await wait(50); } };
const listen = async server => { servers.push(server); await new Promise(r => server.listen(0, '127.0.0.1', r)); return server.address().port; };
function child(file, args, opts = {}) {
  const p = spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'], ...opts }); children.push(p);
  let err = ''; p.stderr.on('data', b => { err += b; }); p.stderrText = () => err; return p;
}
function mcp(p, elicitation) {
  const incoming = [], pending = [];
  readline.createInterface({ input: p.stdout }).on('line', line => { const m = JSON.parse(line); wire.push({ direction: 'router_to_client', message: m }); (pending.shift() || (m => incoming.push(m)))(m); });
  let seq = 0;
  const send = m => { wire.push({ direction: 'client_to_router', message: m }); p.stdin.write(JSON.stringify(m) + '\n'); };
  const recv = async () => {
    if (incoming.length) return incoming.shift();
    let timer; return new Promise((resolve, reject) => { timer = setTimeout(() => reject(Error(`MCP timeout: ${p.stderrText()}`)), 30000); pending.push(resolve); }).finally(() => clearTimeout(timer));
  };
  const call = async (name, args) => { const id = ++seq; send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }); const response = await recv(); assert.ok(response.id === id || response.method === 'elicitation/create', JSON.stringify(response)); return { id, response }; };
  const init = async () => { send({ jsonrpc: '2.0', id: ++seq, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: elicitation ? { elicitation: {} } : {}, clientInfo: { name: 'local-binding-regression', version: '1' } } }); await recv(); send({ jsonrpc: '2.0', method: 'notifications/initialized' }); };
  return { send, recv, call, init };
}
function data(message) { const t = message.result?.content?.filter(x => x.type === 'text').map(x => x.text).join('\n') || JSON.stringify(message); const at = t.indexOf('{'); if (at >= 0) { try { return JSON.parse(t.slice(at)); } catch {} } return t; }
const text = m => typeof data(m) === 'string' ? data(m) : JSON.stringify(data(m));
async function request(route, method = 'GET', body) {
  return fetch(connection.url + route, { method, headers: { Authorization: `Bearer ${connection.token}`, 'X-Hermes-Bot': 'binding-bot', 'Content-Type': 'application/json', 'X-Control-Epoch': String(body?.epoch || '') }, ...(body ? { body: JSON.stringify(body) } : {}) }).then(async r => ({ status: r.status, data: await r.json() }));
}
async function pageFor(url) { return until(async () => (await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()).find(t => t.type === 'page' && t.url === url), 'browser page'); }
async function inspect(tab, name) {
  const t = await pageFor(tab.url), page = await cdp.page(t.id);
  const shot = await page.command('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(evidence, `${name}.png`), Buffer.from(shot.data, 'base64'));
  return page.executeJavaScript('({url:location.href,events:window.events || [],text:document.body.innerText})');
}
async function open(kind = 'action') {
  const url = `${root}/fixture?kind=${kind}&case=${results.length}`;
  const opened = await client.call('cua_alans_way_open', { url });
  const tab = data(opened.response); assert.ok(tab.id, JSON.stringify(opened));
  const snap = await client.call('cua_alans_way_snapshot', { tabId: tab.id });
  const snapshot = data(snap.response); assert.ok(Array.isArray(snapshot.elements), JSON.stringify(snap));
  return { ...tab, url, snapshot };
}
async function runCase(label, target, expected, options = {}) {
  const tab = await open(options.kind || 'action');
  const ref = tab.snapshot.elements.find(e => e.name === (options.kind === 'ordinary' ? 'Help' : 'Buy it again'))?.ref;
  if (target.ref === true) target = { ...target, ref };
  if (options.mutate) {
    const t = await pageFor(tab.url), page = await cdp.page(t.id);
    await page.executeJavaScript(options.mutate);
    if (options.refresh) await client.call('cua_alans_way_snapshot', { tabId: tab.id });
  }
  const before = structuredClone(counters), sentBefore = httpWire.filter(x => x.path.endsWith('/actions')).length;
  const args = { tabId: tab.id, epoch: tab.epoch, action: 'click', ...target, ...(options.commit ? { commit: { kind: 'purchase', summary: 'Local inert link regression' } } : {}) };
  let { id, response } = await client.call('cua_alans_way_action', args);
  const first = response;
  if (response.method === 'elicitation/create') {
    assert.equal(counters.pay, before.pay, 'no action before approval');
    assert.equal(httpWire.filter(x => x.path.endsWith('/actions')).length, sentBefore, 'no outbound action before approval');
    if (options.cancel) {
      client.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id } });
      response = await client.recv(); assert.equal(response.method, 'notifications/cancelled');
    } else {
      const answer = { jsonrpc: '2.0', id: response.id, result: options.decline ? { action: 'decline' } : { action: 'accept', content: { approve: true } } };
      client.send(answer); response = await client.recv(); assert.equal(response.id, id);
      if (!options.decline) { client.send(answer); await client.call('cua_alans_way_status', {}); }
    }
  }
  if (expected === 'pay' || expected === 'help') await until(() => counters[expected] === before[expected] + 1 && counters.clicks.length === before.clicks.length + 1, label + ' counter');
  else if (expected === 'button') { assert.ok(!response.result?.isError, text(response)); await until(() => counters.button === before.button + 1 && counters.clicks.length === before.clicks.length + 1, label + ' counter'); }
  else assert.match(text(response), expected, label);
  const actions = httpWire.filter(x => x.path.endsWith('/actions')).slice(sentBefore);
  if (['pay', 'help', 'button'].includes(expected)) assert.equal(actions.length, 1, label + ' exactly one outbound action');
  const delta = { pay: counters.pay - before.pay, help: counters.help - before.help, button: counters.button - before.button, clicks: counters.clicks.slice(before.clicks.length) };
  assert.equal(delta.pay, expected === 'pay' ? 1 : 0, label + ' action counter');
  assert.equal(delta.help, expected === 'help' ? 1 : 0, label + ' navigation counter');
  assert.equal(delta.button, expected === 'button' ? 1 : 0, label + ' button counter');
  assert.equal(delta.clicks.length, ['pay', 'help', 'button'].includes(expected) ? 1 : 0, label + ' trusted clicks');
  if (['pay', 'help', 'button'].includes(expected)) assert.equal(delta.clicks[0].trusted, true);
  if (options.zeroForward) assert.equal(actions.length, 0, label + ' outbound actions');
  const observed = await inspect({ ...tab, url: ['pay', 'help'].includes(expected) ? `${root}/${expected}` : tab.url }, label.replace(/[^a-z0-9-]/gi, '-'));
  results.push({ label, arguments: args, snapshot: tab.snapshot, first, response, actions, delta, observed });
  await request(`/v1/tabs/${tab.id}`, 'DELETE', { epoch: tab.epoch });
}
async function startClient(elicitation = true) {
  const p = child(process.execPath, [routerFile, '--bot-id', 'binding-bot', '--bot-name', 'Binding regression', '--vps-script', path.join(desktop, 'scripts/browser-mcp.cjs'), '--vps-connection', path.join(temp, 'proxy-connection.json'), '--mac-state-file', path.join(temp, 'mac-state.json')], { env: { ...process.env, HERMES_WORKSPACE_MAC_SSH: '', HERMES_WORKSPACE_ALLOW_LOOPBACK: '1' } });
  client = mcp(p, elicitation); await client.init(); return p;
}
(async () => {
  const site = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://local'); res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (url.pathname === '/click') { const event = JSON.parse(url.searchParams.get('event')); counters.clicks.push(event); if (event.tag === 'BUTTON') counters.button++; res.end('ok'); return; }
    if (url.pathname === '/pay' || url.pathname === '/help') { counters[url.pathname.slice(1)]++; res.end(`<h1>Inert ${url.pathname.slice(1)} counter: ${counters[url.pathname.slice(1)]}</h1>`); return; }
    const kind = url.searchParams.get('kind');
    const links = kind === 'rows' ? '<section>Lamp order<a id="target" href="/pay">Buy it again</a></section><section>Chair order<a href="/help">Buy it again</a></section>' : `<a id="target" href="/${kind === 'ordinary' || kind === 'stale' ? 'help' : 'pay'}">${kind === 'ordinary' ? 'Help' : 'Buy it again'}</a>`;
    res.end(`<!doctype html><meta charset="utf-8"><style>body{font:24px system-ui;margin:40px}a,button{display:block;margin:24px}</style><h1>Local approval boundary fixture</h1><p>No external destinations. Counters: pay=${counters.pay}, help=${counters.help}</p>${links}${kind === 'duplicate' ? '<a href="/help">Buy  it again</a>' : ''}${kind === 'roles' ? '<button>Buy it again</button>' : ''}<script>window.events=[];document.addEventListener('click',e=>{const a=e.target.closest('a,button');if(!a)return;const event={trusted:e.isTrusted,name:a.textContent,href:a.href||'',tag:a.tagName,type:e.type};events.push(event);navigator.sendBeacon('/click?event='+encodeURIComponent(JSON.stringify(event)))})</script>`);
  });
  root = `http://127.0.0.1:${await listen(site)}`;
  const profile = path.join(temp, 'profile');
  browser = child(chrome, ['--headless=new', ...(process.platform === 'darwin' ? ['--use-mock-keychain'] : []), '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-sandbox', '--disable-background-networking', 'about:blank']);
  const portFile = path.join(profile, 'DevToolsActivePort');
  await until(() => fs.existsSync(portFile) || (browser.exitCode !== null && assert.fail(browser.stderrText())), 'Chromium startup');
  cdpPort = fs.readFileSync(portFile, 'utf8').split('\n')[0];
  await until(() => fetch(`http://127.0.0.1:${cdpPort}/json/version`).then(r => r.ok, () => false), 'Chromium CDP');
  cdp = await CDP.connect(`http://127.0.0.1:${cdpPort}`);
  const hostData = path.join(temp, 'host'); fs.mkdirSync(hostData);
  const portProbe = http.createServer(); const port = await listen(portProbe); await new Promise(r => portProbe.close(r));
  fs.writeFileSync(path.join(hostData, 'config.json'), JSON.stringify({ cdpUrl: `http://127.0.0.1:${cdpPort}`, port }));
  host = child(process.execPath, [path.join(desktop, 'scripts/vps-browser-host.cjs'), 'serve'], { env: { ...process.env, HERMES_VPS_BROWSER_DATA: hostData, HERMES_WORKSPACE_ALLOW_LOOPBACK: '1' } });
  await until(() => fs.existsSync(path.join(hostData, 'connection.json')) || (host.exitCode !== null && assert.fail(host.stderrText())), 'browser host startup');
  connection = JSON.parse(fs.readFileSync(path.join(hostData, 'connection.json')));
  const proxy = http.createServer(async (req, res) => {
    const chunks = []; for await (const b of req) chunks.push(b); const body = Buffer.concat(chunks).toString();
    const record = { path: req.url, method: req.method, ...(body ? { body: JSON.parse(body) } : {}) }; httpWire.push(record);
    const reply = await fetch(connection.url + req.url, { method: req.method, headers: { ...req.headers, host: new URL(connection.url).host }, ...(body ? { body } : {}) });
    const output = await reply.text(); record.response = { status: reply.status, body: JSON.parse(output) }; res.writeHead(reply.status, { 'Content-Type': 'application/json' }); res.end(output);
  });
  fs.writeFileSync(path.join(temp, 'proxy-connection.json'), JSON.stringify({ ...connection, url: `http://127.0.0.1:${await listen(proxy)}` }));
  await startClient();
  await runCase('ref', { ref: true }, /commit_required/, { zeroForward: true });
  const names = ['Buy it again', ' Buy it again ', 'BUY IT AGAIN', 'Buy  it again', 'Buy\tit again', 'Buy\u00a0it again', 'Buy\u2003it again'];
  for (const [i, name] of names.entries()) await runCase(`name-${i}`, { name }, baseline && i >= 3 ? 'pay' : /commit_required/, { zeroForward: !baseline || i < 3 });
  await runCase('stale-href', { name: 'Buy it again' }, baseline ? 'pay' : /commit_required/, { kind: 'stale', mutate: "target.href='/pay'" });
  await runCase('stale-ref-href', { ref: true }, baseline ? 'pay' : /commit_required/, { kind: 'stale', mutate: "target.href='/pay'" });
  if (!baseline) {
    await runCase('missing', { name: 'Missing harmless label' }, /snapshot_required|not found|No control/i);
    await runCase('near', { name: 'Buy-it-again' }, /snapshot_required|not found|No control/i);
    await runCase('duplicate', { name: 'Buy it again' }, /snapshot_required|ambiguous|matches/i, { kind: 'duplicate' });
    await runCase('wrong-role', { name: 'Buy it again', role: 'button' }, /snapshot_required|not found|No control/i);
    await runCase('link-role', { name: 'Buy  it again', role: 'link' }, /commit_required/, { kind: 'roles', zeroForward: true });
    await runCase('button-role', { name: 'Buy\tit again', role: 'button' }, 'button', { kind: 'roles' });
    await runCase('row-action', { name: 'Buy\u00a0it again', role: 'link', row: 'Lamp  order' }, /commit_required/, { kind: 'rows', zeroForward: true });
    await runCase('row-ordinary', { name: 'Buy it again', role: 'a', row: 'Chair\torder' }, 'help', { kind: 'rows' });
    await runCase('stale-name', { name: 'Buy it again' }, /snapshot_required|not found|No control/i, { mutate: "target.remove()", refresh: true });
    await runCase('live-missing-name', { name: 'Buy it again' }, /No visible control|not_found|not found/i, { kind: 'stale', mutate: "target.remove()" });
    await runCase('live-duplicate-name', { name: 'Buy it again' }, /ambiguous|matches|controls/i, { kind: 'stale', mutate: "const twin=target.cloneNode(true);twin.id='twin';document.body.prepend(twin)" });
    await runCase('pointer-changed-href', { ref: true }, /commit_required/, { kind: 'stale', mutate: "target.addEventListener('pointermove',()=>target.href='/pay')" });
    await runCase('ordinary-name', { name: 'Help' }, 'help', { kind: 'ordinary' });
    await runCase('ordinary-ref', { ref: true }, 'help', { kind: 'ordinary' });
    await runCase('decline', { name: 'Buy\tit again' }, /declined/, { commit: true, decline: true, zeroForward: true });
    await runCase('cancel', { name: 'Buy\u00a0it again' }, /cancelled/, { commit: true, cancel: true, zeroForward: true });
    await runCase('approved-once', { name: 'Buy  it again' }, 'pay', { commit: true });
    const previous = children.at(-1); await stop(previous); await startClient(false);
    await runCase('no-capability', { name: 'Buy\tit again' }, /approval_unavailable/, { commit: true, zeroForward: true });
  }
  fs.writeFileSync(path.join(evidence, 'verdict.json'), JSON.stringify({ status: 'passed', baseline, desktop, browser: (await (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).json()).Browser, counters, cases: results.length, sourceHashes: Object.fromEntries([routerFile, path.join(desktop, 'src/agent-input.cjs'), path.join(desktop, 'src/browser-page.cjs'), path.join(desktop, 'scripts/browser-mcp.cjs'), path.join(desktop, 'scripts/vps-browser-host.cjs')].map(p => [p, crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')])) }, null, 2));
  console.log(`PASS: ${results.length} actual router/headless Chromium cases; ${JSON.stringify(counters)}`);
})().catch(e => { console.error(e.stack); process.exitCode = 1; }).finally(async () => {
  fs.writeFileSync(path.join(evidence, 'wire.json'), JSON.stringify(wire, null, 2));
  fs.writeFileSync(path.join(evidence, 'http.json'), JSON.stringify(httpWire, null, 2));
  fs.writeFileSync(path.join(evidence, 'results.json'), JSON.stringify(results, null, 2));
  fs.writeFileSync(path.join(evidence, 'stderr.json'), JSON.stringify(children.map(p => p.stderrText()), null, 2));
  cdp?.socket.close(); await Promise.all(children.map(stop));
  for (const server of servers) { server.closeAllConnections(); server.close(); }
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});
async function stop(p) { if (!p || p.exitCode !== null || p.signalCode) return; await new Promise(r => { const timer = setTimeout(() => p.kill('SIGKILL'), 3000); p.once('exit', () => { clearTimeout(timer); r(); }); p.kill(); }); }
