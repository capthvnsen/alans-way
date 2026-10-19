'use strict';
// Actual main/preload/renderer and Chromium navigation/crash, disposable profile,
// loopback pages only. No OS focus, native input, accounts or provider traffic.
// BROWSER_RECOVERY_TARGET pins a frozen desktop tree; no build step is run.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const electron = require('electron');

if (typeof electron === 'string') {
  const { spawn } = require('node:child_process');
  const target = path.resolve(process.env.BROWSER_RECOVERY_TARGET || path.join(__dirname, '..'));
  const out = path.resolve(process.env.BROWSER_RECOVERY_OUT || fs.mkdtempSync(path.join(os.tmpdir(), 'browser-recovery-evidence-')));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-browser-recovery-'));
  fs.mkdirSync(out, { recursive: true });
  const fd = fs.openSync(path.join(out, 'electron.log'), 'w');
  const startedAt = new Date().toISOString();
  process.once('exit', code => fs.writeFileSync(path.join(out, 'wrapper-exit.json'), JSON.stringify({ pid: process.pid, code, exitedAt: new Date().toISOString() }) + '\n'));
  const child = spawn(electron, [`--user-data-dir=${profile}`, __filename], {
    cwd: target, env: { ...process.env, BROWSER_RECOVERY_TARGET: target, BROWSER_RECOVERY_OUT: out, HERMES_TEST_PROFILE: profile },
    stdio: ['ignore', fd, fd],
  });
  const deadline = setTimeout(() => child.kill('SIGKILL'), 90000);
  child.once('error', error => { console.error(error); process.exitCode = 1; });
  child.once('close', (code, signal) => {
    clearTimeout(deadline); fs.closeSync(fd);
    const receipt = { pid: child.pid, code, signal, startedAt, exitedAt: new Date().toISOString(), target, profileRemoved: false };
    fs.rmSync(profile, { recursive: true, force: true }); receipt.profileRemoved = !fs.existsSync(profile);
    fs.writeFileSync(path.join(out, 'process-exit.json'), JSON.stringify(receipt, null, 2) + '\n');
    console.log(fs.readFileSync(path.join(out, 'electron.log'), 'utf8').split('\n').filter(line => /^\{|^PASS|^FAIL|^FIXTURE WINDOW:/.test(line)).join('\n'));
    console.log(JSON.stringify(receipt));
    if (code !== 0 || signal) process.exitCode = 1;
  });
} else {
  require('./window-fixture.cjs');
  const { EventEmitter } = require('node:events');
  const Module = require('node:module');
  const http = require('node:http');
  const { app, BrowserWindow, ipcMain, session, webContents } = electron;
  const target = path.resolve(process.env.BROWSER_RECOVERY_TARGET);
  const out = path.resolve(process.env.BROWSER_RECOVERY_OUT);
  const profile = process.env.HERMES_TEST_PROFILE;
  if (!profile) throw Error('Disposable profile required.');
  const result = { scope: 'Actual isolated Electron/Chromium runtime; software-rendered fixture, no native/pixel/vendor parity claim', versions: process.versions,
    target, startedAt: new Date().toISOString(), checks: [], commands: [], events: [], requests: [], blocked: [], captures: [] };
  const save = () => fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(result, null, 2) + '\n');
  const check = (name, pass, details) => { result.checks.push({ name, pass: !!pass, details }); save(); console.log(JSON.stringify({ name, pass: !!pass })); };
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (read, predicate = Boolean, timeout = 10000) => {
    const end = Date.now() + timeout;
    do { const value = await read(); if (predicate(value)) return value; await sleep(25); } while (Date.now() < end);
    throw Error('Browser recovery fixture condition timed out.');
  };
  const local = value => /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/)/.test(String(value));
  const deny = name => (...args) => { result.blocked.push({ name, target: String(args[0] || '').slice(0, 150) }); throw Error(`Browser fixture forbids ${name}.`); };
  for (const name of ['userData','sessionData','cache','home','downloads','documents','desktop','logs','crashDumps','temp']) {
    const dir = name === 'userData' || name === 'sessionData' ? profile : path.join(profile, 'fixture-paths', name);
    fs.mkdirSync(dir, { recursive: true }); try { app.setPath(name, dir); } catch {}
  }
  process.env.HERMES_WORKSPACE_DATA = profile;
  process.env.HERMES_WORKSPACE_PORT = '0';
  process.env.HERMES_WORKSPACE_ALLOW_LOOPBACK = '1';
  app.getVersion = () => JSON.parse(fs.readFileSync(path.join(target, 'package.json'))).version;
  app.setAsDefaultProtocolClient = () => false;
  app.focus = () => result.blocked.push({ name: 'app.focus suppressed' });
  app.disableHardwareAcceleration();
  for (const flag of ['disable-renderer-backgrounding','disable-background-timer-throttling','site-per-process']) app.commandLine.appendSwitch(flag);
  for (const name of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']) require('node:child_process')[name] = deny(`child_process.${name}`);
  for (const name of ['request','get']) require('node:https')[name] = deny(`https.${name}`);
  for (const name of ['request','get']) {
    const original = http[name];
    http[name] = (value, ...args) => {
      const host = typeof value === 'string' || value instanceof URL ? new URL(value).hostname : value?.hostname || value?.host || 'localhost';
      if (!['127.0.0.1','localhost','::1','[::1]'].includes(host)) return deny(`http.${name}`)(host);
      return original.call(http, value, ...args);
    };
  }
  const realFetch = global.fetch;
  global.fetch = (url, ...args) => local(url) ? realFetch(url, ...args) : Promise.reject(Error('Browser fixture forbids external fetch.'));
  for (const name of ['request','fetch']) electron.net[name] = deny(`electron.net.${name}`);
  const secured = new WeakSet();
  function secure(s) {
    if (secured.has(s)) return s;
    secured.add(s);
    const register = s.webRequest.onBeforeRequest.bind(s.webRequest);
    s.webRequest.onBeforeRequest = (...args) => {
      const listener = typeof args.at(-1) === 'function' ? args.at(-1) : null;
      register((details, done) => {
        if (/^(https?|wss?|ftp):/.test(details.url) && !local(details.url)) {
          result.blocked.push({ name: 'Chromium external request', target: details.url.split('?')[0] }); return done({ cancel: true });
        }
        listener ? listener(details, done) : done({});
      });
    };
    s.webRequest.onBeforeRequest(null);
    const permission = s.setPermissionRequestHandler.bind(s);
    s.setPermissionRequestHandler = () => permission((_wc, _name, done) => done(false));
    s.setPermissionRequestHandler(null); s.setPermissionCheckHandler(() => false);
    return s;
  }
  const partition = session.fromPartition.bind(session);
  session.fromPartition = (...args) => secure(partition(...args));
  app.whenReady().then(() => secure(session.defaultSession));
  app.on('web-contents-created', (_e, wc) => {
    wc.focus = () => result.blocked.push({ name: 'webContents.focus suppressed', id: wc.id });
    const load = wc.loadURL.bind(wc);
    wc.loadURL = (url, ...args) => {
      if (/^https:\/\/web\.telegram\.org\//.test(url)) return load('data:text/html,' + encodeURIComponent('<title>Inert conversation fixture</title><label>Conversation draft <input id="conversation" value="Keep this conversation draft"></label>'));
      if (!/^(file:|about:|data:)/.test(url) && !local(url)) return Promise.reject(Error('External load refused.'));
      return load(url, ...args).catch(error => {
        (result.loadRejections ||= []).push({ url, code: error.code, errno: error.errno, message: error.message, crashed: wc.isCrashed() });
        throw error;
      });
    };
    for (const name of ['did-start-loading','did-stop-loading','did-finish-load','did-start-navigation','did-navigate','did-fail-load','did-fail-provisional-load','render-process-gone']) {
      wc.on(name, (_e, ...args) => {
        let frame;
        try { const f = wc.mainFrame; frame = { destroyed: f.isDestroyed(), detached: f.detached, frames: f.framesInSubtree.length }; }
        catch (error) { frame = { unavailable: error.message }; }
        result.events.push({ id: wc.id, name, args, at: Date.now(), crashed: wc.isCrashed(), loading: wc.isLoading(), frame, url: wc.getURL() });
      });
    }
  });
  class InertTray extends EventEmitter { setToolTip() {} setContextMenu() {} setImage() {} destroy() {} }
  const facade = { ...electron, Tray: InertTray, BrowserWindow: new Proxy(BrowserWindow, {
    construct(Constructor, args) {
      const win = new Constructor({ ...args[0], show: false, focusable: false, webPreferences: { ...args[0].webPreferences, backgroundThrottling: false } });
      win.focus = () => result.blocked.push({ name: 'BrowserWindow.focus suppressed' });
      win.show = () => win.showInactive();
      return win;
    },
  }),
    screen: { getPrimaryDisplay: () => electron.screen.getPrimaryDisplay(), getCursorScreenPoint: () => ({ x: -1000, y: -1000 }) },
    Menu: { ...electron.Menu, setApplicationMenu() {}, getApplicationMenu: () => null },
    powerMonitor: Object.assign(new EventEmitter(), { getSystemIdleTime: () => 0, getSystemIdleState: () => 'active' }),
  };
  for (const name of ['shell','clipboard','dialog','systemPreferences']) facade[name] = new Proxy({}, { get: (_o, key) => deny(`${name}.${String(key)}`) });
  const realLoad = Module._load;
  Module._load = function(request, parent, isMain) {
    if (request === 'electron') return facade;
    if (parent?.filename.startsWith(target) && /(?:^|\/)computer\.cjs$/.test(request)) return { service: new Proxy({ close() {} }, { get: (o, key) => o[key] || deny(`host computer ${String(key)}`) }) };
    return realLoad.call(this, request, parent, isMain);
  };
  const handles = new Map();
  const handle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, fn) => {
    handles.set(channel, fn);
    return handle(channel, async (event, ...args) => {
      if (channel === 'workspace:command') result.commands.push({ name: args[0], value: args[1], at: Date.now() });
      return fn(event, ...args);
    });
  };
  fs.writeFileSync(path.join(profile, 'preferences.json'), JSON.stringify({ onboarded: true, preview: false, autoOpenLinks: false,
    macSshHost: '', remoteUrl: '', vpsBrowser: { sshHost: '' }, bots: [{ id: '81001', name: 'Cedar' }, { id: '81002', name: 'Maple' }],
    order: ['81001','81002'], hidden: [], selectedBotId: '81001', savedTabs: [] }));
  require(path.join(target, 'src/main.cjs'));
  let server, proxy, win, shell, page, other, conversation;
  const state = () => shell.executeJavaScript('window.workspace.getState()');
  const command = (name, value) => shell.executeJavaScript(`window.workspace.command(${JSON.stringify(name)}, ${JSON.stringify(value)})`);
  const capture = async name => {
    const image = await shell.capturePage(); fs.writeFileSync(path.join(out, name + '.png'), image.toPNG());
    result.captures.push({ name: name + '.png', type: 'software-rendered inactive Electron fixture', size: image.getSize() }); save();
  };
  const click = async id => {
    if (!shell.debugger.isAttached()) shell.debugger.attach('1.3');
    const p = await shell.executeJavaScript(`(()=>{const n=document.getElementById(${JSON.stringify(id)});const r=n.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    await shell.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', ...p, button: 'left', clickCount: 1 });
    await shell.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', ...p, button: 'left', clickCount: 1 });
  };
  app.whenReady().then(async () => {
    win = await until(() => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/index.html')));
    shell = win.webContents;
    await until(() => shell.executeJavaScript('!!window.workspace && typeof state === "object"').catch(() => false));
    let releaseSlow = false, acceptFailed = false, actionPosts = 0;
    const pending = [];
    server = http.createServer((req, res) => {
      result.requests.push({ method: req.method, url: req.url, host: req.headers.host, at: Date.now() });
      if (req.url === '/slow' && !releaseSlow) { pending.push(res); return; }
      if (req.url.startsWith('/cancel')) { pending.push(res); return; }
      if (req.url === '/failed' && !acceptFailed) return res.destroy();
      res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' }).end(`<title>Local ${req.url}</title><style>body{font:20px system-ui;padding:30px;background:#edf3f6;color:#182633}input{font:inherit;padding:10px}</style><h1>Local ${req.url}</h1><label>Draft <input id="draft" aria-label="Draft" value="Untouched local draft"></label><script>window.inputCount=0;draft.addEventListener('input',()=>{inputCount++;fetch('/input-observed?value='+encodeURIComponent(draft.value))})</script>`);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    // Different sites ensure killing one real renderer cannot kill the sibling.
    const otherBase = `http://localhost:${server.address().port}`;
    const a = await command('create-tab', { url: base + '/start' });
    const b = await command('create-tab', { url: otherBase + '/other' });
    await until(state, s => s.tabs.length === 2 && s.tabs.every(t => !t.loading && !t.error));
    page = webContents.getAllWebContents().find(w => w.getURL() === base + '/start');
    other = webContents.getAllWebContents().find(w => w.getURL() === otherBase + '/other');
    conversation = webContents.getAllWebContents().find(w => w.session === session.fromPartition('persist:telegram'));
    const otherBefore = await other.executeJavaScript('({value:draft.value,count:inputCount,url:location.href})');
    const conversationBefore = await conversation.executeJavaScript('({value:conversation.value,url:location.href})');
    const before = await state();
    const pids = { page: page.getOSProcessId(), other: other.getOSProcessId(), shell: shell.getOSProcessId(), conversation: conversation.getOSProcessId() };
    check('real page renderer isolated from sibling, shell and conversation', Object.values(pids).every(Number.isInteger) && new Set(Object.values(pids)).size === 4, pids);
    if (!result.checks.at(-1).pass) throw Error('Crash isolation precondition failed.');
    await command('activate', { id: a.id });
    await capture('baseline-running');
    const controlled = await command('control', { id: a.id, controller: 'agent' });
    const connection = JSON.parse(fs.readFileSync(path.join(profile, 'connection.json'), 'utf8'));
    // One real host input executes, then this test-only proxy drops its receipt.
    // Recovery must neither replay the action nor transfer it to the sibling.
    proxy = http.createServer(async (req, res) => {
      let raw = ''; for await (const part of req) raw += part;
      actionPosts++;
      try {
        const reply = await fetch(new URL(`/v1/tabs/${a.id}/actions`, connection.url), { method: 'POST',
          headers: { Authorization: `Bearer ${connection.token}`, 'X-Hermes-Bot': '81001', 'Content-Type': 'application/json' }, body: raw });
        result.executedActionStatus = reply.status;
        await reply.text();
        res.destroy();
      } catch (error) { res.destroy(error); }
    });
    await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
    try {
      await fetch(`http://127.0.0.1:${proxy.address().port}`, { method: 'POST', body: JSON.stringify({ epoch: controlled.epoch, action: 'type', selector: '#draft', text: 'Input with lost receipt' }) });
      throw Error('Fault proxy unexpectedly returned an action receipt.');
    } catch (error) { result.lostReceipt = error.message; }
    await until(() => page.executeJavaScript('inputCount'), n => n === 1);
    check('uncertain input really executed once before crash', result.executedActionStatus === 200 && actionPosts === 1 && result.requests.filter(r => r.url.startsWith('/input-observed')).length === 1);
    const navigating = command('navigate', { id: a.id, url: base + '/slow' });
    await until(state, s => s.tabs.find(t => t.id === a.id)?.loading && pending.length > 0);
    await capture('navigation-pending');
    const gone = new Promise(resolve => page.once('render-process-gone', (_e, details) => resolve(details)));
    page.forcefullyCrashRenderer();
    result.crash = await gone;
    await until(state, s => /stopped|crash/i.test(s.tabs.find(t => t.id === a.id)?.error || ''));
    await sleep(100);
    const crashed = await state();
    result.crashed = crashed.tabs.find(t => t.id === a.id);
    result.chromiumAfterCrash = { loading: page.isLoading(), loadingMainFrame: page.isLoadingMainFrame(), crashed: page.isCrashed() };
    const recoveryUi = await shell.executeJavaScript('({status:document.getElementById("workspace-status").textContent,reload:document.getElementById("reload").getAttribute("aria-label")||document.getElementById("reload").title,reloadDisabled:document.getElementById("reload").disabled,bannerVisible:!!document.getElementById("browser-error-banner")?.offsetHeight,recoveryAction:document.getElementById("browser-error-reload")?.textContent})');
    check('renderer exit settles in-flight loading and keeps an actionable error', !result.crashed.loading && !!result.crashed.error && !recoveryUi.reloadDisabled && /reload/i.test(recoveryUi.reload), { tab: result.crashed, chromium: result.chromiumAfterCrash, ui: recoveryUi });
    check('failed tab has a named page-local recovery action', recoveryUi.bannerVisible && recoveryUi.recoveryAction === 'Reload page', recoveryUi);
    await capture('renderer-exited');
    releaseSlow = true;
    const dispatches = result.commands.filter(c => c.name === 'history').length;
    await click('reload');
    await until(state, s => !s.tabs.find(t => t.id === a.id)?.loading && !page.isCrashed());
    result.recovered = (await state()).tabs.find(t => t.id === a.id);
    await until(() => shell.executeJavaScript('!document.getElementById("workspace-status").textContent.includes("Loading") && !document.getElementById("browser-error-banner")?.offsetHeight'));
    check('reload recovers the interrupted destination once', result.recovered.url === base + '/slow' && !result.recovered.error && result.commands.filter(c => c.name === 'history').length === dispatches + 1, result.recovered);
    check('sibling live tab and draft unchanged', JSON.stringify(await other.executeJavaScript('({value:draft.value,count:inputCount,url:location.href})')) === JSON.stringify(otherBefore));
    check('conversation draft and selected owner unchanged', JSON.stringify(await conversation.executeJavaScript('({value:conversation.value,url:location.href})')) === JSON.stringify(conversationBefore) && (await state()).selectedBotId === before.selectedBotId);
    check('recovery UI settles with current URL and human control', await shell.executeJavaScript(`document.getElementById('address').value === ${JSON.stringify(base + '/slow')} && document.getElementById('control-button').textContent === 'Give to Cedar' && !document.getElementById('browser-error-banner')?.offsetHeight && !document.getElementById('workspace-status').textContent.includes('Loading')`));
    await capture('reload-recovered');
    for (const response of pending) response.destroy();
    await navigating;
    // Ancillary adversarial injections at the actual Electron event seam. The
    // decisive crash above is real; these model callbacks from a prior load.
    page.emit('did-fail-load', {}, -105, 'STALE_PRIOR_FAILURE', base + '/start', true);
    await sleep(30);
    check('late failure from prior URL cannot overwrite recovered page', !(await state()).tabs.find(t => t.id === a.id).error);
    await command('navigate', { id: a.id, url: base + '/one' });
    await command('navigate', { id: a.id, url: base + '/two' });
    await command('history', { id: a.id, action: 'back' });
    await until(state, s => s.tabs.find(t => t.id === a.id).url === base + '/one' && !s.tabs.find(t => t.id === a.id).loading);
    check('back reaches the real previous history entry', page.getURL() === base + '/one');
    await command('history', { id: a.id, action: 'forward' });
    await until(state, s => s.tabs.find(t => t.id === a.id).url === base + '/two' && !s.tabs.find(t => t.id === a.id).loading);
    check('forward reaches the real next history entry', page.getURL() === base + '/two');
    const old = command('navigate', { id: a.id, url: base + '/cancel-superseded' });
    await until(state, s => s.tabs.find(t => t.id === a.id).loading);
    await command('navigate', { id: a.id, url: base + '/latest' }); await old;
    check('superseded navigation cancellation is not an error', !(await state()).tabs.find(t => t.id === a.id).error && page.getURL() === base + '/latest');
    const stopped = command('navigate', { id: a.id, url: base + '/cancel-stop' });
    await until(() => result.requests.some(r => r.url === '/cancel-stop') && page.isLoadingMainFrame());
    page.emit('did-stop-loading', {}); page.emit('did-finish-load', {});
    page.emit('did-fail-load', {}, -105, 'STALE_DURING_NEW_LOAD', base + '/one', true);
    // Timing supplements only: the real stop below need not emit an abort.
    // A distinct obsolete abort must not settle the current held navigation.
    page.emit('did-fail-provisional-load', {}, -3, 'ERR_ABORTED', base + '/cancel-superseded', true);
    page.emit('did-fail-load', {}, -3, 'ERR_ABORTED', base + '/cancel-superseded', true);
    await sleep(30);
    const stillLoading = (await state()).tabs.find(t => t.id === a.id);
    check('old finish/failure cannot settle newer in-flight navigation', stillLoading.loading && !stillLoading.error && page.isLoadingMainFrame(), stillLoading);
    page.stop(); await stopped;
    await until(state, s => !s.tabs.find(t => t.id === a.id).loading);
    page.emit('did-fail-provisional-load', {}, -3, 'ERR_ABORTED', base + '/cancel-stop', true);
    page.emit('did-fail-load', {}, -3, 'ERR_ABORTED', base + '/cancel-stop', true);
    const canceled = (await state()).tabs.find(t => t.id === a.id);
    check('explicit navigation cancellation is not a load failure', !canceled.error, canceled);
    // Round 2 regression authored from the sealed critic's real stop/crash
    // failure, before changing main. This is WebContents.stop(), not a shell
    // Stop workflow. Exercise both actual UI handlers and two crash timings.
    for (const [control, timing] of [['reload', 'settled'], ['browser-error-reload', 'stop-callback']]) {
      const canceledUrl = base + '/cancel-round2-' + timing;
      const committed = page.getURL();
      const start = result.events.length;
      const nav = command('navigate', { id: a.id, url: canceledUrl });
      await until(() => result.requests.some(r => r.url === new URL(canceledUrl).pathname) && page.isLoadingMainFrame());
      const gone = new Promise(resolve => page.once('render-process-gone', (_event, details) => resolve(details)));
      if (timing === 'stop-callback') page.once('did-stop-loading', () => page.forcefullyCrashRenderer());
      page.stop();
      if (timing === 'settled') {
        await nav;
        await until(state, s => !s.tabs.find(t => t.id === a.id).loading);
        await sleep(100);
        page.forcefullyCrashRenderer();
      }
      await gone;
      await until(state, s => !!s.tabs.find(t => t.id === a.id).error);
      // Delayed abort supplement after real cancellation+crash: it must not
      // erase the truthful crash state or change its committed recovery URL.
      page.emit('did-fail-provisional-load', {}, -3, 'ERR_ABORTED', canceledUrl, true);
      page.emit('did-fail-load', {}, -3, 'ERR_ABORTED', canceledUrl, true);
      await sleep(80);
      const crashed = (await state()).tabs.find(t => t.id === a.id);
      const requestsBefore = result.requests.filter(r => r.url === new URL(canceledUrl).pathname).length;
      check('completed cancellation is not a crash destination: ' + timing,
        crashed.recoveryUrl === committed && !crashed.loading, { committed, canceledUrl, crashed, events: result.events.slice(start) });
      await click(control);
      // A broken implementation reopens the held canceled request. Observe it,
      // record the failure, then stop it so the remainder still gets exercised.
      await until(() => !page.isCrashed() && (!page.isLoading() || result.requests.filter(r => r.url === new URL(canceledUrl).pathname).length > requestsBefore));
      await sleep(100);
      const revived = result.requests.filter(r => r.url === new URL(canceledUrl).pathname).length;
      check('explicit ' + control + ' never revives canceled destination: ' + timing,
        page.getURL() === committed && revived === requestsBefore && !page.isLoading(), { committed, actual: page.getURL(), requestsBefore, requestsAfter: revived });
      if (page.isLoading()) { page.stop(); await sleep(80); }
      await nav;
      await command('navigate', { id: a.id, url: base + '/latest' });
    }
    await command('history', { id: a.id, action: 'reload' });
    await until(state, s => !s.tabs.find(t => t.id === a.id).loading);
    check('reload after cancellation stays on the committed page', page.getURL() === base + '/latest');
    await command('navigate', { id: a.id, url: base + '/failed' });
    await until(state, s => !!s.tabs.find(t => t.id === a.id).error);
    check('real main-frame network failure offers recovery', !(await state()).tabs.find(t => t.id === a.id).loading);
    acceptFailed = true;
    const recoveryDispatches = result.commands.filter(c => c.name === 'history').length;
    const hasRecoveryButton = await shell.executeJavaScript('!!document.getElementById("browser-error-reload")?.offsetHeight');
    await click(hasRecoveryButton ? 'browser-error-reload' : 'reload');
    await until(state, s => !s.tabs.find(t => t.id === a.id).loading && !s.tabs.find(t => t.id === a.id).error);
    check('explicit error recovery reaches intended failed URL once', page.getURL() === base + '/failed' && result.commands.filter(c => c.name === 'history').length === recoveryDispatches + 1);
    check('lost input receipt is never replayed by page recovery', actionPosts === 1 && result.requests.filter(r => r.url.startsWith('/input-observed')).length === 1 && await page.executeJavaScript('inputCount === 0 && draft.value === "Untouched local draft"'));
    check('sibling and conversation survive all recovery/history operations', JSON.stringify(await other.executeJavaScript('({value:draft.value,count:inputCount,url:location.href})')) === JSON.stringify(otherBefore)
      && JSON.stringify(await conversation.executeJavaScript('({value:conversation.value,url:location.href})')) === JSON.stringify(conversationBefore) && (await state()).selectedBotId === before.selectedBotId);
    result.actionPosts = actionPosts;
    save();
    assert.ok(result.checks.every(c => c.pass), JSON.stringify(result.checks.filter(c => !c.pass)));
    console.log('PASS actual renderer-crash recovery.');
  }).catch(error => { result.failure = { message: error.message, stack: error.stack }; save(); console.error('FAIL', error.stack); process.exitCode = 1; })
    .finally(() => {
      server?.closeAllConnections(); server?.close();
      proxy?.closeAllConnections(); proxy?.close();
      app.once('before-quit', () => { for (const wc of webContents.getAllWebContents()) if (!wc.isDestroyed()) { if (wc.debugger.isAttached()) wc.debugger.detach(); wc.destroy(); } });
      app.quit();
      if (process.exitCode) app.exit(process.exitCode);
      setTimeout(() => app.exit(process.exitCode || 0), 1000).unref();
    });
}
