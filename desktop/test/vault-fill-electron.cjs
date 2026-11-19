require('./window-fixture.cjs');
// Run: npm run test:vault-fill
// The vault fill against a REAL page: Hermes's own inspection and fill scripts run in a real WebContentsView
// (fixture pages on loopback, a throwaway profile, a hidden window, made-up canary secret). Proves what the unit
// tests cannot: the password lands in the top document's password field only, a cross-origin iframe's field is
// never touched or described, a wrong origin / Deny / navigation types nothing, and nothing reaches the console.
const { app, BrowserWindow, WebContentsView } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createVaultFill } = require('../src/vault-fill.cjs');
const vaultLock = require('../src/vault-lock.cjs');
const { PW, inspectJs, fillJs } = require('./vault-fixtures.cjs');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-vault-fill-'));
app.setPath('userData', temp);
app.setName('Hermes isolated vault fill test');
const servers = [];
let win;
const seen = [];
const hooks = ['log', 'error', 'warn', 'info', 'debug'].map((k) => [k, console[k]]);
const stdout = process.stdout.write, stderr = process.stderr.write;
for (const [k] of hooks) console[k] = (...args) => { seen.push(args.map(String).join(' ')); };
process.stdout.write = function (chunk, ...rest) { seen.push(String(chunk)); return stdout.call(this, chunk, ...rest); };
process.stderr.write = function (chunk, ...rest) { seen.push(String(chunk)); return stderr.call(this, chunk, ...rest); };
const t0 = Date.now();
const say = (text) => stdout.call(process.stdout, `${text} (${Date.now() - t0} ms)\n`);

const listen = (host, handler) => new Promise((resolve) => {
  const server = http.createServer(handler);
  servers.push(server);
  server.listen(0, host, () => resolve(server.address().port));
});
const html = (res, body, headers = {}) => { res.setHeader('Content-Type', 'text/html'); for (const [k, v] of Object.entries(headers)) res.setHeader(k, v); res.end(body); };
const hung = new Set();

