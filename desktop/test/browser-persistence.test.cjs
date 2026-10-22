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
    } } }; }, restoreExpression() {}, savePreferences() {}, applyLayout() {}, broadcast() {},
  });
  vm.runInContext(section('async function handoffTab(', '\n// History navigation has no promise.'), context);
  await context.handoffTab({ id: 'remote-task', destination: 'mac' });
  assert.equal(created.owner, 'bot');
  assert.equal(created.controller, 'human', 'handoff review must still require human control');
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
  const context = vm.createContext({ app, isQuitting: false,
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

for (const driver of ['electron-updater', 'self']) {
  test(`${driver} waits for browser storage before exiting into the update`, async () => {
    const events = [], drains = [];
    const context = vm.createContext({
      updateDriver: driver, update: { tag: 'v1.0.1' }, isQuitting: false, path,
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
  const safeStorage = { isEncryptionAvailable: () => true, encryptString: text => { assert.ok(text.includes('fixture-session')); return Buffer.from('encrypted-fixture'); } };
  const context = vm.createContext({ prefs, session: { fromPartition: name => sessions.get(name) }, safeStorage, savePreferences() {}, persistSettingsPreferences() {},
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
    updateDriver: 'self', update: { tag: 'v1.0.1' }, path, process: { execPath: '/fixture/Workspace.app/Contents/MacOS/Workspace' },
    saveBrowserSession: async () => saved.push(page), app: { relaunch() {}, exit() {} },
    macUpdate: { installMacUpdate: async () => { page = 'after staging'; } },
  });
  vm.runInContext(section('async function restartIntoUpdate(', '\n// One "Update everything" step'), context);
  await context.restartIntoUpdate();
  assert.equal(saved.at(-1), 'after staging');
});
