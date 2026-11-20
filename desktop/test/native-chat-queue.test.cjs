'use strict';
// The offline send queue in native chat: a message sent while Hermes cannot be reached waits on disk and goes
// in order, once, when it can. A fake api stands in for the REST and gateway paths.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createNativeChat } = require('../src/native-chat.cjs');

const SID = 'api_1';
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
async function until(pred, what, ms = 3000) {
  const end = Date.now() + ms;
  while (!pred()) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await tick(2); }
}
const unreachable = () => Object.assign(new Error('x'), { code: 'unreachable' });

// `server` is Hermes's history. By default a stream stores the user row, starts and completes a run like Hermes does.
function rig({ dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-chat-queue-')), ready = true, server = [], stream, clock = { ms: 1.7e12 }, settleMs = 0 } = {}) {
  const calls = [], links = [];
  const state = { ready, server, rowId: server.reduce((n, r) => Math.max(n, r.id), 0) };
  const store = (text) => { state.server.push({ id: ++state.rowId, role: 'user', content: text, timestamp: clock.ms / 1000 }); };
  const api = {
    listSessions: async () => ({ data: [{ id: SID, source: 'api_server', title: 'One' }] }),
    getMessages: async () => { if (state.history) throw unreachable(); return { data: [...state.server].reverse() }; },
    sendReady: () => state.ready,
    onLinkState: (cb) => { links.push(cb); return () => {}; },
    streamChat: async (id, text, opts) => {
      calls.push({ id, text, cmid: opts.clientMessageId });
      if (stream) return stream({ id, text, opts, store, state, calls });
      store(text);
      opts.onEvent('run.started', { run_id: `run-${calls.length}` });
      opts.onEvent('run.completed', {});
    },
  };
  const chat = createNativeChat({ dir, retryMs: 10, settleMs, now: () => clock.ms, apiFactory: () => api,
    loadConfig: () => ({ baseUrl: 'http://127.0.0.1:8642', key: 'k'.repeat(20), lastSessionId: SID, sessions: [{ id: SID, source: 'api_server', title: 'One' }] }) });
  return { chat, api, calls, state, dir, clock, linkLive: () => links.forEach((cb) => cb({ state: 'live' })),
    rows: () => chat.getState().thread.messages, states: () => chat.getState().thread.messages.map((m) => `${m.text}:${m.state || 'server'}`) };
}

test('a message sent while Hermes is unreachable waits as queued and goes, in order, when the link returns', async () => {
  const r = rig({ ready: false });
  await r.chat.command('send', { sessionId: SID, text: 'one' });
  await r.chat.command('send', { sessionId: SID, text: 'two' });
  await tick(30);
  assert.deepEqual(r.calls, []);
  assert.deepEqual(r.states(), ['one:queued', 'two:queued']);
  r.state.ready = true; r.linkLive();
  await until(() => r.calls.length === 2, 'both messages to go');
  assert.deepEqual(r.calls.map((c) => c.text), ['one', 'two']);
  assert.equal(new Set(r.calls.map((c) => c.cmid)).size, 2, 'each message has its own client id');
  assert.ok(r.calls.every((c) => /^[\w-]{8,64}$/.test(c.cmid)));
  await until(() => r.states().join() === 'one:server,two:server', 'the server rows to replace the local ones');
  assert.equal(fs.existsSync(path.join(r.dir, 'native-chat-queue', `${SID}.json`)), false, 'a delivered queue leaves no file');
});

test('only one prompt is submitted at a time per conversation; the next goes when the reply is finished', async () => {
  let release;
  const r = rig({ ready: false, stream: async ({ text, opts, store }) => {
    store(text); opts.onEvent('run.started', { run_id: `r-${text}` });
    await new Promise((resolve) => { release = resolve; });
    opts.onEvent('run.completed', {});
  } });
  await r.chat.command('send', { sessionId: SID, text: 'a' });
  await r.chat.command('send', { sessionId: SID, text: 'b' });
  r.state.ready = true; r.linkLive();
  await until(() => r.calls.length === 1, 'the first to go');
  await tick(40);
  assert.deepEqual(r.calls.map((c) => c.text), ['a'], 'b waits while a is replying');
  assert.equal(r.rows().find((m) => m.text === 'b').state, 'queued');
  release();
  await until(() => r.calls.length === 2, 'b to go after a');
  release();
  await until(() => r.chat.getState().run === null, 'b to finish');
});

test('the queue survives a restart and is delivered once', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-chat-queue-'));
  const first = rig({ dir, ready: false });
  await first.chat.command('send', { sessionId: SID, text: 'kept' });
  first.chat.flush();
  const file = path.join(dir, 'native-chat-queue', `${SID}.json`);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const second = rig({ dir, ready: false });
  assert.deepEqual(second.states(), ['kept:queued'], 'the restored message is on screen');
  second.state.ready = true;
  await until(() => second.calls.length === 1, 'the restored message to go (retry timer)');
  assert.equal(second.calls[0].text, 'kept');
  await until(() => !fs.existsSync(file), 'the queue file to go');
  await tick(60);
  assert.equal(second.calls.length, 1);
});

