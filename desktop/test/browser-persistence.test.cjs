'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../src/main.cjs'), 'utf8');
function section(start, end) {
  const from = source.indexOf(start), to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `Missing production section: ${start}`);
  return source.slice(from, to);
}

function tab(id, url, extra = {}) {
  return { id, owner: 'user', botId: 'shared', controller: 'human', requestedUrl: url,
    view: { webContents: { getURL: () => url, isDestroyed: () => false } }, ...extra };
}
function snapshotFixture(entries, activeTabId) {
  const context = vm.createContext({ tabs: new Map(entries.map(item => [item.id, item])), activeTabId,
    prefs: {}, isQuitting: false, win: { isDestroyed: () => false }, NEWTAB_URL: 'file:///fixture/newtab.html',
    createSaver: options => ({ flush: options.snapshot }),
  });
  vm.runInContext(section('// Explicit changes save at once;', '\nfunction savePreferences()'), context);
  return JSON.parse(vm.runInContext('JSON.stringify(prefsSaver.flush())', context));
}

test('only user-created tabs survive a restart, even after task handback or user tab takeover', () => {
  const saved = snapshotFixture([
    tab('user', 'https://user.example/', { botId: 'bot-a', controller: 'agent' }),
    tab('task', 'https://task.example/', { owner: 'bot', botId: 'bot-a' }),
    tab('popup', 'https://popup.example/', { owner: 'bot', botId: 'bot-a' }),
    tab('second', 'https://second.example/'),
  ], 'second');
  assert.deepEqual(saved.savedTabs, [
    { url: 'https://user.example/', botId: 'bot-a', owner: 'user', active: false },
    { url: 'https://second.example/', botId: 'shared', owner: 'user', active: true },
  ]);
});

test('shutdown does not overwrite the saved user tabs when Chromium destroys its views', () => {
  const context = vm.createContext({ tabs: new Map(), activeTabId: 'home', isQuitting: true,
    prefs: { savedTabs: [{ url: 'https://user.example/', owner: 'user', active: true }] },
    win: { isDestroyed: () => false }, createSaver: options => ({ flush: options.snapshot }),
  });
  vm.runInContext(section('// Explicit changes save at once;', '\nfunction savePreferences()'), context);
  assert.equal(vm.runInContext('prefsSaver.flush().savedTabs.length', context), 1);
});

function restoreFixture(savedTabs) {
  const restored = [];
  const context = vm.createContext({ prefs: { savedTabs }, activeTabId: 'home',
    fileURLToPath: require('node:url').fileURLToPath,
    createTab: options => { const created = { ...options, id: `restored-${restored.length}` }; restored.push(created); return created; },
  });
  if (source.includes('function restoreBrowserTabs()')) {
    vm.runInContext(section('function restoreBrowserTabs()', '\nfunction createWindow()') + '\nrestoreBrowserTabs();', context);
  } else {
    vm.runInContext(section('  for (const item of prefs.savedTabs', '\n  pdfWindowReady = true;'), context);
  }
  return { restored, activeTabId: context.activeTabId, prefs: context.prefs };
}

test('restart restores every user tab in order and selects the saved active tab', () => {
  const saved = Array.from({ length: 14 }, (_, i) => ({ url: `https://user.example/${i}`, owner: 'user', botId: 'bot-a', active: i === 12 }));
  saved.splice(4, 0, { url: 'https://task.example/', owner: 'bot', botId: 'bot-a' });
  saved.push({ url: 'about:blank', owner: 'user' });
  const result = restoreFixture(saved);
  assert.deepEqual(result.restored.map(item => item.url), [...Array.from({ length: 14 }, (_, i) => `https://user.example/${i}`), 'about:blank']);
  assert.equal(result.activeTabId, 'restored-12');
  assert.ok(result.restored.every(item => item.controller !== 'agent' && item.activate === false));
});

test('legacy bot task tabs do not return as user tabs; legacy shared tabs still restore', () => {
  const result = restoreFixture([{ url: 'https://task.example/', botId: 'bot-a' },
    { url: 'https://user.example/', botId: 'shared' }, { url: '' }, { url: 'about:blank' }]);
  assert.deepEqual(result.restored.map(item => item.url), ['https://user.example/']);
  assert.equal(result.prefs.legacySavedTabs?.[0]?.url, 'https://task.example/', 'keep ambiguous old entries for recovery instead of erasing them');
});

