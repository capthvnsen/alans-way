'use strict';
// Real main/preload/renderer, public loopback API and Chromium crash/stop events.
// Menu coverage invokes the actual constructed MenuItem callback, never OS input.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
if (!process.versions.electron) {
  if (process.env.BROWSER_RELOAD_LEASE !== 'granted') throw Error('Explicit coordinator visible fixture lease required.');
  const target = path.resolve(process.env.BROWSER_RELOAD_TARGET || path.join(__dirname, '..'));
  const out = path.resolve(process.env.BROWSER_RELOAD_OUT);
  fs.mkdirSync(out); // Retain every attempt, never overwrite its artifacts.
  const profile = path.join(out, 'profile'); fs.mkdirSync(profile);
  const log = fs.openSync(path.join(out, 'process.log'), 'w');
  const child = require('node:child_process').spawn(require('electron'), [__filename], {
    cwd: out, stdio: ['ignore', log, log],
    env: { PATH: process.env.PATH, HOME: profile, TMPDIR: profile, LANG: 'en_US.UTF-8',
      BROWSER_RELOAD_TARGET: target, BROWSER_RELOAD_OUT: out,
      BROWSER_RELOAD_MATRIX: process.env.BROWSER_RELOAD_MATRIX || 'full',
      HERMES_WORKSPACE_DATA: profile, HERMES_WORKSPACE_PORT: '0', HERMES_WORKSPACE_ALLOW_LOOPBACK: '1',
      ALANS_WAY_AGENTS: path.resolve(target, '../quality-plugin') },
  });
  fs.writeFileSync(path.join(out, 'parent-start.json'), JSON.stringify({ pid: child.pid, at: new Date().toISOString(), target, harness: sha(__filename) }, null, 2));
  const timer = setTimeout(() => { fs.appendFileSync(path.join(out, 'timeout.txt'), 'Owned child deadline: SIGTERM\n'); child.kill('SIGTERM'); }, 150000);
  child.once('close', (code, signal) => {
    clearTimeout(timer); fs.closeSync(log);
    fs.rmSync(profile, { recursive: true, force: true });
    const receipt = { pid: child.pid, code, signal, at: new Date().toISOString(), profileRemoved: !fs.existsSync(profile) };
    fs.writeFileSync(path.join(out, 'parent-exit.json'), JSON.stringify(receipt, null, 2));
    console.log(JSON.stringify(receipt)); process.exitCode = code === 0 && !signal ? 0 : 1;
  });
  return;
}

