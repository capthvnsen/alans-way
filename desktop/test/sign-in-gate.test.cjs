'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createSignInGate } = require('../src/sign-in-gate.cjs');
const { settleWithin } = require('../src/vps-browser.cjs');

const source = fs.readFileSync(require.resolve('../src/main.cjs'), 'utf8');
const section = (start, end) => {
  const from = source.indexOf(start), to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `Missing production section: ${start}`);
  return source.slice(from, to);
};
const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const gate = (capMs = 40, errors = []) => ({ gate: createSignInGate({ settleWithin, capMs, onError: error => errors.push(error) }), errors });

test('a load before any restore starts runs at once', () => {
  const { gate: g } = gate();
  assert.equal(g.after(() => 'loaded'), 'loaded');
});

test('loads wait for the restore and run, in arrival order, once it settles', async () => {
  const { gate: g } = gate(5000);
  const restore = deferred(), ran = [];
  g.start(() => restore.promise);
  g.after(() => ran.push('tab-1')); g.after(() => ran.push('telegram')); g.after(() => ran.push('tab-2'));
  await tick(10);
  assert.deepEqual(ran, [], 'nothing loads while sign-ins are still being restored');
  restore.resolve();
  await tick();
  assert.deepEqual(ran, ['tab-1', 'telegram', 'tab-2']);
  assert.equal(g.after(() => 'sync'), 'sync', 'once open, loads are synchronous again');
});

test('loads go ahead after the cap when the restore never settles, and the restore is left running', async () => {
  const { gate: g } = gate(30);
  const restore = deferred(), ran = [];
  g.start(() => restore.promise);
  g.after(() => ran.push('tab'));
  await tick(10);
  assert.deepEqual(ran, []);
  await tick(60);
  assert.deepEqual(ran, ['tab'], 'the cap opened the gate');
  restore.resolve();
});

test('a failed restore is reported once and does not hold loads back', async () => {
  const { gate: g, errors } = gate(5000);
  const failure = new Error('keychain denied'), ran = [];
  g.start(() => Promise.reject(failure));
  g.after(() => ran.push('tab'));
  await tick();
  assert.deepEqual(errors, [failure]);
  assert.deepEqual(ran, ['tab']);
});

test('a restore that throws synchronously is reported and opens the gate', async () => {
  const { gate: g, errors } = gate(5000);
  g.start(() => { throw new Error('boom'); });
  await g.ready();
  assert.equal(errors.length, 1);
});

test('a restore that fails after the cap is still reported', async () => {
  const { gate: g, errors } = gate(20);
  const restore = deferred();
  g.start(() => restore.promise);
  await g.ready();
  assert.equal(errors.length, 0);
  restore.reject(new Error('late'));
  await tick();
  assert.equal(errors.length, 1);
});

test('production gate uses the 5s cap and logs a failed restore as browser-restore', async () => {
  assert.match(source, /const BROWSER_RESTORE_WAIT_MS = 5000;/);
  const logged = [];
  const context = vm.createContext({ createSignInGate, settleWithin, BROWSER_RESTORE_WAIT_MS: 30, isQuitting: false, logError: (name, error) => logged.push([name, error.message]),
    createBrowserSessionStore: () => ({}), WebContentsView: {}, safeStorage: {}, persistSettingsPreferences() {}, bootTimer: { mark() {} } });
  vm.runInContext(section('const signInGate = createSignInGate(', '\nconst browserSessionStore ') + '\n;this.signInGate = signInGate;', context);
  context.signInGate.start(() => Promise.reject(new Error('secret-bearing detail')));
  await context.signInGate.ready();
  assert.deepEqual(logged, [['browser-restore', 'Saved browser sign-ins could not be restored.']], 'the log names the failure without the underlying detail');
  const hung = [];
  context.signInGate.start(() => new Promise(() => {}));
  context.signInGate.after(() => hung.push('tab'));
  await tick(80);
  assert.deepEqual(hung, ['tab']);
});

