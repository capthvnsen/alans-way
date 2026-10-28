const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

const source = fs.readFileSync(path.join(__dirname, '../src/remote.js'), 'utf8');
const url = 'https://192.0.2.1/viewer/';

function viewer(random = 0.5) {
  const clients = [], calls = [], timers = new Map(), elements = new Map();
  const listeners = {};
  let pixels = [0, 0, 0, 255];
  const canvas = { width: 1, height: 1, getContext: () => ({ getImageData: () => ({ data: pixels }) }) };
  let timerId = 0;
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      textContent: '', classList: { add() {}, remove() {}, toggle() {} },
      focus() {}, setAttribute() {},
      querySelector: () => canvas,
    });
    return elements.get(id);
  };
  class RFB {
    constructor(screen, socketUrl) { this.url = socketUrl; this.listeners = {}; clients.push(this); }
    addEventListener(name, listener) { this.listeners[name] = listener; }
    emit(name, detail = {}) { this.listeners[name]({ detail }); }
    disconnect() { this.emit('disconnect', { clean: true }); }
    sendCredentials(value) { this.credentials = value; }
    blur() {}
  }
  const context = {
    RFB, URL, Math: Object.assign(Object.create(Math), { random: () => random }),
    window: {
      addEventListener: (name, callback) => { listeners[name] = callback; },
      workspace: {
        command: async (name, value) => { calls.push({ name, ...value }); },
        onRemoteRetry: callback => { listeners.resume = callback; },
        onState() {}, getState: () => new Promise(() => {}),
      },
    },
    document: { getElementById: element, hidden: false, addEventListener: (name, callback) => { listeners[name] = callback; } },
    setTimeout: (callback, delay) => { timers.set(++timerId, { callback, delay }); return timerId; },
    clearTimeout: id => timers.delete(id),
  };
  vm.runInNewContext(source.slice(source.indexOf('const api =')), context);
  return {
    clients, calls, timers, element, connect: context.connect, render: context.render,
    event: (name, hidden = false) => { context.document.hidden = hidden; listeners[name](); },
    paint: data => { pixels = data; },
    current: () => clients.at(-1),
    status: () => calls.filter(call => call.name === 'remote-status').at(-1)?.status,
    retry: delay => {
      assert.equal(timers.size, 1, 'exactly one retry must be pending');
      const [id, timer] = timers.entries().next().value;
      assert.equal(timer.delay, delay);
      timers.delete(id); timer.callback();
    },
  };
}

test('unclean disconnect keeps retrying with exponential backoff capped at 30s', () => {
  const view = viewer();
  view.connect(url);
  for (const delay of [2000, 4000, 8000, 16000, ...Array(40).fill(30000)]) {
    view.current().emit('disconnect', { clean: false });
    assert.equal(view.status(), 'reconnecting');
    assert.equal(view.calls.filter(call => call.name === 'remote-control').at(-1).enabled, false);
    assert.equal(view.element('remote-title').textContent, 'Reconnecting…');
    assert.match(view.element('remote-message').textContent, /Next attempt at .+\./);
    view.retry(delay);
    assert.equal(view.current().url, 'wss://192.0.2.1/viewer/websockify');
  }
  assert.equal(view.clients.length, 45);
});

test('retry delays have jitter and never exceed the cap', () => {
  for (const random of [0, 0.25, 0.75, 1]) {
    const view = viewer(random);
    view.connect(url);
    for (const base of [2000, 4000, 8000, 16000, 30000, 30000]) {
      view.current().emit('disconnect', { clean: false });
      view.retry(Math.round(Math.min(30000, base * (0.8 + random * 0.4))));
    }
  }
});

for (const event of ['online', 'visibilitychange', 'focus', 'resume']) {
  test(`${event} retries immediately once, without interrupting a connection attempt`, () => {
    const view = viewer();
    view.connect(url); view.event(event);
    assert.equal(view.clients.length, 1);
    view.current().emit('disconnect', { clean: false });
    const pending = [...view.timers.values()][0];
    if (event === 'visibilitychange') {
      view.event(event, true);
      assert.equal(view.clients.length, 1, 'hiding does not retry');
    }
    view.event(event);
    assert.equal(view.clients.length, 2);
    assert.deepEqual([...view.timers.values()].map(timer => timer.delay), [15000], 'only the new handshake deadline remains');
    pending.callback(); view.event(event);
    assert.equal(view.clients.length, 2, 'queued callbacks and duplicate signals do not reconnect again');
    view.current().emit('connect'); view.event(event);
    assert.equal(view.clients.length, 2, 'a healthy connection stays open');
    view.current().emit('disconnect', { clean: false }); view.retry(2000);
  });
}