test('new tabs are portable across app paths and interrupted user navigation keeps its destination', () => {
  const saved = snapshotFixture([
    tab('blank', 'file:///fixture/newtab.html'),
    tab('moving', 'https://previous.example/', { navigationUrl: 'https://destination.example/' }),
    tab('pending', 'about:blank', { requestedUrl: 'https://pending.example/' }),
    tab('popup', '', { requestedUrl: '' }),
  ], 'blank');
  assert.deepEqual(saved.savedTabs.map(item => item.url), ['about:blank', 'https://destination.example/', 'https://pending.example/']);
});

test('a popup opened while a bot controls a user tab is attributed to that bot task', () => {
  const { EventEmitter } = require('node:events');
  const contents = new EventEmitter(); contents.session = new EventEmitter();
  let handler, created;
  contents.setWindowOpenHandler = fn => { handler = fn; };
  const parent = tab('user', 'https://user.example/', { controller: 'agent', botId: 'bot-a' });
  parent.view.webContents = contents;
  const context = vm.createContext({ tabs: new Map([['user', parent]]), prefs: {},
    isExtensionUrl: () => false, agentPageUrl: value => value, normalizeUrl: value => value,
    configuredSessions: new WeakSet(), sitePermissions: { install() {} }, downloadStore: { install() {} },
    createTab: options => { created = options; return { id: 'popup', view: { webContents: {} } }; },
  });
  vm.runInContext(section('function configureContents(', '\n// A download an agent tab starts'), context);
  context.configureContents(contents);
  handler({ url: 'https://popup.example/', disposition: 'new-window' }).createWindow({});
  assert.equal(created.owner, 'bot');
  assert.equal(created.botId, 'bot-a');
  assert.equal(created.activate, false);
  assert.equal(created.controller, 'agent');
});

test('a task handed back from the remote browser does not become a restorable user tab', async () => {
  let created;
  const context = vm.createContext({ tabs: new Map(), vpsTabs: new Map([['remote-task', { id: 'remote-task', botId: 'bot-a' }]]),
    HOST_LABEL: 'mac', crypto: { randomUUID: () => 'handoff-fixture' }, prefs: { handoffs: [] },
    remoteRequest: async (_id, action) => action === 'checkpoint' ? { url: 'https://task.example/' } : {},
    createTab: options => { created = options; return { id: 'local-task', view: { webContents: {
      isLoading: () => false, getURL: () => options.url, executeJavaScript: async () => ({ verification: {}, restored: [], skipped: [] }),
    } } }; }, restoreExpression() {}, savePreferences() {}, applyLayout() {}, broadcast() {}, signInsTravel: async () => false,
  });
  vm.runInContext(section('const handoffRequests =', '\n// History navigation has no promise.'), context);
  await context.handoffTab({ id: 'remote-task', destination: 'mac' });
  assert.equal(created.owner, 'bot');
  assert.equal(created.controller, 'human', 'handoff review must still require human control');
});