const electron = require('electron');
const { app, BrowserWindow, webContents, session, Menu } = electron;
const Module = require('node:module'), http = require('node:http'), net = require('node:net');
const target = path.resolve(process.env.BROWSER_RELOAD_TARGET), out = path.resolve(process.env.BROWSER_RELOAD_OUT);
const profile = process.env.HERMES_WORKSPACE_DATA;
const result = { startedAt: new Date().toISOString(), target, versions: process.versions, checks: [], cases: [], requests: [], events: [], imports: {}, guards: [], effects: [], captures: [] };
const save = () => fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2));
const check = (name, pass, details) => { result.checks.push({ name, pass: !!pass, details }); save(); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, why, ms = 10000) {
  const end = Date.now() + ms;
  do { const value = await fn(); if (value) return value; await sleep(25); } while (Date.now() < end);
  throw Error('Timed out: ' + why);
}
const local = h => ['localhost', '127.0.0.1', '::1', '[::1]'].includes(String(h));
const deny = (kind, arg) => { result.guards.push({ kind, arg: String(arg) }); throw Error('Reload fixture denied ' + kind); };
// Existing shared fixture is installed before actual main. Additional boundaries
// protect sockets/DNS, menu installation, frame focus and all newly made sessions.
result.sharedBoundaryHash = sha(path.join(__dirname, 'settings-fixture-boundaries.cjs'));
const sharedBlocked = require('./settings-fixture-boundaries.cjs')();
for (const name of ['userData', 'sessionData', 'cache', 'home', 'downloads', 'documents', 'desktop', 'logs', 'crashDumps', 'temp']) {
  const dir = path.join(profile, name); fs.mkdirSync(dir, { recursive: true }); app.setPath(name, name === 'userData' || name === 'sessionData' ? profile : dir);
}
require('node:os').homedir = () => path.join(profile, 'home');
app.commandLine.appendSwitch('site-per-process');
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-component-update');
app.setAsDefaultProtocolClient = () => false;
let applicationMenu;
Menu.setApplicationMenu = menu => { applicationMenu = menu; };
Menu.prototype.popup = () => deny('native-menu-popup', '');
for (const name of Object.keys(electron.clipboard)) if (typeof electron.clipboard[name] === 'function') electron.clipboard[name] = () => deny('clipboard.' + name, '');
for (const name of ['showOpenDialog', 'showSaveDialog', 'showMessageBox', 'showErrorBox']) electron.dialog[name] = () => deny('dialog.' + name, '');
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function(...args) {
  const a = Array.isArray(args[0]) ? args[0][0] : args[0];
  const host = typeof a === 'object' ? a.host || a.hostname || 'localhost' : typeof args[1] === 'string' ? args[1] : 'localhost';
  if (typeof a === 'string' && !/^\d+$/.test(a) || a?.path || !local(host)) return deny('socket', host);
  return connect.apply(this, args);
};
for (const name of ['lookup', 'resolve', 'resolve4', 'resolve6', 'reverse']) {
  const dns = require('node:dns'), original = dns[name];
  dns[name] = (host, ...args) => local(host) ? original.call(dns, host, ...args) : deny('dns', host);
}
const secure = new WeakSet();
function secureSession(s) {
  if (secure.has(s)) return; secure.add(s);
  const register = s.webRequest.onBeforeRequest.bind(s.webRequest);
  s.webRequest.onBeforeRequest = (...args) => register((details, done) => {
    const url = new URL(details.url);
    if (/^(https?|wss?|ftp):$/.test(url.protocol) && !local(url.hostname)) { result.guards.push({ kind: 'Chromium request', url: details.url }); return done({ cancel: true }); }
    const listener = args.at(-1); typeof listener === 'function' ? listener(details, done) : done({});
  });
  s.webRequest.onBeforeRequest(null);
  const request = s.setPermissionRequestHandler.bind(s), permission = s.setPermissionCheckHandler.bind(s);
  request((_wc, _name, done) => done(false)); permission(() => false);
  s.setPermissionRequestHandler = () => {}; s.setPermissionCheckHandler = () => {};
  s.setDisplayMediaRequestHandler((_req, done) => done({}));
}
app.on('session-created', secureSession);
app.whenReady().then(() => secureSession(session.defaultSession));
const nativeFrom = session.fromPartition.bind(session);
session.fromPartition = (...args) => { const s = nativeFrom(...args); secureSession(s); return s; };
const constructors = [];
const originalLoad = Module._load;
Module._load = function(id, parent, ...args) {
  const loaded = originalLoad.call(this, id, parent, ...args);
  if (id === 'electron') return new Proxy(loaded, { get(obj, key) {
    if (key === 'WebContentsView') return new Proxy(obj[key], { construct(C, values) {
      const view = new C(...values); constructors.push({ wc: view.webContents.id, preload: values[0]?.webPreferences?.preload }); return view;
    } });
    return obj[key];
  } });
  const resolved = Module._resolveFilename(id, parent);
  if (typeof resolved === 'string' && resolved.startsWith(target + path.sep) && fs.existsSync(resolved) && fs.statSync(resolved).isFile()) result.imports[path.relative(target, resolved)] = sha(resolved);
  return loaded;
};
const frame = wc => { try { const f = wc.mainFrame; return { live: !f.isDestroyed() && !f.detached, url: f.url }; } catch (e) { return { live: false, error: e.message }; } };
app.on('web-contents-created', (_event, wc) => {
  secureSession(wc.session); wc.focus = () => result.guards.push({ kind: 'webContents.focus suppressed', id: wc.id });
  const load = wc.loadURL.bind(wc);
  wc.loadURL = (url, ...args) => {
    const u = new URL(url);
    if (/^(https?|wss?|ftp):$/.test(u.protocol) && !local(u.hostname)) { result.guards.push({ kind: 'loadURL refused', url }); return Promise.reject(Error('External load refused.')); }
    return load(url, ...args);
  };
  for (const name of ['did-start-navigation', 'did-redirect-navigation', 'did-stop-loading', 'did-navigate', 'did-fail-load', 'render-process-gone']) wc.on(name, (_e, ...args) => {
    result.events.push({ id: wc.id, name, args, at: Date.now(), crashed: !wc.isDestroyed() && wc.isCrashed(), loading: !wc.isDestroyed() && wc.isLoading(), frame: frame(wc) });
  });
});
fs.writeFileSync(path.join(profile, 'preferences.json'), JSON.stringify({ onboarded: true, preview: false, autoTakeover: false, autoOpenLinks: false,
  bots: [{ id: 'reload-a', name: 'Reload A' }, { id: 'reload-b', name: 'Reload B' }], selectedBotId: 'reload-a', savedTabs: [], remoteUrl: '', macSshHost: '', vpsBrowser: {} }));
