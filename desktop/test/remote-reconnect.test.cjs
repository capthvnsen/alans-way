const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../src/remote.js'), 'utf8');
const url = 'https://192.0.2.1/viewer/';

function viewer() {
  const clients = [], calls = [], timers = new Map(), elements = new Map();
  let timerId = 0;
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      textContent: '', classList: { add() {}, remove() {}, toggle() {} },
      focus() {}, setAttribute() {},
    });
    return elements.get(id);
  };
  class RFB {
    constructor(screen, socketUrl) { this.url = socketUrl; this.listeners = {}; clients.push(this); }
    addEventListener(name, listener) { this.listeners[name] = listener; }
    emit(name, detail = {}) { this.listeners[name]({ detail }); }
    disconnect() { this.emit('disconnect', { clean: true }); }
    blur() {}
  }
  const context = {
    RFB, URL, window: { workspace: { command: async (name, value) => { calls.push({ name, ...value }); } } },
    document: { getElementById: element },
    setTimeout: (callback, delay) => { timers.set(++timerId, { callback, delay }); return timerId; },
    clearTimeout: id => timers.delete(id),
  };
  vm.runInNewContext(source.slice(source.indexOf('const api ='), source.indexOf("$('control').onclick")), context);
  return {
    clients, calls, timers, element, connect: context.connect,
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

test('unclean disconnect retries the current URL after 2s, 4s and 8s, then stops', () => {
  const view = viewer();
  view.connect(url);
  for (const delay of [2000, 4000, 8000]) {
    view.current().emit('disconnect', { clean: false });
    assert.equal(view.status(), 'reconnecting');
    assert.equal(view.calls.filter(call => call.name === 'remote-control').at(-1).enabled, false);
    view.retry(delay);
    assert.equal(view.current().url, 'wss://192.0.2.1/viewer/websockify');
  }
  view.current().emit('disconnect', { clean: false });
  assert.equal(view.clients.length, 4);
  assert.equal(view.timers.size, 0);
  assert.equal(view.status(), 'disconnected');
  assert.equal(view.element('remote-title').textContent, 'Desktop disconnected');
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
});

for (const event of ['securityfailure', 'credentialsrequired']) {
  test(`${event} prevents retries after an unclean disconnect`, () => {
    const view = viewer();
    view.connect(url); view.current().emit(event);
    view.current().emit('disconnect', { clean: false });
    assert.equal(view.timers.size, 0);
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
    assert.equal(view.timers.size, 0);
    const count = view.clients.length, status = view.status();
    pending.callback();
    old.emit('disconnect', { clean: false }); old.emit('connect'); old.emit('securityfailure');
    assert.equal(view.clients.length, count);
    assert.equal(view.timers.size, 0);
    assert.equal(view.status(), status);
    if (nextUrl) { view.current().emit('disconnect', { clean: false }); view.retry(2000); }
  }
});

test('manual reconnect starts a fresh retry budget', () => {
  const view = viewer();
  view.connect(url);
  for (const delay of [2000, 4000, 8000]) {
    view.current().emit('disconnect', { clean: false }); view.retry(delay);
  }
  view.current().emit('disconnect', { clean: false });
  view.connect(url);
  view.current().emit('disconnect', { clean: false }); view.retry(2000);
});

test('a successful connection cancels a pending retry', () => {
  const view = viewer();
  view.connect(url); view.current().emit('disconnect', { clean: false });
  assert.equal(view.timers.size, 1);
  view.current().emit('connect');
  assert.equal(view.timers.size, 0);
  assert.equal(view.status(), 'connected');
});