test('after a drop the history is read first: a message Hermes already has is not sent again', async () => {
  const r = rig({ stream: async ({ text, store, state, calls }) => {
    if (calls.length === 1) { store(text); throw unreachable(); } // reached Hermes, the answer never came back
    state.stored = true;
  } });
  await r.chat.command('send', { sessionId: SID, text: 'maybe' });
  await until(() => r.chat.getState().thread.notice.includes('already reached Hermes'), 'the history check to find it');
  await tick(60);
  assert.equal(r.calls.length, 1, 'no second submit');
  assert.deepEqual(r.states(), ['maybe:server']);
});

// The first request is still on its way to Hermes when the app gives up on it: its row lands in the history later.
async function slowFirstRequest(settleMs) {
  const t0 = Date.now(), clock = { get ms() { return 1.7e12 + Date.now() - t0; } };
  const r = rig({ settleMs, clock, stream: async ({ text, store, calls, opts }) => {
    if (calls.length === 1) { setTimeout(() => store(text), 80); throw unreachable(); }
    store(text); opts.onEvent('run.started', { run_id: 'r' }); opts.onEvent('run.completed', {});
  } });
  await r.chat.command('send', { sessionId: SID, text: 'slow' });
  await tick(300);
  return r;
}
test('a request still on its way when the app gave up is found in the history, not sent twice', async () => {
  const old = await slowFirstRequest(0);
  assert.equal(old.state.server.filter((m) => m.content === 'slow').length, 2, 'without the settle window the history read misses the row and the message goes twice');
  const r = await slowFirstRequest(120);
  assert.equal(r.calls.length, 1);
  assert.equal(r.state.server.filter((m) => m.content === 'slow').length, 1);
  assert.deepEqual(r.states(), ['slow:server']);
});

test('after a drop that lost the message, it is sent again with the same client id', async () => {
  const r = rig({ stream: async ({ text, opts, store, calls }) => {
    if (calls.length === 1) throw unreachable(); // never arrived
    store(text); opts.onEvent('run.started', { run_id: 'r' }); opts.onEvent('run.completed', {});
  } });
  await r.chat.command('send', { sessionId: SID, text: 'lost' });
  await until(() => r.calls.length === 2, 'the second try');
  assert.equal(r.calls[0].cmid, r.calls[1].cmid);
  await until(() => r.states().join() === 'lost:server', 'delivery');
  assert.equal(r.state.server.filter((m) => m.content === 'lost').length, 1);
});

test('while the history cannot be read a doubtful message stays queued and is not sent', async () => {
  const r = rig({ stream: async ({ calls }) => { if (calls.length === 1) throw unreachable(); } });
  await r.chat.command('send', { sessionId: SID, text: 'x' });
  await until(() => r.calls.length === 1 && r.rows()[0].state === 'queued', 'the first try to fail');
  r.state.history = true; // Hermes still unreachable
  await tick(60);
  assert.equal(r.calls.length, 1);
  assert.equal(r.rows()[0].state, 'queued');
});

test('a restart with an attempt in flight treats it as in doubt: matched in history, or sent again', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-chat-queue-'));
  const clock = { ms: 1.7e12 };
  const item = (cmid, text) => ({ cmid, text, createdAt: clock.ms - 5000, state: 'sending', attempts: 1, attemptedAt: clock.ms - 4000, afterId: 10 });
  fs.mkdirSync(path.join(dir, 'native-chat-queue'));
  fs.writeFileSync(path.join(dir, 'native-chat-queue', `${SID}.json`), JSON.stringify({ sessionId: SID, items: [item('cmid-aaaa-1', 'arrived'), item('cmid-bbbb-2', 'missing')] }));
  const server = [{ id: 11, role: 'user', content: 'arrived', timestamp: clock.ms / 1000 - 3 }, { id: 12, role: 'assistant', content: 'ok', timestamp: clock.ms / 1000 - 2 }];
  const r = rig({ dir, clock, server });
  await until(() => r.calls.length === 1, 'the missing one to be sent');
  assert.deepEqual(r.calls.map((c) => [c.text, c.cmid]), [['missing', 'cmid-bbbb-2']], '"arrived" was matched, not sent');
});