let win, shell, connection, server, base, conversation, sibling, menuReload, dropAfterEffect;
const held = new Set(), released = new Set(); let docs = 0;
const js = code => shell.executeJavaScript(code);
const state = () => js('window.workspace.getState()');
const info = async id => (await state()).tabs.find(t => t.id === id);
const command = (name, value) => js(`window.workspace.command(${JSON.stringify(name)},${JSON.stringify(value)})`);
async function api(route, method = 'GET', body, bot = 'reload-a') {
  const response = await fetch(connection.url + route, { method, headers: { Authorization: 'Bearer ' + connection.token, 'X-Hermes-Bot': bot, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, body: await response.json() };
}
async function action(tab, body, bot) { return api(`/v1/tabs/${tab.id}/actions`, 'POST', { epoch: (await info(tab.id)).epoch, ...body }, bot); }
async function tab(name) {
  const url = base + '/' + name, reply = await api('/v1/tabs', 'POST', { url, background: false }); assert.equal(reply.status, 201);
  const wc = await until(() => webContents.getAllWebContents().find(w => w.getURL() === url && !w.isLoading()), name);
  return { id: reply.body.id, wc, url };
}
async function crash(t) {
  const gone = new Promise(r => t.wc.once('render-process-gone', (_e, d) => r(d)));
  t.wc.forcefullyCrashRenderer(); await gone; await until(async () => (await info(t.id)).error, 'crash state');
}
async function startHeld(t, key, redirect = false) {
  const destination = base + '/hold/' + key;
  const pending = action(t, { action: 'cdp', method: 'Page.navigate', params: { url: base + (redirect ? '/redirect/' : '/hold/') + key } });
  await until(() => held.has(key), 'held ' + key); await sleep(70);
  return { destination, pending };
}
async function reload(t, entry) {
  await command('activate', { id: t.id }); const before = result.requests.length;
  const response = entry === 'api' ? await action(t, { action: 'reload' })
    : entry === 'menu' ? (menuReload.click(), { callbackInvoked: true })
      : (await js('document.getElementById("reload").click()'), { toolbarClicked: true });
  await until(() => !t.wc.isCrashed() && !t.wc.isLoading(), entry + ' reload'); await sleep(110);
  return { response, requests: result.requests.slice(before), after: await info(t.id), document: await t.wc.executeJavaScript('({id:documentIdentity,effects:localEffects,url:location.href})') };
}
async function one(name, fn) {
  const start = result.checks.length;
  try { await fn(); result.cases.push({ name, completed: true, pass: result.checks.slice(start).every(c => c.pass) }); }
  catch (e) { result.cases.push({ name, pass: false, error: e.stack }); }
  save();
}
async function run() {
  // Positive boundary probes are intentionally denied before real main.
  for (const [name, fn] of [
    ['child process', () => require('node:child_process').spawn('ssh', [])], ['external socket', () => net.connect({ host: 'fixture.invalid', port: 443 })],
    ['external HTTP', () => http.get('http://fixture.invalid/')], ['external fetch', () => fetch('https://fixture.invalid/')],
    ['clipboard', () => electron.clipboard.readText()], ['native shell', () => electron.shell.openExternal('https://fixture.invalid/')],
  ]) { let refused = false; try { await fn(); } catch { refused = true; } check('guard refuses ' + name, refused); }
  server = http.createServer((req, res) => {
    result.requests.push({ method: req.method, url: req.url, at: Date.now() });
    res.setHeader('Cache-Control', 'no-store');
    if (req.url.startsWith('/effect')) { result.effects.push({ url: req.url, method: req.method }); dropAfterEffect?.destroy(); dropAfterEffect = null; return res.end('ok'); }
    if (req.url.startsWith('/redirect/')) return res.writeHead(302, { Location: '/hold/' + req.url.split('/').at(-1) }).end();
    if (req.url.startsWith('/hold/')) { const key = req.url.split('/').at(-1); held.add(key); if (!released.has(key)) return; }
    if (req.url === '/failure' && !released.has('failure')) return res.destroy();
    const id = ++docs;
    res.setHeader('Content-Type', 'text/html'); res.end(`<!doctype html><title>Owned ${req.url}</title><h1>Owned ${req.url}</h1><button id="effect">Record local effect</button><input id="draft" value="Unsent fixture draft"><script>window.documentIdentity=${id};window.localEffects=0;effect.onclick=()=>{localEffects++;fetch('/effect?id=${id}',{method:'POST'})}</script>`);
  });
  const listening = new Promise(r => server.listen(0, '127.0.0.1', r));
  require(path.join(target, 'src/main.cjs')); // Must remain before app ready.
  await app.whenReady(); await listening; base = 'http://127.0.0.1:' + server.address().port;
  electron.screen.getCursorScreenPoint = () => ({ x: -10000, y: -10000 });
  result.ports = [server.address().port];
  win = await until(() => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/index.html')), 'shell'); shell = win.webContents;
  await until(() => js('!!window.workspace && !!document.getElementById("reload")').catch(() => false), 'bridge');
  connection = await until(() => { try { return JSON.parse(fs.readFileSync(path.join(profile, 'connection.json'))); } catch { return null; } }, 'API');
  result.ports.push(new URL(connection.url).port);
  menuReload = applicationMenu?.items.find(item => item.label === 'View')?.submenu.items.find(item => item.label === 'Reload Page');
  assert.equal(typeof menuReload?.click, 'function');
  result.provenance = Object.fromEntries(['src/main.cjs', 'src/agent-input.cjs', 'src/browser-page.cjs', 'src/renderer.js', 'src/preload.bundle.cjs', 'src/telegram-preload.bundle.cjs'].map(f => [f, sha(path.join(target, f))]));
  conversation = webContents.fromId(constructors.find(v => v.preload?.includes('telegram-preload.bundle'))?.wc);
  if (conversation) { await conversation.loadURL(base + '/inert-conversation'); await conversation.executeJavaScript('draft.value="Conversation unsent"'); }
  sibling = await tab('sibling'); await sibling.wc.executeJavaScript('draft.value="Sibling unsent"');
  for (const [entry, redirect] of [['api', false], ['menu', false], ...(process.env.BROWSER_RELOAD_MATRIX === 'red' ? [] : [['api', true], ['toolbar', true]])]) await one(entry + ' held crash ' + redirect, async () => {
    const t = await tab(entry + '-before-' + redirect), identity = await t.wc.executeJavaScript('documentIdentity');
    const key = entry + '-interrupted-' + redirect, nav = await startHeld(t, key, redirect);
    await crash(t); const oldAction = await nav.pending, before = await info(t.id);
    const index = result.requests.length, stale = await action(t, { action: 'reload', epoch: before.epoch + 1 });
    const wrong = await action(t, { action: 'reload' }, 'reload-b');
    check(entry + ' authority refusal happens before navigation', stale.status === 409 && wrong.status >= 400 && result.requests.length === index, { stale, wrong });
    check(entry + ' interrupted destination retained', before.recoveryUrl === nav.destination, before);
    const unavailable = await action(t, { action: 'read' });
    check(entry + ' crashed read is explicitly unavailable', unavailable.status !== 200 || !!unavailable.body.error, unavailable);
    released.add(key); const recovered = await reload(t, entry);
    check(entry + ' reload requests intended destination exactly once', recovered.requests.filter(r => r.url === '/hold/' + key).length === 1 && recovered.requests.filter(r => r.url === '/' + entry + '-before-' + redirect).length === 0 && recovered.after.url === nav.destination && !recovered.after.error, { before, recovered, oldAction });
    check(entry + ' recovery invalidates document honestly', recovered.document.id !== identity && recovered.document.effects === 0, recovered.document);
    check(entry + ' control epoch policy preserved', entry === 'toolbar' ? recovered.after.controller === 'human' && recovered.after.epoch > before.epoch : recovered.after.controller === before.controller && recovered.after.epoch === before.epoch, { before, after: recovered.after });
  });
  if (process.env.BROWSER_RELOAD_MATRIX === 'red') return;
  for (const entry of ['api', 'toolbar', 'menu']) await one(entry + ' completed cancellation crash', async () => {
    const t = await tab('committed-' + entry), nav = await startHeld(t, 'cancel-' + entry);
    t.wc.stop(); await until(() => !t.wc.isLoading(), 'completed stop'); await nav.pending;
    const live = frame(t.wc); assert.equal(live.live, true); await crash(t); released.add('cancel-' + entry);
    const recovered = await reload(t, entry);
    check(entry + ' cancellation remains committed after crash', recovered.after.url === t.url && recovered.requests.filter(r => r.url === '/committed-' + entry).length === 1 && !recovered.requests.some(r => r.url === '/hold/cancel-' + entry), { live, recovered });
  });
  await one('lost receipt and stale ref no replay', async () => {
    const t = await tab('one-effect'), snapshot = await api(`/v1/tabs/${t.id}/snapshot`), ref = snapshot.body.elements?.find(e => e.name === 'Record local effect')?.ref;
    assert.ok(ref); const epoch = (await info(t.id)).epoch, effects = result.effects.length;
    const identity = await t.wc.executeJavaScript('documentIdentity');
    const receipt = new Promise(resolve => {
      const req = http.request(connection.url + `/v1/tabs/${t.id}/actions`, { method: 'POST', headers: { Authorization: 'Bearer ' + connection.token, 'X-Hermes-Bot': 'reload-a', 'Content-Type': 'application/json' } }, res => { res.resume(); resolve('response arrived before drop'); });
      req.on('error', () => resolve('request destroyed after observed effect')); dropAfterEffect = req;
      req.end(JSON.stringify({ action: 'click', ref, epoch }));
    });
    await until(() => result.effects.length === effects + 1, 'actual effect');
    const dropped = await receipt; await sleep(80); await crash(t);
    const staleDuring = await action(t, { action: 'click', ref });
    const recovered = await reload(t, 'api'), staleAfter = await action(t, { action: 'click', ref });
    const fresh = await api(`/v1/tabs/${t.id}/snapshot`);
    check('actual effect receipt was lost without replay', dropped === 'request destroyed after observed effect' && result.effects.length === effects + 1 && result.effects.at(-1).method === 'POST' && recovered.document.effects === 0, { dropped, effects: result.effects.slice(effects), recovered });
    check('old refs remain stale and fresh document binding differs', staleDuring.status === 409 && staleAfter.status === 409 && recovered.document.id !== identity && fresh.body.approvalContext?.documentId !== snapshot.body.approvalContext?.documentId, { ref, staleDuring, staleAfter, before: snapshot.body, fresh: fresh.body });
  });
  await one('interrupted local POST form is never resubmitted', async () => {
    const t = await tab('local-form'), key = 'form-submit';
    // Inert owned fixture setup: Chromium submits a real form POST. This is
    // neither an agent approval bypass claim nor native input coverage.
    await t.wc.executeJavaScript(`document.body.insertAdjacentHTML('beforeend', '<form id="localform" method="POST" action="/hold/${key}"><input name="draft" value="owned inert form"></form>'); localform.requestSubmit()`);
    await until(() => held.has(key), 'actual held form POST'); await sleep(60);
    await crash(t); released.add(key); const recovered = await reload(t, 'api');
    const posts = result.requests.filter(r => r.url === '/hold/' + key && r.method === 'POST');
    check('explicit recovery uses one GET without replaying the uncertain form POST', posts.length === 1 && recovered.requests.filter(r => r.url === '/hold/' + key && r.method === 'GET').length === 1 && !recovered.requests.some(r => r.method === 'POST') && recovered.after.url === base + '/hold/' + key, { posts, recovered });
  });
  await one('newer history blank and failure destinations', async () => {
    const t = await tab('history-a');
    await action(t, { action: 'navigate', url: base + '/history-b' }); await action(t, { action: 'back' });
    await crash(t); const back = await reload(t, 'api'); check('history winner retained', back.after.url === t.url, back);
    const old = await startHeld(t, 'old-navigation'); t.wc.stop(); await until(() => !t.wc.isLoading(), 'old stopped'); await old.pending;
    await action(t, { action: 'navigate', url: base + '/newer-winner' }); await crash(t); released.add('old-navigation');
    const newer = await reload(t, 'api'); check('newer navigation wins', newer.after.url === base + '/newer-winner' && !newer.requests.some(r => r.url === '/hold/old-navigation'), newer);
    await t.wc.loadURL('about:blank'); await crash(t); await command('activate', { id: t.id }); menuReload.click();
    await until(() => !t.wc.isCrashed() && !t.wc.isLoading(), 'blank reload'); check('menu preserves about blank', t.wc.getURL() === 'about:blank', await info(t.id));
    await command('navigate', { id: t.id, url: base + '/failure' }); await until(async () => (await info(t.id)).error, 'real failure');
    await command('control', { id: t.id, controller: 'agent' }); released.add('failure'); const failure = await reload(t, 'api');
    check('API explicitly retries real failed destination once', failure.after.url === base + '/failure' && !failure.after.error && failure.requests.filter(r => r.url === '/failure').length === 1, failure);
  });
  await one('isolation and disk', async () => {
    check('sibling draft survives recovery', await sibling.wc.executeJavaScript('draft.value') === 'Sibling unsent');
    check('inert conversation draft and owner survive recovery', conversation && await conversation.executeJavaScript('draft.value') === 'Conversation unsent' && (await state()).selectedBotId === 'reload-a');
    await sleep(600); const disk = JSON.parse(fs.readFileSync(path.join(profile, 'preferences.json')));
    check('disk persists actual recovered URLs without canceled targets', disk.savedTabs.some(t => t.url === base + '/hold/api-interrupted-false') && !disk.savedTabs.some(t => /\/hold\/cancel-/.test(t.url)), { selectedBotId: disk.selectedBotId, savedTabs: disk.savedTabs });
    const image = await shell.capturePage(); fs.writeFileSync(path.join(out, 'recovered-shell.png'), image.toPNG()); result.captures.push({ name: 'recovered-shell.png', size: image.getSize(), scope: 'Software-rendered inactive shell only; child pixels may be unavailable.' });
  });
}
run().then(() => { result.completed = true; save(); app.exit(result.cases.every(c => c.pass) && result.checks.every(c => c.pass) ? 0 : 1); })
  .catch(error => { result.fatal = error.stack; save(); app.exit(1); });
process.on('exit', () => { result.sharedBlocked = sharedBlocked; result.finishedAt = new Date().toISOString(); save(); server?.closeAllConnections(); server?.close(); });