app.whenReady().then(async () => {
  const inner = await listen('localhost', (req, res) => html(res, '<!doctype html><title>inner</title><input id="ipw" type="password" autocomplete="current-password" aria-label="Embedded password">'));
  const innerOrigin = `http://localhost:${servers[0].address().port}`;
  const form = '<form id="f"><input id="user" name="username" autocomplete="username" aria-label="Email"><input id="pw" type="password" name="password" autocomplete="current-password" aria-label="Password"></form>';
  // The page (or an agent's earlier eval) wraps the builtins a fill would use, and records what passes through them.
  // The site's own input and change listeners are ordinary page code: they must still see the fill.
  const hooked = `<!doctype html><meta charset="utf-8"><title>Hooked</title>${form}<script>
    window.hooked = []; window.site = [];
    const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    Object.defineProperty(HTMLInputElement.prototype, 'value', { configurable: true, get() { return d.get.call(this); }, set(v) { hooked.push(['set', String(v)]); d.set.call(this, v); } });
    const gopd = Object.getOwnPropertyDescriptor; Object.getOwnPropertyDescriptor = function (...a) { hooked.push(['gopd', String(a[1])]); return gopd.apply(this, a); };
    const from = Array.from; Array.from = function (...a) { hooked.push(['from']); return from.apply(this, a); };
    const js = JSON.stringify; JSON.stringify = function (...a) { hooked.push(['json', js(a[0])]); return js.apply(this, a); };
    for (const type of ['input', 'change']) pw.addEventListener(type, (e) => site.push([type, e.isTrusted, d.get.call(e.target)]));
  </script>`;
  const outer = await listen('127.0.0.1', (req, res) => req.url.startsWith('/hang.png') ? hung.add(res) : req.url.startsWith('/hooked') ? html(res, hooked)
    : req.url.startsWith('/sbx') ? html(res, `<!doctype html><title>Sandboxed</title>${form}`, { 'Content-Security-Policy': 'sandbox allow-scripts' })
    : req.url.startsWith('/slow') ? html(res, `<!doctype html><title>Slow</title>${form}<img src="/hang.png">`)
    : html(res, req.url.startsWith('/login')
    ? `<!doctype html><meta charset="utf-8"><title>Login</title><form id="f"><input id="user" name="username" autocomplete="username" aria-label="Email"><input id="pw" type="password" name="password" autocomplete="current-password" aria-label="Password"></form><iframe id="frame" src="${innerOrigin}/inner"></iframe>
<script>window.inputs = 0; pw.addEventListener('input', () => { window.inputs++; });</script>`
    : '<!doctype html><title>Other</title><p>No form here</p>'));
  const outerOrigin = `http://127.0.0.1:${outer}`;
  win = new BrowserWindow({ show: false, width: 900, height: 700, webPreferences: { sandbox: true } });
  const view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 0, width: 900, height: 700 });
  const wc = view.webContents;
  // The navigation bookkeeping main.cjs keeps on an agent tab (createTab), which the gate reads.
  const tab = { id: 'fixture-tab', view, botId: 'alan', controller: 'agent', owner: 'bot', epoch: 1, generation: 0, navigationUrl: '', recoveryUrl: '', error: '' };
  wc.on('did-start-navigation', (_e, url, inPlace, isMainFrame) => { if (isMainFrame && !inPlace) tab.navigationUrl = url; });
  wc.on('did-navigate', () => { tab.navigationUrl = ''; tab.generation++; });
  wc.on('did-navigate-in-page', () => { tab.generation++; });
  vaultLock.watch(tab, wc);
  const navigate = async (url) => { await wc.loadURL(url); await wc.executeJavaScript('document.readyState'); };

  const log = [], asks = [], clock = { t: Date.now() };
  let decision = true;
  const vault = createVaultFill({ now: () => clock.t, botFor: (storedId) => (storedId === 'key-1' ? 'alan' : ''), nameFor: () => 'Alan', listTabs: () => [tab],
    command: async (t, method, params) => { const d = t.view.webContents.debugger; if (!d.isAttached()) d.attach('1.3'); return d.sendCommand(method, params); },
    ask: async (info) => { asks.push(info); return typeof decision === 'function' ? decision(info) : decision; }, log: (event, fields) => log.push([event, fields]) });
  let n = 0;
  const call = async (v) => JSON.parse((await vault.handle({ storedId: 'key-1', sessionId: 'rt-1', params: { session_id: 'rt-1', action: 'vault', vault: v } })).value);
  const session = async (origin, { fills } = {}) => {
    clock.t += 61000; // each fill is its own minute: the cooldown and the per-minute cap are the unit tests' business
    const opened = await call({ operation: 'open' });
    assert.equal(opened.success, true, JSON.stringify(opened));
    const nonce = `${String(++n).padStart(2, '0')}abcdef01234567`.slice(0, 16);
    const inspected = await call({ operation: 'evaluate', target: opened.target, expression: inspectJs(nonce) });
    assert.equal(inspected.success, true, JSON.stringify(inspected));
    return { opened, inspected, fill: () => call({ operation: 'evaluate', target: opened.target, expression: fillJs({ origin, nonce, ...(fills ? { fills } : {}) }) }) };
  };
  const field = (frameOf, id) => frameOf.executeJavaScript(`document.getElementById(${JSON.stringify(id)}).value`);
  const innerFrame = () => wc.mainFrame.frames.find((f) => f.url.startsWith(innerOrigin));

  // 1. Exact origin, Allow once: the password lands in the top document's password field and nothing else.
  await navigate(`${outerOrigin}/login`);
  await wc.mainFrame.executeJavaScript('new Promise(r => setTimeout(r, 300))');
  assert.ok(innerFrame(), 'the cross-origin iframe is loaded');
  const first = await session(outerOrigin);
  const controls = JSON.parse(first.inspected.result);
  assert.deepEqual(controls.map((c) => c.type), ['password'], 'only the top document\'s password control is described, never the iframe\'s or the username');
  assert.equal(await wc.mainFrame.executeJavaScript('document.querySelectorAll("[data-hermes-vault-slot]").length > 0'), true, 'the inspection stamped the controls');
  const filled = await first.fill();
  assert.deepEqual([filled.success, filled.result], [true, '{"filled":1}'], JSON.stringify(filled));
  assert.equal(await field(wc.mainFrame, 'pw'), PW, 'the password is in the top document');
  assert.equal(await wc.mainFrame.executeJavaScript('window.inputs'), 1, 'the page saw an input event');
  assert.equal(await field(wc.mainFrame, 'user'), '', 'the identifier is not typed');
  assert.equal(await field(innerFrame(), 'ipw'), '', 'the cross-origin iframe is untouched');
  assert.equal(await wc.mainFrame.executeJavaScript('document.querySelectorAll("[data-hermes-vault-slot]").length'), 0, 'the stamps are gone');
  assert.deepEqual(asks, [{ botId: 'alan', botName: 'Alan', origin: outerOrigin }]);
  say('PASS: the password lands in the top document only, after one Allow.');

  // 2. An entry bound to the iframe's origin cannot be filled while the top document is another site.
  await navigate(`${outerOrigin}/login`);
  await wc.mainFrame.executeJavaScript('new Promise(r => setTimeout(r, 300))');
  asks.length = 0;
  const embedded = await session(innerOrigin);
  const refused = await embedded.fill();
  assert.deepEqual([refused.success, refused.error_type], [false, 'origin_mismatch']);
  assert.deepEqual([await field(innerFrame(), 'ipw'), await field(wc.mainFrame, 'pw'), asks.length], ['', '', 0]);
  say('PASS: an entry for the iframe\'s site is refused on the framing page, and no frame is filled.');

  // 3. Lookalike hosts and other schemes of the page's own address.
  for (const bound of [outerOrigin.replace('127.0.0.1', 'localhost'), outerOrigin.replace('http:', 'https:'), `http://127.0.0.1:${outer < 65535 ? outer + 1 : outer - 1}`]) {
    const s = await session(bound);
    const out = await s.fill();
    assert.deepEqual([out.success, out.error_type], [false, 'origin_mismatch'], bound);
    assert.equal(await field(wc.mainFrame, 'pw'), '');
  }
  say('PASS: another host, scheme or port for the same page is refused.');

  // 4. Deny types nothing.
  decision = false;
  const denied = await (await session(outerOrigin)).fill();
  assert.deepEqual([denied.success, denied.error_type], [false, 'denied']);
  assert.equal(await field(wc.mainFrame, 'pw'), '');
  decision = true; clock.t += 61000; // past the cooldown a Deny starts
  say('PASS: Deny types nothing.');

  // 5. A navigation between the prompt and the fill (here: a real one, to another page of the same site) types nothing.
  const racing = await session(outerOrigin);
  decision = async () => { await navigate(`${outerOrigin}/other`); return true; };
  const raced = await racing.fill();
  assert.equal(raced.success, false, JSON.stringify(raced));
  assert.ok(['page_changed', 'navigating'].includes(raced.error_type), raced.error_type);
  assert.equal(await wc.mainFrame.executeJavaScript('document.body.textContent.includes("No form here")'), true);
  say('PASS: a navigation after the prompt refuses.');

  // 6. A page that rewrites JSON.stringify cannot forge the answer: the app rebuilds the count itself.
  decision = true;
  await navigate(`${outerOrigin}/login`);
  const hostile = await session(outerOrigin);
  await wc.mainFrame.executeJavaScript('JSON.stringify = () => \'{"filled":1,"echo":"hostile"}\'; 0');
  const hostileOut = await hostile.fill();
  assert.deepEqual([hostileOut.success, hostileOut.result], [true, '{"filled":1}'], JSON.stringify(hostileOut));
  assert.equal(hostileOut.raw === undefined && JSON.stringify(hostileOut).includes('hostile'), false);
  say('PASS: a page-forged answer is not forwarded.');

  // 7. A page (or an agent's earlier eval) that wrapped the builtins a fill uses captures nothing: the scripts run in an
  //    isolated world with its own. The site's own listeners, ordinary page code, still see the fill.
  decision = true;
  await navigate(`${outerOrigin}/hooked`);
  const hookedRun = await session(outerOrigin);
  assert.equal((await hookedRun.fill()).success, true);
  assert.equal(await field(wc.mainFrame, 'pw'), PW);
  const captured = JSON.stringify(await wc.mainFrame.executeJavaScript('window.hooked.map((h) => h.join(":"))'));
  assert.equal(captured.includes('CANARY'), false, `a wrapped setter, JSON.stringify, getOwnPropertyDescriptor or Array.from saw the password: ${captured.slice(0, 200)}`);
  assert.equal(captured.includes('current-password') || captured.includes('"from"'), false, 'none of the wrapped builtins ran at all for the vault');
  const site = await wc.mainFrame.executeJavaScript('window.site');
  assert.deepEqual(site.map(([type]) => type), ['input', 'change'], 'the site\'s own input and change listeners fired');
  assert.deepEqual(site.map(([, , value]) => value), [PW, PW], 'and read the filled value, so a real login form (a framework\'s listeners) works');
  assert.equal(tab.vaultLock, 'filled');
  say('PASS: wrapped builtins capture nothing; the site\'s own listeners still see the fill.');

  // 8. The lock follows the real navigation events: in-page and subframe navigations keep it, a new document ends it.
  await wc.mainFrame.executeJavaScript('history.pushState({}, "", "#after"); 0');
  assert.equal(tab.vaultLock, 'filled', 'an in-page navigation does not end the lock');
  await navigate(`${outerOrigin}/other`);
  assert.equal(tab.vaultLock, undefined, 'a cross-document navigation does');
  await navigate(`${outerOrigin}/login`);
  const afterBack = await session(outerOrigin);
  assert.equal((await afterBack.fill()).success, true);
  assert.equal(tab.vaultLock, 'filled');
  await wc.reload(); await wc.executeJavaScript('document.readyState');
  assert.equal(tab.vaultLock, undefined, 'a reload ends it');
  say('PASS: the lock outlives in-page navigation and ends with the document.');

  // 9. A sandboxed document (CSP sandbox) has an opaque origin: refused even though its URL is the bound origin.
  await navigate(`${outerOrigin}/sbx`);
  assert.equal(await wc.mainFrame.executeJavaScript('location.origin'), outerOrigin, 'the page itself still reports the URL\'s origin');
  assert.equal(wc.mainFrame.origin, 'null');
  asks.length = 0;
  const sandboxed = await call({ operation: 'open' });
  assert.deepEqual([sandboxed.success, sandboxed.error_type], [false, 'opaque_origin']);
  assert.equal(asks.length, 0);
  assert.equal(await field(wc.mainFrame, 'pw'), '');
  say('PASS: an opaque-origin document is never filled.');

  // 10. A load that never finishes (a hung subresource) does not stop a fill: the isolated world is not queued behind it.
  const slowLoad = wc.loadURL(`${outerOrigin}/slow`).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(wc.isLoading(), true, 'the page is still loading');
  const slow = await session(outerOrigin);
  assert.equal((await slow.fill()).success, true);
  assert.equal(await field(wc.mainFrame, 'pw'), PW);
  // Chromium retries a reset image once; keep failing it until the page settles.
  const failHung = setInterval(() => { for (const res of hung) res.destroy(); hung.clear(); }, 50);
  try { await Promise.race([slowLoad, new Promise((resolve) => setTimeout(resolve, 8000))]); } finally { clearInterval(failHung); }
  say('PASS: a fill does not wait for a hung subresource.');

  // 11. Stamps do not outlive a refused fill or a closed target.
  await navigate(`${outerOrigin}/login`);
  const stampCount = () => wc.mainFrame.executeJavaScript('document.querySelectorAll("[data-hermes-vault-slot]").length');
  decision = false; clock.t += 61000;
  const refusedStamps = await session(outerOrigin);
  assert.equal(await stampCount() > 0, true, 'the inspection stamped');
  assert.equal((await refusedStamps.fill()).error_type, 'denied');
  assert.equal(await stampCount(), 0, 'a refused fill took the stamps with it');
  const closing = await session(outerOrigin);
  assert.equal(await stampCount() > 0, true);
  await call({ operation: 'close', target: closing.opened.target });
  assert.equal(await stampCount(), 0, 'closing the target did too');
  say('PASS: stamps are removed when no fill follows.');

  // 12. The log and the console never carried the password.
  const everything = JSON.stringify([log, asks]) + seen.join('\n');
  assert.equal(everything.includes('CANARY'), false, 'the password is nowhere in the log, the prompts or the console');
  assert.ok(log.length >= 5);
  assert.equal(tab.agentScripted === true, false);
  say('PASS: no trace of the password in the log, the prompt, or the console.');
}).catch((error) => { process.exitCode = 1; stderr.call(process.stderr, `${error.stack}\n`); }).finally(() => {
  for (const [k, fn] of hooks) console[k] = fn;
  process.stdout.write = stdout; process.stderr.write = stderr;
  win?.destroy();
  for (const res of hung) res.destroy();
  for (const server of servers) { server.closeAllConnections?.(); server.close(); }
  app.exit(process.exitCode || 0);
});
const watchdog = setTimeout(() => { process.stderr.write('vault fill test exceeded its 90s deadline\n'); app.exit(1); }, 90000);
watchdog.unref();
app.on('quit', () => { fs.rmSync(temp, { recursive: true, force: true }); });