test('an older identical message in history does not count as delivery', async () => {
  const clock = { ms: 1.7e12 };
  const server = [{ id: 4, role: 'user', content: 'ok', timestamp: clock.ms / 1000 - 20 }];
  const r = rig({ clock, server, stream: async ({ text, opts, store, calls }) => {
    if (calls.length === 1) throw unreachable();
    store(text); opts.onEvent('run.started', { run_id: 'r' }); opts.onEvent('run.completed', {});
  } });
  await r.chat.command('open', { sessionId: SID });
  await until(() => r.rows().length === 1, 'history');
  await r.chat.command('send', { sessionId: SID, text: 'ok' });
  await until(() => r.calls.length === 2, 'the second try: the old row is not a match');
  assert.equal(r.state.server.filter((m) => m.content === 'ok').length, 2);
});

test('two identical messages claim two different history rows', async () => {
  const r = rig({ stream: async ({ text, store, calls }) => { store(text); throw unreachable(); } });
  await r.chat.command('send', { sessionId: SID, text: 'same' });
  await until(() => r.rows()[0]?.state === 'queued' && r.calls.length === 1, 'first doubt');
  await r.chat.command('send', { sessionId: SID, text: 'same' });
  await until(() => r.calls.length === 2 && r.rows().every((m) => !m.state), 'both settled');
  await tick(60);
  assert.equal(r.calls.length, 2, 'each message went exactly once');
  assert.equal(r.state.server.filter((m) => m.content === 'same').length, 2);
});

test('a message older than 30 minutes is not sent: it shows Not sent, and Retry or Delete decide', async () => {
  const r = rig({ ready: false });
  await r.chat.command('send', { sessionId: SID, text: 'late' });
  r.clock.ms += 31 * 60 * 1000;
  await until(() => r.rows()[0].state === 'failed', 'expiry');
  r.state.ready = true; r.linkLive();
  await tick(40);
  assert.deepEqual(r.calls, [], 'an expired message never goes by itself');
  await r.chat.command('retry', { sessionId: SID, localId: r.rows()[0].id });
  await until(() => r.calls.length === 1, 'Retry to send it');
  assert.equal(r.calls[0].text, 'late');
  // and Delete
  const d = rig({ ready: false });
  await d.chat.command('send', { sessionId: SID, text: 'drop me' });
  d.clock.ms += 31 * 60 * 1000;
  await until(() => d.rows()[0].state === 'failed', 'expiry');
  await d.chat.command('cancel', { sessionId: SID, localId: d.rows()[0].id });
  assert.deepEqual(d.rows(), []);
  d.chat.flush();
  assert.equal(fs.existsSync(path.join(d.dir, 'native-chat-queue', `${SID}.json`)), false);
});

test('a queued message can be cancelled before it goes; a failed head holds the ones behind it', async () => {
  const r = rig({ ready: false });
  await r.chat.command('send', { sessionId: SID, text: 'one' });
  await r.chat.command('send', { sessionId: SID, text: 'two' });
  await r.chat.command('cancel', { sessionId: SID, localId: r.rows()[1].id });
  assert.deepEqual(r.states(), ['one:queued']);
  await assert.rejects(r.chat.command('cancel', { sessionId: SID, localId: 'nope' }), /Nothing to cancel/);
  r.state.ready = true; r.linkLive();
  await until(() => r.calls.length === 1, 'one to go');
  assert.deepEqual(r.calls.map((c) => c.text), ['one']);

  const h = rig({ stream: async () => { throw Object.assign(new Error('Session not found'), { code: 'http_404' }); } });
  await h.chat.command('send', { sessionId: SID, text: 'bad' });
  await until(() => h.rows()[0]?.state === 'failed', 'a definite failure');
  await h.chat.command('send', { sessionId: SID, text: 'next' });
  await tick(40);
  assert.equal(h.calls.length, 1, 'the one behind a failed head does not overtake it');
  assert.deepEqual(h.rows().map((m) => m.state), ['failed', 'queued']);
});

test('a refused write is not retried forever: Hermes busy waits, a definite error fails', async () => {
  let n = 0;
  const r = rig({ stream: async ({ text, opts, store }) => {
    if (++n === 1) throw Object.assign(new Error('busy'), { code: 'http_409' });
    store(text); opts.onEvent('run.started', { run_id: 'r' }); opts.onEvent('run.completed', {});
  } });
  await r.chat.command('send', { sessionId: SID, text: 'wait' });
  await until(() => r.calls.length === 2, 'the retry after a busy answer');
  await until(() => r.states().join() === 'wait:server', 'delivery');
  assert.equal(r.chat.getState().status !== 'error', true);
});

test('queue limits and the queue file never leak into the projected state', async () => {
  const r = rig({ ready: false });
  for (let i = 0; i < 10; i++) await r.chat.command('send', { sessionId: SID, text: 'y'.repeat(100000) });
  await assert.rejects(r.chat.command('send', { sessionId: SID, text: 'z'.repeat(100000) }), /Too many messages/);
  assert.equal(JSON.stringify(r.chat.getState()).includes('cmid'), false);
});
