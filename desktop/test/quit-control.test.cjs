'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createQuitControl } = require('../src/quit-control.cjs');

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
};

function harness({ save, teardown, closeResult = true } = {}) {
  const events = [], timers = [], clock = { at: 0 };
  let control;
  const event = () => ({ preventDefault: () => events.push('prevent') });
  const setTimer = (fn, ms) => {
    const timer = { fn, ms, cleared: false, unref() { this.unrefed = true; } };
    timers.push(timer);
    return timer;
  };
  const clearTimer = timer => { timer.cleared = true; };
  control = createQuitControl({
    saveMs: 100, closeMs: 50, insistMs: 10, now: () => clock.at,
    begin: () => events.push('begin'),
    save: () => { events.push('save'); return save ? save() : Promise.resolve(); },
    close: () => { events.push('close'); return closeResult; },
    quit: () => { events.push('quit'); control.beforeQuit(event()); },
    exit: code => events.push(`exit:${code}`),
    teardown: teardown || (() => events.push('teardown')),
    onSaveError: error => events.push(`save-error:${error.message}`),
    onTeardownError: error => events.push(`teardown-error:${error.message}`),
    setTimer, clearTimer,
  });
  return { control, events, timers, event, clock };
}

test('a first quit waits for the sign-in save, resumes, and tears down only once windows are gone', async () => {
  const saving = deferred(), h = harness({ save: () => saving.promise });
  assert.equal(h.control.overrideUnload(), false, 'pages keep their unload veto outside quit');
  h.control.beforeQuit(h.event());
  assert.deepEqual(h.events, ['prevent', 'begin', 'save']);
  assert.equal(h.control.overrideUnload(), true, 'pages cannot veto a quit once it starts');
  assert.equal(h.events.includes('teardown'), false, 'teardown must not run while the quit can still be cancelled');
  saving.resolve();
  await tick();
  assert.deepEqual(h.events, ['prevent', 'begin', 'save', 'close']);
  assert.equal(h.timers[0].cleared, true, 'the save timeout is cancelled once the save settles');
  assert.equal(h.timers[1].ms, 50, 'closing windows gets its own bound');
  assert.equal(h.events.includes('teardown'), false, 'teardown still waits for the windows to close');
  assert.equal(h.control.windowAllClosed(), true);
  assert.deepEqual(h.events, ['prevent', 'begin', 'save', 'close', 'quit']);
  h.control.willQuit();
  assert.deepEqual(h.events, ['prevent', 'begin', 'save', 'close', 'quit', 'teardown']);
  assert.equal(h.timers[1].cleared, true);
});

test('a repeated quit during the save forces exit instead of being swallowed', async () => {
  const saving = deferred(), h = harness({ save: () => saving.promise });
  h.control.beforeQuit(h.event());
  h.control.beforeQuit(h.event());
  assert.deepEqual(h.events, ['prevent', 'begin', 'save', 'prevent'], 'a key-repeat quit right after the first does not skip the save');
  h.clock.at = 10;
  h.control.beforeQuit(h.event());
  assert.deepEqual(h.events, ['prevent', 'begin', 'save', 'prevent', 'prevent', 'teardown', 'exit:0']);
  h.control.willQuit();
  assert.deepEqual(h.events.filter(value => value === 'teardown'), ['teardown'], 'forced teardown runs once');
});

test('a repeated quit while windows are closing still reaches the controller and forces exit', async () => {
  const h = harness();
  h.control.beforeQuit(h.event());
  await tick();
  assert.deepEqual(h.events, ['prevent', 'begin', 'save', 'close']);
  h.clock.at = 10;
  h.control.beforeQuit(h.event());
  assert.deepEqual(h.events, ['prevent', 'begin', 'save', 'close', 'prevent', 'teardown', 'exit:0']);
});

test('an all-closed event outside the controlled close is not consumed', () => {
  const h = harness();
  assert.equal(h.control.windowAllClosed(), false);
  assert.deepEqual(h.events, []);
});

test('an all-closed event during the save is consumed without releasing the final quit', () => {
  const saving = deferred(), h = harness({ save: () => saving.promise });
  h.control.beforeQuit(h.event());
  assert.equal(h.control.windowAllClosed(), true);
  assert.deepEqual(h.events, ['prevent', 'begin', 'save']);
});

test('a quit with no windows left finishes without waiting for another close event', async () => {
  const h = harness({ closeResult: false });
  h.control.beforeQuit(h.event());
  await tick();
  assert.deepEqual(h.events, ['prevent', 'begin', 'save', 'close', 'quit']);
  h.control.willQuit();
  assert.deepEqual(h.events.at(-1), 'teardown');
});

test('a hung sign-in save times out and the quit still completes gracefully', async () => {
  const h = harness({ save: () => new Promise(() => {}) });
  h.control.beforeQuit(h.event());
  assert.equal(h.timers[0].ms, 100);
  h.timers[0].fn();
  await tick();
  assert.deepEqual(h.events, ['prevent', 'begin', 'save', 'save-error:Saving browser sign-ins timed out.', 'close']);
  assert.equal(h.events.includes('exit:0'), false, 'the bounded save failure does not skip orderly window close');
  h.control.windowAllClosed();
  h.control.willQuit();
  assert.deepEqual(h.events.at(-1), 'teardown');
});

test('a failed sign-in save is logged and does not block the quit', async () => {
  const h = harness({ save: () => Promise.reject(new Error('denied')) });
  h.control.beforeQuit(h.event());
  await tick();
  assert.deepEqual(h.events, ['prevent', 'begin', 'save', 'save-error:denied', 'close']);
});

test('a window close that never finishes is forced after the close bound', async () => {
  const h = harness();
  h.control.beforeQuit(h.event());
  await tick();
  assert.deepEqual(h.events, ['prevent', 'begin', 'save', 'close']);
  h.timers[1].fn();
  assert.deepEqual(h.events, ['prevent', 'begin', 'save', 'close', 'teardown', 'exit:0']);
});

test('SIGTERM starts a graceful quit, and a terminating signal during it forces exit', () => {
  const h = harness();
  h.control.signal();
  assert.deepEqual(h.events, ['quit', 'prevent', 'begin', 'save']);
  h.control.signal();
  assert.deepEqual(h.events, ['quit', 'prevent', 'begin', 'save', 'teardown', 'exit:0']);
});

test('SIGTERM while windows are closing forces exit', async () => {
  const h = harness();
  h.control.beforeQuit(h.event());
  await tick();
  assert.deepEqual(h.events, ['prevent', 'begin', 'save', 'close']);
  h.control.signal();
  assert.deepEqual(h.events, ['prevent', 'begin', 'save', 'close', 'teardown', 'exit:0']);
});

test('a teardown failure cannot swallow a forced exit', () => {
  const failure = new Error('flush failed');
  const h = harness({ teardown: () => { throw failure; } });
  h.control.beforeQuit(h.event());
  h.clock.at = 10;
  h.control.beforeQuit(h.event());
  assert.deepEqual(h.events, ['prevent', 'begin', 'save', 'prevent', 'teardown-error:flush failed', 'exit:0']);
});