function recoveryEvents(view) {
  for (const event of ['online', 'visibilitychange', 'focus', 'resume']) view.event(event);
}

test('a handshake stalled across sleep or a Tailscale drop is replaced after 15s', () => {
  const view = viewer();
  view.connect(url);
  const old = view.current();
  recoveryEvents(view);
  assert.equal(view.clients.length, 1, 'recovery signals do not interrupt an active handshake');
  view.retry(15000);
  assert.equal(view.clients.length, 2, 'a silent handshake cannot wedge the viewer forever');
  old.emit('connect'); old.emit('disconnect', { clean: false });
  assert.equal(view.status(), 'connecting', 'late old socket events are fenced out');
  view.current().emit('connect'); view.retry(2000);
  assert.equal(view.status(), 'connected');
});

test('a queued handshake timeout cannot replace a connected or authenticated viewer', () => {
  for (const event of ['connect', 'credentialsrequired', 'securityfailure']) {
    const view = viewer(); view.connect(url);
    const timeout = [...view.timers.values()].find(timer => timer.delay === 15000);
    assert.ok(timeout, 'connection attempts have a deadline');
    view.current().emit(event); timeout.callback();
    assert.equal(view.clients.length, 1, event);
  }
});

test('a successful connection resets the retry counter', () => {
  const view = viewer();
  view.connect(url);
  for (const delay of [2000, 4000, 8000]) {
    view.current().emit('disconnect', { clean: false }); view.retry(delay);
  }
  view.current().emit('connect');
  assert.equal(view.status(), 'connected');
  view.current().emit('disconnect', { clean: false }); view.retry(2000);
});

test('a clean disconnect never retries', () => {
  const view = viewer();
  view.connect(url); view.current().emit('disconnect', { clean: true });
  assert.equal(view.timers.size, 0);
  assert.equal(view.status(), 'disconnected');
  recoveryEvents(view);
  assert.equal(view.clients.length, 1);
});

for (const event of ['securityfailure', 'credentialsrequired']) {
  test(`${event} prevents retries after an unclean disconnect`, () => {
    const view = viewer();
    view.connect(url); view.current().emit(event);
    view.current().emit('disconnect', { clean: false });
    assert.equal(view.timers.size, 0);
    recoveryEvents(view);
    assert.equal(view.clients.length, 1);
  });

  test(`${event} cancels a pending retry`, () => {
    const view = viewer();
    view.connect(url); view.current().emit('disconnect', { clean: false });
    assert.equal(view.timers.size, 1);
    const pending = [...view.timers.values()][0];
    view.current().emit(event);
    assert.equal(view.timers.size, 0);
    pending.callback();
    assert.equal(view.clients.length, 1, 'an already queued callback must also respect the rejection');
  });
}

test('changing or clearing the URL cancels retries and ignores stale events and callbacks', () => {
  for (const nextUrl of ['https://203.0.113.1/viewer/', '']) {
    const view = viewer();
    view.connect(url);
    const old = view.current();
    old.emit('disconnect', { clean: false });
    assert.equal(view.timers.size, 1);
    const pending = [...view.timers.values()][0];
    view.connect(nextUrl);
    assert.equal(view.timers.size, nextUrl ? 1 : 0, 'only a new URL gets a new handshake deadline');
    const count = view.clients.length, status = view.status();
    pending.callback();
    old.emit('disconnect', { clean: false }); old.emit('connect'); old.emit('securityfailure'); old.emit('credentialsrequired');
    recoveryEvents(view);
    assert.equal(view.clients.length, count);
    assert.equal(view.timers.size, nextUrl ? 1 : 0);
    assert.equal(view.status(), status);
    if (nextUrl) { view.current().emit('disconnect', { clean: false }); view.retry(2000); }
  }
});

