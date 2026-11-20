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
  const context = vm.createContext({ createSignInGate, settleWithin, BROWSER_RESTORE_WAIT_MS: 30, logError: (name, error) => logged.push([name, error.message]),
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
  assert.match(create, /signInGate\.after\(\(\) => \{ if \(!view\.webContents\.isDestroyed\(\)\) view\.webContents\.loadURL\(targetUrl\)/, 'tab loads (restored tabs, API tabs, extension tabs, links) wait');
  assert.doesNotMatch(create.replace(/signInGate\.after\([^\n]*(?:\n|$)/, ''), /view\.webContents\.loadURL\(targetUrl\)/, 'no other load of the new tab');
  const window = section('function createWindow()', '\n  restoreBrowserTabs();');
  assert.match(window, /signInGate\.after\(\(\) => \{[^\n]*telegramView\.webContents\.loadURL\(/, 'the Telegram view waits');
  assert.doesNotMatch(window.replace(/signInGate\.after\([^\n]*(?:\n|$)/, ''), /telegramView\.webContents\.loadURL/, 'Telegram has no ungated first load');
  assert.match(source, /signInGate\.after\(startApi\);/, 'the local API (agent tab creation and navigation) does not listen before the gate opens');
  assert.doesNotMatch(source.replace('signInGate.after(startApi);', ''), /(?<!function )startApi\(\)/, 'nothing else starts the API');
  assert.match(section('async function openTelegramHash(', '\n}'), /^async function openTelegramHash\(hash\) \{\n  await signInGate\.ready\(\);/);
  assert.match(section("case 'navigate': {", "case 'history': {"), /await signInGate\.ready\(\);[^\n]*loadURL/, 'a navigation typed during the wait queues behind the first load');
  assert.match(source, /await Promise\.race\(\[\(async \(\) => \{ await signInGate\.ready\(\); await extensionStore\.installStore\(\)/, 'extensions load after the gate');
});