test('Move to VM and back carries the page’s sign-in, set before the destination loads', async () => {
  const { toCdpCookie, toElectronCookies } = require('../src/vps-browser.cjs');
  const events = [], requests = [];
  const vmCookie = { name: 'sid', value: 'from-vm', domain: '.task.example', path: '/', expires: -1, httpOnly: true, secure: true, session: true, sameSite: 'Lax' };
  const page = (url) => ({ isLoading: () => false, getURL: () => url, isDestroyed: () => false,
    executeJavaScript: async (code) => String(code).includes('drafts.push') ? { url, title: 'Task', scroll: { x: 0, y: 0 }, drafts: [] } : { verification: 'ready', restored: 0, skipped: 0 } });
  const macTab = { id: 'mac-task', botId: 'bot-a', controller: 'agent', owner: 'bot', queue: Promise.resolve(), view: { webContents: page('https://task.example/deal') } };
  const context = vm.createContext({ tabs: new Map([['mac-task', macTab]]), vpsTabs: new Map([['vm-task', { id: 'vm-task', botId: 'bot-a', controller: 'agent' }]]),
    HOST_LABEL: 'mac', crypto: { randomUUID: () => 'handoff-fixture' }, prefs: { handoffs: [] },
    changeController: (id, controller) => { context.tabs.get(id).controller = controller; },
    pageCookies: async (url) => [toCdpCookie({ name: 'sid', value: 'from-mac', domain: 'task.example', path: '/', secure: true, httpOnly: true, session: true })].filter(() => url.startsWith('https://task.example/')),
    vpsBrowser: { request: async (route, method, body) => { requests.push([route, body]); return { id: 'vm-new', signIns: body.cookies?.length || 0 }; } },
    remoteRequest: async (id, action, body) => { requests.push([`${id}/${action}`, body]); return action === 'checkpoint' ? { url: 'https://task.example/deal', title: 'Task', scroll: { x: 0, y: 0 }, drafts: [], cookies: [vmCookie, { ...vmCookie, name: 'ad', domain: '.ads.example' }] } : action === 'restore' ? { verification: 'ready', restored: 0, skipped: 0, tab: { id: 'vm-new' } } : {}; },
    session: { fromPartition: () => ({ cookies: { set: async (cookie) => { events.push(['cookie', cookie.name, cookie.value]); } } }) },
    toElectronCookies,
    createTab: (options) => { events.push(['open', options.url]); return { id: 'mac-back', view: { webContents: page(options.url) } }; },
    restoreExpression() {}, checkpointExpression: require('../src/browser-page.cjs').checkpointExpression, savePreferences() {}, applyLayout() {}, broadcast() {}, signInsTravel: async () => true,
  });
  vm.runInContext(section('const handoffRequests =', '\n// History navigation has no promise.'), context);
  const out = await context.handoffTab({ id: 'mac-task', destination: 'vps' });
  const open = requests.find(([route]) => route === '/v1/tabs')[1];
  assert.equal(open.url, 'https://task.example/deal');
  assert.equal(JSON.stringify(open.cookies.map((c) => c.value)), '["from-mac"]', 'the Mac sign-in rides on the VM tab open');
  assert.equal(out.signIns, 1);
  assert.equal(macTab.handoff.phase, 'handed_off', 'the Mac copy retires');
  assert.ok(!requests.some(([route, body]) => route === 'vm-new/restore' && JSON.stringify(body).includes('from-mac')), 'cookies never ride in the restore checkpoint');
  const back = await context.handoffTab({ id: 'vm-task', destination: 'mac' });
  assert.deepEqual({ ...requests.find(([route]) => route === 'vm-task/checkpoint')[1] }, { includeDrafts: false, includeCookies: true });
  assert.equal(JSON.stringify(events), JSON.stringify([['cookie', 'sid', 'from-vm'], ['open', 'https://task.example/deal']]), 'only the page’s own sign-in, before the page loads');
  assert.equal(back.signIns, 1);
});

test('without consent or a tailnet path a Move carries no sign-ins, and a failed Move gives the tab back', async () => {
  const requests = [];
  const macTab = { id: 'mac-task', botId: 'bot-a', controller: 'agent', owner: 'bot', queue: Promise.resolve(), view: { webContents: { executeJavaScript: async () => ({ url: 'https://task.example/', drafts: [], scroll: { x: 0, y: 0 } }) } } };
  let fail = false;
  const context = vm.createContext({ tabs: new Map([['mac-task', macTab]]), vpsTabs: new Map(), HOST_LABEL: 'mac', crypto: { randomUUID: () => 'h' }, prefs: { handoffs: [] },
    changeController: (id, controller) => { macTab.controller = controller; },
    pageCookies: async () => { throw new Error('cookies must not be read'); },
    vpsBrowser: { request: async (route, method, body) => { if (fail) throw new Error('VPS browser SSH unavailable.'); requests.push(body); return { id: 'vm-new' }; } },
    remoteRequest: async () => ({ verification: 'ready', restored: 0, skipped: 0, tab: { id: 'vm-new' } }),
    restoreExpression() {}, checkpointExpression: require('../src/browser-page.cjs').checkpointExpression, savePreferences() {}, applyLayout() {}, broadcast() {}, signInsTravel: async () => false,
  });
  vm.runInContext(section('const handoffRequests =', '\n// History navigation has no promise.'), context);
  fail = true;
  await assert.rejects(context.handoffTab({ id: 'mac-task', destination: 'vps' }), /SSH unavailable/);
  assert.equal(macTab.controller, 'agent', 'the agent keeps its tab when the VM side never opened');
  fail = false;
  const out = await context.handoffTab({ id: 'mac-task', destination: 'vps' });
  assert.equal(requests[0].cookies, undefined);
  assert.equal(out.signIns, 0);
  assert.equal(out.signInsCarried, false);
});