test('the Reconnect button tries now and resets backoff', () => {
  const view = viewer();
  view.connect(url);
  for (const delay of [2000, 4000, 8000]) {
    view.current().emit('disconnect', { clean: false }); view.retry(delay);
  }
  view.current().emit('disconnect', { clean: false });
  const pending = [...view.timers.values()][0];
  view.element('configure').onclick();
  assert.equal(view.clients.length, 5);
  assert.deepEqual([...view.timers.values()].map(timer => timer.delay), [15000]);
  pending.callback();
  assert.equal(view.clients.length, 5);
  view.current().emit('disconnect', { clean: false }); view.retry(2000);
});

test('saving viewer settings restarts cleanly even when the URL is unchanged', () => {
  const view = viewer();
  const settings = { remoteUrl: url, remoteControl: false, settingsFieldRevisions: { remoteUrl: 0 } };
  view.render(settings);
  const old = view.current();
  old.emit('securityfailure');
  view.render({ ...settings, settingsFieldRevisions: { remoteUrl: 1 } });
  assert.equal(view.clients.length, 2);
  old.emit('disconnect', { clean: false });
  recoveryEvents(view);
  assert.equal(view.clients.length, 2);
  view.current().emit('disconnect', { clean: false }); view.retry(2000);
});

test('saving other addresses leaves a healthy desktop connection alone', () => {
  const view = viewer();
  const settings = { remoteUrl: url, remoteControl: false, settingsFieldRevisions: { remoteUrl: 0 } };
  view.render(settings);
  view.current().emit('connect');
  view.render({ ...settings, settingsFieldRevisions: { remoteUrl: 1 } });
  assert.equal(view.clients.length, 1);
});

test('submitting credentials keeps the prompt flow and successful authentication restores retries', () => {
  const view = viewer();
  view.connect(url); view.current().emit('credentialsrequired');
  view.element('vnc-password').value = 'test-password';
  view.element('credentials').onsubmit({ preventDefault() {} });
  assert.equal(view.current().credentials.password, 'test-password');
  assert.equal(view.element('vnc-password').value, '');
  recoveryEvents(view);
  assert.equal(view.clients.length, 1);
  view.current().emit('connect');
  view.current().emit('disconnect', { clean: false }); view.retry(2000);
});

test('a successful connection cancels a pending retry', () => {
  const view = viewer();
  view.connect(url); view.current().emit('disconnect', { clean: false });
  assert.equal(view.timers.size, 1);
  view.current().emit('connect');
  assert.equal(view.status(), 'connected');
  view.retry(2000);
  assert.equal(view.timers.size, 0);
  assert.equal(view.status(), 'connected');
});

test('a connected viewer without a painted frame reconnects once, without replay or control changes', () => {
  const view = viewer();
  view.paint([0, 0, 0, 0]);
  view.render({ remoteUrl: url, remoteControl: true });
  view.current().emit('connect');
  view.retry(2000);
  assert.equal(view.clients.length, 2, 'a blank connection gets a fresh viewer');
  assert.equal(view.current().viewOnly, false, 'the control setting is preserved');
  assert.equal(view.calls.filter(call => call.name !== 'remote-status').length, 0, 'no input or ownership commands');
  view.current().emit('connect');
  view.retry(2000);
  assert.equal(view.clients.length, 2, 'a second blank connection never loops');
  assert.equal(view.timers.size, 0);
  assert.equal(view.element('configure').textContent, 'Reconnect');
  assert.equal(view.element('remote-title').textContent, 'Desktop has no picture');
});

test('a painted frame, including solid black or a late frame, needs no reconnect', () => {
  for (const pixels of [[0, 0, 0, 255], [10, 20, 30, 255]]) {
    const view = viewer();
    view.paint([0, 0, 0, 0]);
    view.connect(url); view.current().emit('connect');
    view.paint(pixels); view.retry(2000);
    assert.equal(view.clients.length, 1);
    assert.equal(view.timers.size, 0);
    assert.equal(view.status(), 'connected');
  }
});