test('the window is created without awaiting the restore, which only starts first', () => {
  const boot = section('app.whenReady().then(async () => {', '\n    seedMacSshHost();');
  const start = boot.indexOf('signInGate.start('), window = boot.indexOf('createWindow();');
  assert.ok(start > 0 && window > start, 'the restore is started before the window is created');
  assert.doesNotMatch(boot.slice(start, window), /\bawait\b|\.then\(/, 'nothing between starting the restore and creating the window waits on it');
  assert.doesNotMatch(boot, /await[^\n]*browserSessionStore\.restore|settleWithin\(browserSessionStore/, 'the boot path never awaits the restore directly');
});

test('every page load that uses restored sign-ins goes through the gate', () => {
  const create = section('function createTab(', '\nfunction closeTab(');
  assert.match(create, /signInGate\.load\(view\.webContents, targetUrl, \{ alive: \(\) => tabs\.has\(tab\.id\) \}\)/, 'tab loads (restored tabs, API tabs, extension tabs, links) wait');
  assert.doesNotMatch(create.replace(/signInGate\.load\([^\n]*(?:\n|$)/, ''), /view\.webContents\.loadURL\(targetUrl\)/, 'no other load of the new tab');
  const window = section('function createWindow()', '\n  restoreBrowserTabs();');
  assert.match(window, /signInGate\.load\(telegramContents, /, 'the Telegram view waits');
  assert.doesNotMatch(window, /telegramView\.webContents\.loadURL|telegramContents\.loadURL/, 'Telegram has no ungated first load');
  assert.match(source, /signInGate\.after\(startApi\);/, 'the local API (agent tab creation and navigation) does not listen before the gate opens');
  assert.doesNotMatch(source.replace('signInGate.after(startApi);', ''), /(?<!function )startApi\(\)/, 'nothing else starts the API');
  assert.match(section('async function openTelegramHash(', '\n}'), /await signInGate\.load\(wc, target, \{ alive: \(\) => telegramView\?\.webContents === wc \}\);/, 'a chat opened during the wait replaces the first Telegram load');
  assert.match(section("case 'navigate': {", "case 'history': {"), /await signInGate\.load\(tab\.view\.webContents, target, /, 'a navigation typed during the wait replaces the first load');
  assert.match(source, /await Promise\.race\(\[\(async \(\) => \{ await signInGate\.ready\(\); if \(isQuitting\) return; await extensionStore\.installStore\(\)/, 'extensions load after the gate, unless quitting');
});

// The ordering failure seen in CI: a view's first load used to start synchronously, so a navigation made right after it
// (the integration suite's loadURL('about:blank')) won. Behind the gate the first load must not start later and abort it.
class View {
  constructor() { this.destroyed = false; this.loads = []; }
  isDestroyed() { return this.destroyed; }
  loadURL(url) { if (this.destroyed) throw new Error('Object has been destroyed'); this.loads.push(url); return Promise.resolve(); }
}
const unhandled = async run => {
  const seen = [], listener = error => seen.push(error);
  process.on('unhandledRejection', listener);
  try { await run(); await tick(20); } finally { process.off('unhandledRejection', listener); }
  assert.deepEqual(seen, [], 'no unhandled rejection');
};
const closed = (options = {}) => {
  const restore = deferred(), errors = [];
  const g = createSignInGate({ settleWithin, capMs: 5000, onError: () => {}, onTaskError: error => errors.push(error), ...options });
  g.start(() => restore.promise);
  return { g, restore, errors };
};

test('a navigation made while the first load waits wins; the first load is never issued', async () => {
  await unhandled(async () => {
    const { g, restore } = closed(), view = new View();
    const first = g.load(view, 'https://web.telegram.org/a/#123');
    const direct = view.loadURL('about:blank');
    restore.resolve(); await first; await direct;
    assert.deepEqual(view.loads, ['about:blank']);
    assert.equal(Object.hasOwn(view, 'loadURL'), false, 'the view is left as it was found');
  });
});

test('two navigations queued behind the gate issue one load: the last', async () => {
  const { g, restore } = closed(), view = new View(), done = [];
  g.load(view, 'https://one.example/').then(() => done.push('one'));
  g.load(view, 'https://two.example/').then(() => done.push('two'));
  await tick(5);
  assert.deepEqual(view.loads, []);
  restore.resolve(); await tick(5);
  assert.deepEqual(view.loads, ['https://two.example/']);
  assert.deepEqual(done.sort(), ['one', 'two'], 'both callers are released');
});

test('loads for different views do not replace each other and keep their order', async () => {
  const { g, restore } = closed(), a = new View(), b = new View();
  g.load(a, 'https://a.example/'); g.load(b, 'https://b.example/');
  restore.resolve(); await tick(5);
  assert.deepEqual([a.loads, b.loads], [['https://a.example/'], ['https://b.example/']]);
});

test('a view destroyed or a tab closed while waiting is not loaded, with no throw and no unhandled rejection', async () => {
  await unhandled(async () => {
    const { g, restore } = closed(), gone = new View(), closedTab = new View(), kept = new View();
    let tabOpen = true;
    g.load(gone, 'https://gone.example/'); g.load(closedTab, 'https://closed.example/', { alive: () => tabOpen }); g.load(kept, 'https://kept.example/');
    gone.destroyed = true; tabOpen = false;
    restore.resolve(); await tick(5);
    assert.deepEqual([gone.loads, closedTab.loads, kept.loads], [[], [], ['https://kept.example/']]);
  });
});

test('a load that fails or throws while issuing never rejects', async () => {
  await unhandled(async () => {
    const { g, restore, errors } = closed(), failing = new View(), throwing = new View();
    failing.loadURL = () => Promise.reject(new Error('ERR_ABORTED'));
    throwing.loadURL = () => { throw new Error('Object has been destroyed'); };
    const results = [g.load(failing, 'https://a.example/'), g.load(throwing, 'https://b.example/')];
    restore.resolve(); await Promise.all(results);
    assert.equal(errors.length, 1);
  });
});

test('quitting while loads and tasks wait drops them', async () => {
  await unhandled(async () => {
    let quitting = false;
    const { g, restore } = closed({ isQuitting: () => quitting }), view = new View(), api = [];
    const load = g.load(view, 'https://late.example/'); g.after(() => api.push('api'));
    quitting = true; restore.resolve(); await load; await tick(5);
    assert.deepEqual([view.loads, api], [[], []]);
  });
});

test('a queued task that throws is reported, not left as an unhandled rejection', async () => {
  await unhandled(async () => {
    const { g, restore, errors } = closed();
    g.after(() => { throw new Error('listen failed'); });
    restore.resolve(); await tick(5);
    assert.equal(errors.length, 1);
  });
});

test('once the gate is open loads start synchronously, as they did before the gate', async () => {
  const { g, restore } = closed(), view = new View();
  restore.resolve(); await g.ready();
  g.load(view, 'https://now.example/');
  assert.deepEqual(view.loads, ['https://now.example/']);
});

test('the url is read when the load starts, so a chat chosen during the wait is the one loaded', async () => {
  const { g, restore } = closed(), view = new View();
  let bot = '';
  g.load(view, () => `https://t.example/#${bot}`);
  bot = '456'; restore.resolve(); await tick(5);
  assert.deepEqual(view.loads, ['https://t.example/#456']);
});