test('clicking a chat link already auto-opened by that message does not create another tab', () => {
  const { EventEmitter } = require('node:events');
  const contents = new EventEmitter(); contents.session = new EventEmitter();
  contents.setWindowOpenHandler = () => {};
  let created = 0, prevented = 0;
  const url = 'https://task.example/';
  const context = vm.createContext({ tabs: new Map([['existing', tab('existing', url, { owner: 'bot', botId: 'bot-a' })]]),
    prefs: {}, activeTabId: 'home', TELEGRAM: 'https://web.telegram.org/a/',
    recentLinkTabs: new Map([[url, { tabId: 'existing', at: Date.now() }]]),
    normalizeUrl: value => value, isExtensionUrl: () => false,
    configuredSessions: new WeakSet(), sitePermissions: { install() {} }, downloadStore: { install() {} },
    broadcast() {}, applyLayout() {}, createTab: () => { created++; return { id: 'duplicate' }; },
  });
  const start = source.includes('function openTelegramLink(') ? 'function openTelegramLink(' : 'function configureContents(';
  vm.runInContext(section(start, '\n// A download an agent tab starts'), context);
  context.configureContents(contents, true);
  contents.emit('will-navigate', { preventDefault: () => { prevented++; } }, url);
  assert.equal(prevented, 1);
  assert.equal(created, 0);
  assert.equal(context.activeTabId, 'existing');
});

test('a chat link notification arriving after the human clicked reuses the existing tab without taking control', () => {
  let notify, created = 0;
  const url = 'https://task.example/', frame = {};
  const contents = { mainFrame: frame, getURL: () => 'https://web.telegram.org/a/' };
  const existing = tab('clicked', url, { botId: 'bot-a', epoch: 7 });
  const context = vm.createContext({ telegramView: { webContents: contents }, TELEGRAM: 'https://web.telegram.org/a/',
    prefs: { bots: [{ id: 'bot-a' }] }, tabs: new Map([['clicked', existing]]),
    recentLinkTabs: new Map([[url, { tabId: 'clicked', at: Date.now() }]]),
    ipcMain: { on: (_name, fn) => { notify = fn; } }, agentPageUrl: value => value,
    createTab: () => { created++; return { id: 'duplicate' }; },
  });
  vm.runInContext(section('  const linkOpenedAt = new Map();', '\n}\n\nconst intParam'), context);
  notify({ sender: contents, senderFrame: frame }, { chatId: 'bot-a', url, outgoing: false });
  assert.equal(created, 0);
  assert.equal(existing.controller, 'human');
  assert.equal(existing.epoch, 7);
});

test('ordinary quit keeps views alive until cookies are durable, and a repeated quit shares the drain', async () => {
  let listener, finish, saves = 0, closes = 0;
  const app = { on: (_name, fn) => { listener = fn; }, quit: () => listener({ preventDefault() {} }) };
  const context = vm.createContext({ app, isQuitting: false, setTimeout() {}, QUIT_SAVE_MS: 8000, logError: (_label, error) => { throw error; },
    savePreferences() {}, saveBrowserSession: () => { saves++; return new Promise(resolve => { finish = resolve; }); },
    hostComputer: { close: () => { closes++; } }, prefsSaver: { flush() {} },
    modelAuthChild: null, tray: null, apiServer: null, clearInterval() {}, clearTimeout() {},
    pointerTimer: 0, activityTimer: 0, idleTimer: 0, captchaTimer: 0, vpsTimer: 0, vpsMirrorTimer: 0, vpsMirrorDebounce: 0,
  });
  const start = source.includes('  let browserQuitPending') ? '  let browserQuitPending' : "  app.on('before-quit',";
  vm.runInContext(section(start, "  app.on('window-all-closed'"), context);
  let prevented = 0;
  listener({ preventDefault: () => { prevented++; } });
  listener({ preventDefault: () => { prevented++; } });
  assert.equal(prevented, 2, 'quit must wait for storage');
  assert.equal(saves, 1);
  assert.equal(closes, 0, 'keep browser services alive while saving');
  finish();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closes, 1);
  assert.equal(context.isQuitting, true);
});