test('disconnects, URL changes and authentication requests cancel first-frame recovery', () => {
  for (const action of ['disconnect', 'change-url', 'clear-url', 'securityfailure', 'credentialsrequired']) {
    const view = viewer();
    view.paint([0, 0, 0, 0]);
    view.connect(url); view.current().emit('connect');
    assert.equal(view.timers.size, 1);
    const pending = [...view.timers.values()][0];
    if (action === 'change-url' || action === 'clear-url') view.connect(action === 'clear-url' ? '' : 'https://203.0.113.1/viewer/');
    else view.current().emit(action, { clean: true });
    const count = view.clients.length;
    assert.equal(view.timers.size, action === 'change-url' ? 1 : 0);
    pending.callback();
    assert.equal(view.clients.length, count, action);
    assert.equal(view.timers.size, action === 'change-url' ? 1 : 0);
  }
});

test('a network retry after blank recovery cannot reset its first-frame retry budget', () => {
  const view = viewer();
  view.paint([0, 0, 0, 0]);
  view.connect(url); view.current().emit('connect'); view.retry(2000);
  view.current().emit('disconnect', { clean: false }); view.retry(2000);
  view.current().emit('connect'); view.retry(2000);
  assert.equal(view.clients.length, 3);
  assert.equal(view.timers.size, 0);
  assert.equal(view.element('remote-title').textContent, 'Desktop has no picture');
});

test('native resume and window recovery reach the viewer through the preload bridge', () => {
  const ipc = new EventEmitter(), powerMonitor = new EventEmitter(), win = new EventEmitter();
  let workspace, retries = 0, destroyed = false;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/preload.cjs'), 'utf8'), {
    require: name => name === 'electron' ? {
      ipcRenderer: ipc, contextBridge: { exposeInMainWorld: (name, value) => { if (name === 'workspace') workspace = value; } },
    } : { shortcutReference: () => [] },
    location: { protocol: 'file:', pathname: '/remote.html' }, process: { platform: 'darwin' },
  });
  workspace.onRemoteRetry(() => { retries++; });
  const main = fs.readFileSync(path.join(__dirname, '../src/main.cjs'), 'utf8');
  const remoteView = { webContents: {
    isDestroyed: () => destroyed, send: channel => ipc.emit(channel, {}),
  } };
  let vmChecks = 0;
  const start = main.indexOf("  powerMonitor.on('resume'");
  const focus = main.indexOf("  for (const name of ['show', 'restore', 'focus'])");
  vm.runInNewContext(main.slice(start, main.indexOf('  let wasOnline', start)) + main.slice(focus, main.indexOf('  buildMenu();', focus)), {
    powerMonitor, win, remoteView, setTimeout: () => ({ unref() {} }), refreshVpsTabs: () => { vmChecks++; },
  });
  powerMonitor.emit('resume');
  assert.equal(vmChecks, 1, 'waking re-checks the VM browser at once, for tasks it resumed');
  for (const event of ['show', 'restore', 'focus']) win.emit(event);
  assert.equal(retries, 4);
  destroyed = true;
  powerMonitor.emit('resume'); win.emit('focus');
  assert.equal(retries, 4, 'closed renderers are ignored');
});

test('showing the native viewer panel signals recovery only when it becomes visible', () => {
  const main = fs.readFileSync(path.join(__dirname, '../src/main.cjs'), 'utf8');
  let visible = false, retries = 0, bounds = {};
  const remoteView = {
    webContents: { isDestroyed: () => false, send: channel => { assert.equal(channel, 'workspace:remote-retry'); retries++; } },
    getVisible: () => visible, setVisible: value => { visible = value; },
    getBounds: () => bounds, setBounds: value => { bounds = value; },
  };
  const fit = vm.runInNewContext(main.slice(main.indexOf('function fit('), main.indexOf('function backgroundHost(')) + '\nfit', {
    remoteView, layout: {}, win: { getContentBounds: () => ({ width: 1000, height: 800 }) },
  });
  const rect = { x: 0, y: 0, width: 900, height: 700 };
  fit(remoteView, rect); fit(remoteView, rect);
  assert.equal(retries, 1);
  fit(remoteView, null);
  assert.equal(retries, 1);
  fit(remoteView, rect);
  assert.equal(retries, 2);
});