for (const outcome of ['hangs', 'fails']) {
  test(`quit still exits when saving browser sign-ins ${outcome}`, async () => {
    // A keychain prompt nobody answers, or a denied one, must not keep the app from quitting.
    let listener, closes = 0;
    const timers = [], errors = [];
    const app = { on: (_name, fn) => { listener = fn; }, quit: () => listener({ preventDefault() {} }) };
    const context = vm.createContext({ app, isQuitting: false, setTimeout: (fn, ms) => timers.push({ fn, ms }), QUIT_SAVE_MS: 8000,
      savePreferences() {}, saveBrowserSession: () => (outcome === 'hangs' ? new Promise(() => {}) : Promise.reject(new Error('denied'))),
      logError: (label, error) => errors.push(`${label}: ${error.message}`),
      hostComputer: { close: () => { closes++; } }, prefsSaver: { flush() {} },
      modelAuthChild: null, tray: null, apiServer: null, clearInterval() {}, clearTimeout() {},
      pointerTimer: 0, activityTimer: 0, idleTimer: 0, captchaTimer: 0, vpsTimer: 0, vpsMirrorTimer: 0, vpsMirrorDebounce: 0,
    });
    vm.runInContext(section('  let browserQuitPending', "  app.on('window-all-closed'"), context);
    listener({ preventDefault() {} });
    await new Promise(resolve => setImmediate(resolve));
    if (outcome === 'hangs') {
      assert.equal(closes, 0, 'a save in progress gets its time');
      assert.ok(timers.length === 1 && timers[0].ms <= 10000);
      timers[0].fn();
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.equal(closes, 1);
    assert.equal(errors.length, 1);
  });
}

for (const driver of ['electron-updater', 'self']) {
  test(`${driver} waits for browser storage before exiting into the update`, async () => {
    const events = [], drains = [];
    const context = vm.createContext({
      stagedAppVersion: () => '1.0.1', updateDriver: driver, update: { tag: 'v1.0.1' }, isQuitting: false, path,
      process: { execPath: '/fixture/Workspace.app/Contents/MacOS/Workspace' },
      savePreferences: () => events.push('tabs'),
      browserSessionStore: { save: async () => {} },
      session: { fromPartition: partition => ({
        flushStorageData: () => events.push(`storage:${partition}`),
        cookies: { flushStore: () => new Promise(resolve => drains.push(resolve)) },
      }) },
      macUpdate: { installMacUpdate: async () => events.push('install') },
      mainLog: () => ({ write() {} }), armQuitWatchdog() {},
      require: name => { assert.equal(name, 'electron-updater'); return { autoUpdater: { quitAndInstall: () => events.push('install') } }; },
      app: { relaunch: () => events.push('relaunch'), exit: () => events.push('exit') },
    });
    // Include the shared shutdown helper when it exists, exercising the old
    // update path on RED rather than failing because a new symbol is absent.
    const helper = source.indexOf('async function saveBrowserSession(');
    if (helper >= 0) vm.runInContext(source.slice(helper, source.indexOf('\n// One "Update everything" step', helper)), context);
    else vm.runInContext(section('async function restartIntoUpdate(', '\n// One "Update everything" step'), context);
    const updating = context.restartIntoUpdate();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(events.includes('exit'), false, 'exit must wait for cookie writes');
    if (driver === 'electron-updater') assert.equal(events.includes('install'), false);
    assert.deepEqual(events.filter(value => value !== 'install'), ['tabs', 'storage:persist:browser', 'storage:persist:telegram']);
    drains.forEach(resolve => resolve());
    await updating;
    assert.ok(events.includes('install'));
  });
}

test('shutdown retains session-only sign-ins in encrypted form without changing their expiry', async () => {
  const prefs = {}, cookies = [{ name: 'fixture-session', value: 'fixture-only', domain: 'signin.example', path: '/',
    hostOnly: true, session: true, secure: true, httpOnly: true, sameSite: 'lax' }];
  const sessions = new Map(['persist:browser', 'persist:telegram'].map(partition => [partition, {
    cookies: { get: async filter => { assert.deepEqual({ ...filter }, { session: true }); return cookies; }, flushStore: async () => {} },
    flushStorageData() {},
  }]));
  const safeStorage = { isAsyncEncryptionAvailable: async () => true, getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptStringAsync: async text => { assert.ok(text.includes('fixture-session')); return Buffer.from('encrypted-fixture'); } };
  const context = vm.createContext({ prefs, session: { fromPartition: name => sessions.get(name) }, safeStorage, savePreferences() {}, persistSettingsPreferences() {},
    WebContentsView: class { constructor() { this.webContents = { destroy() {}, debugger: { attach() {}, sendCommand: async () => ({ cookies }) } }; } },
    createBrowserSessionStore: require('node:fs').existsSync(path.join(__dirname, '../src/browser-session.cjs')) ? require('../src/browser-session.cjs').createBrowserSessionStore : undefined,
    process: { platform: 'darwin' }, Buffer,
  });
  if (source.includes('const browserSessionStore =')) vm.runInContext(section('const browserSessionStore =', '\nasync function saveBrowserSession('), context);
  vm.runInContext(section('async function saveBrowserSession(', '\nasync function restartIntoUpdate('), context);
  await context.saveBrowserSession();
  assert.equal(prefs.sessionCookies, Buffer.from('encrypted-fixture').toString('base64'));
  assert.equal(cookies[0].session, true);
  assert.equal(cookies[0].expirationDate, undefined);
});

test('Mac self-update snapshots work done while the new bundle is being staged', async () => {
  let page = 'before staging';
  const saved = [];
  const context = vm.createContext({
    stagedAppVersion: () => '1.0.1', updateDriver: 'self', update: { tag: 'v1.0.1' }, path, process: { execPath: '/fixture/Workspace.app/Contents/MacOS/Workspace' },
    saveBrowserSession: async () => saved.push(page), app: { relaunch() {}, exit() {} },
    macUpdate: { installMacUpdate: async () => { page = 'after staging'; } },
  });
  vm.runInContext(section('async function restartIntoUpdate(', '\n// One "Update everything" step'), context);
  await context.restartIntoUpdate();
  assert.equal(saved.at(-1), 'after staging');
});

test('on wake the app retires each local tab the VM resumed, once, and tells the human', async () => {
  const { continuedOnVm, requireAgentClaim } = require('../src/core.cjs');
  const tabs = new Map([['mac-1', { id: 'mac-1', botId: 'bot-a', controller: 'agent' }], ['mac-2', { id: 'mac-2', botId: 'bot-b', controller: 'agent' }], ['mac-3', { id: 'mac-3', botId: 'bot-a', controller: 'human' }]]);
  let saved = 0;
  const context = vm.createContext({ tabs, prefs: { handoffs: [] }, continuedOnVm, Date, Object,
    vpsBrowser: { request: async (route) => { assert.equal(route, '/v1/mirror/continued'); return { bots: { 'bot-a': { 'mac-1': 'vm-1', 'mac-3': 'vm-3', 'gone': 'vm-x' }, 'bot-c': { 'mac-2': 'vm-2' } } }; } },
    changeController: (id, controller) => { tabs.get(id).controller = controller; }, savePreferences: () => { saved++; }, broadcast() {} });
  vm.runInContext(section('let continuedCheckDue = true', '\nconst pushVpsMirror') + ';this.notice = () => continuedNotice;', context);
  await context.retireContinuedTabs();
  assert.equal(tabs.get('mac-1').controller, 'human');
  assert.throws(() => requireAgentClaim(tabs.get('mac-1'), Date.now(), { autoTakeover: true }), /handoff_source: this task moved to the vps tab vm-1/);
  assert.equal(tabs.get('mac-2').controller, 'agent', 'a map entry for another bot never retires this bot’s tab');
  assert.equal(tabs.get('mac-3').handoff, undefined, 'a tab the human holds is left alone');
  assert.equal(context.notice().count, 1);
  assert.equal(saved, 1);
  await context.retireContinuedTabs();
  assert.equal(context.prefs.handoffs.length, 1, 'a second check retires nothing new');
});
