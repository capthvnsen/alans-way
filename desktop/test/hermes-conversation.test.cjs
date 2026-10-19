'use strict';
// Focused unit suite for the session-bound conversation controller
// (desktop/src/hermes-conversation.cjs). The REAL HermesSessionWire runs over
// in-memory streams against a scripted fake gateway: real framing, real
// session routing, real single-use request settlement — no model copy.
// A stock-gateway run lives in hermes-conversation-native.cjs (evidence).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { PassThrough, Writable } = require('node:stream');
const { spawn } = require('node:child_process');
const { HermesSessionWire } = require('../src/hermes-session-wire.cjs');
const { HermesConversation, ConversationError } = require('../src/hermes-conversation.cjs');

const tick = () => new Promise((r) => setImmediate(r));
const line = (obj) => JSON.stringify(obj) + '\n';
const EPOCH = 'epoch-fixture-1';

// Minimal scripted peer behind the real wire: auto-dispatches client→server
// calls through per-method handlers; lets the test push events/requests.
class FakeGateway {
  constructor(wireLimits) {
    this.inbound = new PassThrough();
    this.outbound = new PassThrough();
    this.wire = new HermesSessionWire({ input: this.inbound, output: this.outbound, ...wireLimits });
    this.received = [];
    this.handlers = new Map();
    this._waiters = [];
    this._rest = '';
    this.outbound.on('data', (c) => {
      this._rest += c.toString('utf8');
      let i;
      while ((i = this._rest.indexOf('\n')) >= 0) {
        const f = JSON.parse(this._rest.slice(0, i));
        this._rest = this._rest.slice(i + 1);
        this.received.push(f);
        for (const w of [...this._waiters]) {
          if (w.pred(f)) { this._waiters.splice(this._waiters.indexOf(w), 1); w.resolve(f); }
        }
        this._dispatch(f);
      }
    });
  }

  _dispatch(f) {
    const h = this.handlers.get(f.method);
    if (!h || f.id === undefined) return; // unhandled calls simply never answer
    Promise.resolve()
      .then(() => h(f.params || {}, f))
      .then((result) => { if (this.wire.state === 'open') this.inbound.write(line({ jsonrpc: '2.0', id: f.id, result })); })
      .catch((e) => {
        if (this.wire.state === 'open') {
          this.inbound.write(line({ jsonrpc: '2.0', id: f.id, error: { code: e.rpcCode ?? -32603, message: e.message || 'err' } }));
        }
      });
  }

  on(method, fn) { this.handlers.set(method, fn); return this; }

  waitForCall(pred, timeoutMs = 3000) {
    const hit = this.received.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._waiters = this._waiters.filter((w) => w !== rec);
        reject(new Error('waitForCall timed out'));
      }, timeoutMs);
      const rec = { pred, resolve: (f) => { clearTimeout(timer); resolve(f); } };
      this._waiters.push(rec);
    });
  }

  event(type, sessionId, seq, payload) {
    this.inbound.write(line({ jsonrpc: '2.0', method: 'event',
      params: { type, session_id: sessionId, seq, payload } }));
  }

  request(id, method, params) {
    this.inbound.write(line({ jsonrpc: '2.0', id, method, params }));
  }

  cancelRequest(id, sessionId, seq, reason = 'interrupted') {
    this.event('request.cancel', sessionId, seq, { id, method: 'clarify', reason });
  }

  ready(epoch = EPOCH) {
    this.inbound.write(line({ jsonrpc: '2.0', method: 'event',
      params: { type: 'gateway.ready', payload: { replay_epoch: epoch } } }));
  }

  // Standard bind sequence for one live session row.
  bindDefaults({ sessionId = 'sess-A', sessionKey = 'key-A', epoch = EPOCH,
    transcript = [], inflight = null, openRequests = [], extraSessions = [] } = {}) {
    this.on('gateway.capabilities', () => ({ per_session_exclusive_submit: true }));
    this.on('client.capabilities', () => ({ server_requests: ['clarify', 'approval', 'sudo', 'secret'] }));
    this.on('session.active_list', () => ({
      sessions: [{ id: sessionId, session_key: sessionKey, current: true, title: 'A', status: 'idle',
        model: 'm', last_active: 1, message_count: 0, preview: '', started_at: 0 }, ...extraSessions],
    }));
    this.on('session.activate', (p) => ({
      session_id: p.session_id, session_key: sessionKey, stored_session_id: sessionKey,
      message_count: transcript.length, messages: transcript, info: {},
      open_requests: openRequests, inflight,
    }));
    this.on('session.events.since', () => ({
      events: [], latest_seq: 0, truncated: false, count: 0, epoch, open_requests: openRequests,
    }));
    return this;
  }

  end() { this.inbound.end(); }
}

function makeConv(gw, { sessionId = 'sess-A', sessionKey = 'key-A', profile = 'fixture-profile', ...limits } = {}) {
  return new HermesConversation({
    wire: gw.wire,
    identity: { profile, sessionKey, sessionId, reviewed: true },
    ...limits,
  });
}

// ── construction & binding ──────────────────────────────────────────────────

test('identity must be explicit, reviewed and exact', async () => {
  const gw = new FakeGateway();
  assert.throws(() => new HermesConversation({ wire: gw.wire, identity: { profile: 'p', sessionKey: 'k', sessionId: 's' } }),
    (e) => e.code === 'bad_identity');
  assert.throws(() => new HermesConversation({ wire: gw.wire, identity: { profile: ' p ', sessionKey: 'k', sessionId: 's', reviewed: true } }),
    (e) => e.code === 'bad_identity');
  assert.throws(() => new HermesConversation({ wire: gw.wire }), (e) => e.code === 'bad_identity');
  assert.throws(() => new HermesConversation({ wire: {}, identity: { profile: 'p', sessionKey: 'k', sessionId: 's', reviewed: true } }),
    (e) => e.code === 'bad_wire');
  gw.end();
});

test('bind negotiates epoch/capabilities/identity and hydrates state', async () => {
  const gw = new FakeGateway().bindDefaults({
    transcript: [
      { role: 'user', text: 'earlier **markup** question', row_id: 7, timestamp: 1 },
      { role: 'assistant', text: 'earlier <i>answer</i>', row_id: 8, timestamp: 2 },
    ],
    inflight: { streaming: true, assistant: 'partial reply', user: 'what?' },
    openRequests: [{ id: 'srq-open1', method: 'clarify',
      params: { session_id: 'sess-A', questions: [{ qid: 'q0', question: 'Pick?' }] } }],
  });
  const conv = makeConv(gw);
  const snap = await conv.bind({ expectedEpoch: EPOCH });
  assert.equal(snap.phase, 'bound');
  assert.equal(snap.ready, true);
  assert.equal(snap.identity.profile, 'fixture-profile');          // caller label
  assert.equal(snap.attested.sessionId, 'sess-A');                 // server-attested
  assert.equal(snap.attested.sessionKey, 'key-A');
  assert.equal(snap.attested.replayEpoch, EPOCH);
  assert.equal(snap.attested.perSessionExclusiveSubmit, true);
  assert.ok(snap.attested.serverRequestMethods.includes('clarify'));
  assert.equal(snap.transcript.length, 2);
  assert.equal(snap.transcript[0].text, 'earlier **markup** question'); // literal
  assert.equal(snap.transcript[1].text, 'earlier <i>answer</i>');
  assert.equal(snap.turn.streaming, true);
  assert.equal(snap.turn.text, 'partial reply');
  assert.equal(snap.pendingRequests.length, 1);
  assert.equal(snap.pendingRequests[0].id, 'srq-open1');
  assert.equal(snap.pendingRequests[0].replayed, true);
  assert.equal(snap.pendingRequests[0].attributed, true);
  assert.equal(snap.pendingRequests[0].supported, true);
  assert.equal(snap.durableAdmission, false);
  assert.deepEqual(gw.received.map((f) => f.method),
    ['gateway.capabilities', 'client.capabilities', 'session.active_list', 'session.activate', 'session.events.since']);
  conv.dispose();
  gw.end();
});

test('bind waits for gateway.ready when no expectedEpoch is supplied', async () => {
  const gw = new FakeGateway().bindDefaults();
  const conv = makeConv(gw);
  const p = conv.bind({ timeoutMs: 2000 });
  setTimeout(() => gw.ready(EPOCH), 20);
  const snap = await p;
  assert.equal(snap.phase, 'bound');
  conv.dispose();
  gw.end();
});

test('bind rejects identity the gateway cannot confirm — no inference', async () => {
  // active_list has a different pair.
  const gw = new FakeGateway().bindDefaults({ sessionId: 'sess-A', sessionKey: 'key-A' });
  const conv = makeConv(gw, { sessionId: 'sess-WRONG', sessionKey: 'key-A' });
  await assert.rejects(conv.bind({ expectedEpoch: EPOCH }), (e) => e.code === 'identity_unavailable');
  assert.equal(conv.getState().phase, 'blocked');
  // session_key drift at activate.
  const gw2 = new FakeGateway().bindDefaults({});
  gw2.handlers.set('session.activate', () => ({ session_id: 'sess-A', session_key: 'OTHER', messages: [], open_requests: [] }));
  const conv2 = makeConv(gw2);
  await assert.rejects(conv2.bind({ expectedEpoch: EPOCH }), (e) => e.code === 'identity_drift');
  assert.equal(conv2.getState().phase, 'blocked');
  // replay epoch drift vs the wire's epoch.
  const gw3 = new FakeGateway().bindDefaults({ epoch: 'epoch-OTHER' });
  const conv3 = makeConv(gw3);
  await assert.rejects(conv3.bind({ expectedEpoch: EPOCH }), (e) => e.code === 'epoch_mismatch');
  assert.equal(conv3.getState().epochChanged, true);
  // missing exclusive-submit capability.
  const gw4 = new FakeGateway().bindDefaults({});
  gw4.handlers.set('gateway.capabilities', () => ({ per_session_exclusive_submit: false }));
  const conv4 = makeConv(gw4);
  await assert.rejects(conv4.bind({ expectedEpoch: EPOCH }), (e) => e.code === 'capability_missing');
  gw.end(); gw2.end(); gw3.end(); gw4.end();
});

test('a changed gateway.ready epoch on the live wire blocks the controller', async () => {
  const gw = new FakeGateway().bindDefaults();
  const conv = makeConv(gw);
  await conv.bind({ expectedEpoch: EPOCH });
  gw.ready('epoch-CHANGED');
  await tick();
  const s = conv.getState();
  assert.equal(s.phase, 'blocked');
  assert.equal(s.epochChanged, true);
  await assert.rejects(conv.send('x'), (e) => e.code === 'blocked');
  conv.dispose();
  gw.end();
});

// ── two controllers on one wire ─────────────────────────────────────────────

test('two controllers on one wire isolate sessions and answer in reverse order', async () => {
  const gw = new FakeGateway().bindDefaults({
    sessionId: 'sess-A', sessionKey: 'key-A',
    extraSessions: [{ id: 'sess-B', session_key: 'key-B', current: false, title: 'B', status: 'idle',
      model: 'm', last_active: 1, message_count: 0, preview: '', started_at: 0 }],
  });
  gw.handlers.set('session.activate', (p) => (p.session_id === 'sess-A'
    ? { session_id: 'sess-A', session_key: 'key-A', messages: [], open_requests: [] }
    : { session_id: 'sess-B', session_key: 'key-B', messages: [], open_requests: [] }));
  gw.on('session.events.since', (p) => ({
    events: [], latest_seq: 0, truncated: false, count: 0, epoch: EPOCH, open_requests: [] }));
  const a = makeConv(gw, { sessionId: 'sess-A', sessionKey: 'key-A' });
  const b = makeConv(gw, { sessionId: 'sess-B', sessionKey: 'key-B' });
  await a.bind({ expectedEpoch: EPOCH });
  await b.bind({ expectedEpoch: EPOCH });

  // Interleaved cross-session events: nothing leaks.
  gw.event('message.delta', 'sess-B', 1, { text: 'B-only ' });
  gw.event('message.delta', 'sess-A', 1, { text: 'A-' });
  gw.event('message.delta', 'sess-B', 2, { text: 'text' });
  gw.event('message.delta', 'sess-A', 2, { text: 'text' });
  gw.event('message.delta', 'sess-C', 1, { text: 'unknown session' });
  await tick();
  assert.equal(a.getState().turn.text, 'A-text');
  assert.equal(b.getState().turn.text, 'B-only text');
  assert.equal(a.getState().stats.foreignEvents, 3); // 2×sess-B + 1×sess-C

  // Requests for both sessions; answered in reverse order.
  gw.request('srq-B1', 'clarify', { session_id: 'sess-B', questions: [{ qid: 'q0', question: 'B?' }] });
  gw.request('srq-A1', 'clarify', { session_id: 'sess-A', questions: [{ qid: 'q0', question: 'A?' }] });
  await tick();
  assert.deepEqual(a.getState().pendingRequests.map((r) => r.id), ['srq-A1']);
  assert.deepEqual(b.getState().pendingRequests.map((r) => r.id), ['srq-B1']);
  await b.answerRequest('srq-B1', { answers: { q0: 'Plum' } });
  await a.answerRequest('srq-A1', { answers: { q0: 'Fig' } });
  await tick();
  const answers = gw.received.filter((f) => f.id && String(f.id).startsWith('srq-'));
  assert.deepEqual(answers, [
    { jsonrpc: '2.0', id: 'srq-B1', result: { answers: { q0: 'Plum' } } },
    { jsonrpc: '2.0', id: 'srq-A1', result: { answers: { q0: 'Fig' } } },
  ]);
  // A request for a third session stays at the wire, never claimed.
  gw.request('srq-C1', 'clarify', { session_id: 'sess-C', questions: [] });
  await tick();
  assert.equal(a.getState().pendingRequests.length, 0);
  assert.equal(b.getState().pendingRequests.length, 0);
  assert.equal(a.getState().stats.foreignRequests, 2); // srq-B1 and srq-C1 both foreign to A
  assert.equal(b.getState().stats.foreignRequests, 2); // srq-A1 and srq-C1 both foreign to B
  assert.ok(gw.wire.pendingServerRequests.some((r) => r.id === 'srq-C1'));
  a.dispose(); b.dispose(); gw.end();
});

// ── send / stream / stop ────────────────────────────────────────────────────

test('send captures the bound target, streams ordered deltas, seals on complete', async () => {
  const gw = new FakeGateway().bindDefaults();
  gw.on('prompt.submit', (p) => {
    assert.equal(p.session_id, 'sess-A');
    gw.event('message.delta', 'sess-A', 1, { text: 'Here is ' });
    gw.event('message.delta', 'sess-A', 2, { text: '`<literal>` markup' });
    gw.event('message.complete', 'sess-A', 3, { text: 'Here is `<literal>` markup', status: 'complete' });
    return { status: 'streaming', user_row_id: 42 };
  });
  const conv = makeConv(gw);
  const changes = [];
  conv.subscribe((s) => changes.push(s.phase + ':' + (s.turn ? s.turn.text : '-')));
  await conv.bind({ expectedEpoch: EPOCH });
  const result = await conv.send('tell me about `<literal>` markup');
  assert.equal(result.status, 'streaming');
  const s = conv.getState();
  assert.equal(s.lastSend.outcome, 'admitted');
  assert.equal(s.lastSend.target.sessionId, 'sess-A');
  assert.equal(s.transcript.length, 2);
  assert.equal(s.transcript[0].role, 'user');
  assert.equal(s.transcript[0].text, 'tell me about `<literal>` markup'); // literal
  assert.equal(s.transcript[0].rowId, 42);
  assert.equal(s.transcript[1].role, 'assistant');
  assert.equal(s.transcript[1].text, 'Here is `<literal>` markup');
  assert.equal(s.transcript[1].status, 'complete');
  assert.equal(s.turn, null);
  conv.dispose();
  gw.end();
});

test('duplicate in-flight send is rejected; explicit resend is the caller\'s choice', async () => {
  const gw = new FakeGateway().bindDefaults();
  let hold = null;
  gw.on('prompt.submit', () => new Promise((r) => { hold = r; }));
  const conv = makeConv(gw);
  await conv.bind({ expectedEpoch: EPOCH });
  const first = conv.send('first');
  await gw.waitForCall((f) => f.method === 'prompt.submit');
  await assert.rejects(conv.send('second'), (e) => e.code === 'send_in_flight');
  hold({ status: 'queued' });
  assert.equal((await first).status, 'queued');
  assert.equal(conv.getState().lastSend.outcome, 'admitted');
  assert.equal(conv.getState().lastSend.status, 'queued');
  conv.dispose();
  gw.end();
});

test('a never-answered submit is uncertain — never silently replayed', async () => {
  const gw = new FakeGateway({ defaultTimeoutMs: 60 }).bindDefaults();
  let calls = 0;
  gw.on('prompt.submit', () => { calls += 1; if (calls === 1) return new Promise(() => {}); return { status: 'streaming' }; });
  const conv = makeConv(gw);
  await conv.bind({ expectedEpoch: EPOCH });
  conv.setDraft('unsure text');
  await assert.rejects(conv.send(), (e) => e.code === 'timeout');
  const s = conv.getState();
  assert.equal(s.lastSend.outcome, 'uncertain');
  assert.equal(s.lastSend.error.code, 'timeout');
  assert.equal(s.draft.text, 'unsure text');            // draft survives
  assert.equal(calls, 1);                               // no silent replay
  // The user row reflects what really happened: submitted, admission uncertain.
  assert.equal(s.transcript.length, 1);
  assert.equal(s.transcript[0].status, 'uncertain');
  assert.equal(s.transcript[0].admitted, false);
  // An explicit caller resend is allowed and does reuse the exact text.
  await conv.send('unsure text');
  assert.equal(calls, 2);
  assert.equal(conv.getState().lastSend.outcome, 'admitted');
  conv.dispose();
  gw.end();
});

test('a definite refusal is classified rejected, draft survives', async () => {
  const gw = new FakeGateway().bindDefaults();
  gw.on('prompt.submit', () => { const e = new Error('session busy'); e.rpcCode = 4009; throw e; });
  const conv = makeConv(gw);
  await conv.bind({ expectedEpoch: EPOCH });
  conv.setDraft('keep me');
  await assert.rejects(conv.send(), (e) => e.code === 'remote_error');
  const s = conv.getState();
  assert.equal(s.lastSend.outcome, 'rejected');
  assert.equal(s.lastSend.error.code, 'remote_error');
  assert.equal(s.draft.text, 'keep me');
  conv.dispose();
  gw.end();
});

test('stop() sends session.interrupt for the bound session and waits for truth', async () => {
  const gw = new FakeGateway().bindDefaults();
  gw.on('prompt.submit', () => ({ status: 'streaming' }));
  gw.on('session.interrupt', (p) => {
    assert.equal(p.session_id, 'sess-A');
    setTimeout(() => {
      gw.event('message.complete', 'sess-A', 9, { text: 'partial', status: 'interrupted' });
      gw.cancelRequest('srq-stop', 'sess-A', 10, 'interrupted');
    }, 10);
    return { status: 'interrupted', interrupted: true };
  });
  const conv = makeConv(gw);
  await conv.bind({ expectedEpoch: EPOCH });
  gw.request('srq-stop', 'clarify', { session_id: 'sess-A', questions: [{ qid: 'q0', question: 'hold?' }] });
  await conv.send('run');
  gw.event('message.delta', 'sess-A', 1, { text: 'working…' });
  await tick();
  const res = await conv.stop();
  assert.equal(res.status, 'interrupted');
  // The RPC result alone did NOT end the turn.
  let s = conv.getState();
  assert.equal(s.lastInterrupt.status, 'interrupted');
  // Turn ends only when the terminal event arrives.
  await new Promise((r) => {
    const t = setInterval(() => { if (conv.getState().turn === null) { clearInterval(t); r(); } }, 5);
  });
  s = conv.getState();
  assert.equal(s.transcript.at(-1).status, 'interrupted');
  assert.equal(s.pendingRequests.length, 0);
  assert.equal(s.requestOutcomes.at(-1).outcome, 'withdrawn');
  assert.equal(s.requestOutcomes.at(-1).cancelReason, 'interrupted');
  conv.dispose();
  gw.end();
});

test('stop() on an idle session reports not_interrupted truthfully', async () => {
  const gw = new FakeGateway().bindDefaults();
  gw.on('session.interrupt', () => ({ status: 'not_interrupted', interrupted: false }));
  const conv = makeConv(gw);
  await conv.bind({ expectedEpoch: EPOCH });
  const res = await conv.stop();
  assert.equal(res.status, 'not_interrupted');
  assert.equal(conv.getState().lastInterrupt.status, 'not_interrupted');
  conv.dispose();
  gw.end();
});

// ── server→client requests ──────────────────────────────────────────────────

test('clarify answers are schema-verified, single-use and attributable', async () => {
  const gw = new FakeGateway().bindDefaults();
  const conv = makeConv(gw);
  await conv.bind({ expectedEpoch: EPOCH });
  gw.request('srq-1', 'clarify', { session_id: 'sess-A',
    questions: [{ qid: 'q0', question: 'Pick a fruit', choices: ['Apple', 'Banana'] }, { qid: 'q1', question: 'Free text' }] });
  await tick();
  const pending = conv.getState().pendingRequests[0];
  assert.equal(pending.method, 'clarify');
  assert.equal(pending.sessionId, 'sess-A');
  assert.equal(pending.supported, true);
  assert.equal(pending.params.questions[1].question, 'Free text'); // verbatim metadata
  // Wrong question id is refused before any byte is written.
  await assert.rejects(conv.answerRequest('srq-1', { answers: { qNope: 'x' } }), (e) => e.code === 'bad_result');
  // Non-string answer rejected too.
  await assert.rejects(conv.answerRequest('srq-1', { answers: { q0: 5 } }), (e) => e.code === 'bad_result');
  // No frame went out for the rejected validations.
  assert.equal(gw.received.filter((f) => String(f.id).startsWith('srq-')).length, 0);
  await conv.answerRequest('srq-1', { answers: { q0: 'Apple', q1: null } }); // q1 explicitly skipped
  await tick();
  const frame = gw.received.find((f) => f.id === 'srq-1');
  assert.deepEqual(frame.result, { answers: { q0: 'Apple', q1: null } });
  await assert.rejects(conv.answerRequest('srq-1', { answers: {} }), (e) => e.code === 'unknown_request');
  assert.equal(conv.getState().requestOutcomes.at(-1).outcome, 'answered');
  conv.dispose();
  gw.end();
});

test('approval answers must match the offered choices', async () => {
  const gw = new FakeGateway().bindDefaults();
  const conv = makeConv(gw);
  await conv.bind({ expectedEpoch: EPOCH });
  gw.request('srq-a', 'approval', { session_id: 'sess-A', request_id: 'r1',
    command: 'rm -rf build', description: 'danger', choices: ['once', 'deny'] });
  await tick();
  const p = conv.getState().pendingRequests[0];
  assert.equal(p.method, 'approval');
  assert.equal(p.params.command, 'rm -rf build');
  await assert.rejects(conv.answerRequest('srq-a', { choice: 'always' }), (e) => e.code === 'bad_result');
  await assert.rejects(conv.answerRequest('srq-a', { choice: 'maybe' }), (e) => e.code === 'bad_result');
  await conv.answerRequest('srq-a', { choice: 'deny' });
  await tick();
  assert.deepEqual(gw.received.find((f) => f.id === 'srq-a').result, { choice: 'deny' });
  conv.dispose();
  gw.end();
});

test('unknown request kinds stay pending and unsupported — refusal only', async () => {
  const gw = new FakeGateway().bindDefaults();
  const conv = makeConv(gw);
  await conv.bind({ expectedEpoch: EPOCH });
  gw.request('srq-x', 'kernel.exec', { session_id: 'sess-A', command: 'do something' });
  await tick();
  const p = conv.getState().pendingRequests[0];
  assert.equal(p.supported, false);
  assert.equal(p.advertised, false);
  await assert.rejects(conv.answerRequest('srq-x', { value: 'run it' }), (e) => e.code === 'unsupported_request');
  assert.equal(conv.getState().pendingRequests.length, 1); // still pending, honest
  await conv.refuseRequest('srq-x');
  await tick();
  const frame = gw.received.find((f) => f.id === 'srq-x');
  assert.equal(frame.error.code, -32601);
  assert.ok(!('result' in frame));
  assert.equal(conv.getState().requestOutcomes.at(-1).outcome, 'refused');
  conv.dispose();
  gw.end();
});

test('a request with no session_id is unattributable and unanswerable', async () => {
  const gw = new FakeGateway().bindDefaults();
  const conv = makeConv(gw);
  await conv.bind({ expectedEpoch: EPOCH });
  gw.request('srq-amb', 'clarify', { questions: [{ qid: 'q0', question: 'Who knows?' }] });
  await tick();
  const p = conv.getState().pendingRequests[0];
  assert.equal(p.attributed, false);
  assert.equal(p.sessionId, null);
  await assert.rejects(conv.answerRequest('srq-amb', { answers: { q0: 'x' } }), (e) => e.code === 'ambiguous_request');
  await assert.rejects(conv.refuseRequest('srq-amb'), (e) => e.code === 'ambiguous_request');
  assert.equal(conv.getState().pendingRequests.length, 1);
  conv.dispose();
  gw.end();
});

test('request.cancel withdraws exactly that request', async () => {
  const gw = new FakeGateway().bindDefaults();
  const conv = makeConv(gw);
  await conv.bind({ expectedEpoch: EPOCH });
  gw.request('srq-1', 'clarify', { session_id: 'sess-A', questions: [] });
  gw.request('srq-2', 'sudo', { session_id: 'sess-A', prompt: 'pw' });
  await tick();
  gw.cancelRequest('srq-1', 'sess-A', 5, 'timeout');
  await tick();
  const s = conv.getState();
  assert.deepEqual(s.pendingRequests.map((r) => r.id), ['srq-2']);
  assert.equal(s.requestOutcomes.at(-1).outcome, 'withdrawn');
  assert.equal(s.requestOutcomes.at(-1).cancelReason, 'timeout');
  await assert.rejects(conv.answerRequest('srq-1', { answers: {} }), (e) => e.code === 'unknown_request');
  await conv.answerRequest('srq-2', { value: 'hunter2' });
  conv.dispose();
  gw.end();
});

// ── lifecycle / replay / bounds ─────────────────────────────────────────────

test('EOF during an in-flight submit: uncertain, draft kept, terminal', async () => {
  const gw = new FakeGateway().bindDefaults();
  let hold;
  gw.on('prompt.submit', () => new Promise((r) => { hold = r; }));
  const conv = makeConv(gw);
  await conv.bind({ expectedEpoch: EPOCH });
  conv.setDraft('may or may not have landed');
  const p = conv.send();
  await tick();
  gw.end(); // EOF while prompt.submit is in flight
  await assert.rejects(p, (e) => e.code === 'eof');
  const s = conv.getState();
  assert.equal(s.phase, 'disconnected');
  assert.equal(s.connectivity, 'eof');
  assert.equal(s.lastSend.outcome, 'uncertain');
  assert.equal(s.draft.text, 'may or may not have landed');
  await assert.rejects(conv.send('again'), (e) => e.code === 'disconnected');
  await assert.rejects(conv.answerRequest('srq-1', {}), (e) => e.code === 'disconnected');
  conv.dispose();
});

test('EOF while a question is pending marks the request dead', async () => {
  const gw = new FakeGateway().bindDefaults();
  const conv = makeConv(gw);
  await conv.bind({ expectedEpoch: EPOCH });
  gw.request('srq-e', 'clarify', { session_id: 'sess-A', questions: [] });
  await tick();
  gw.end();
  await tick();
  const s = conv.getState();
  assert.equal(s.phase, 'disconnected');
  assert.equal(s.pendingRequests.length, 0);
  assert.equal(s.requestOutcomes.at(-1).outcome, 'dead');
  assert.equal(s.requestOutcomes.at(-1).id, 'srq-e');
  await assert.rejects(conv.answerRequest('srq-e', { answers: {} }), (e) => e.code === 'disconnected');
  conv.dispose();
});

test('dispose detaches only this controller; wire and peer controller live on', async () => {
  const gw = new FakeGateway().bindDefaults({
    extraSessions: [{ id: 'sess-B', session_key: 'key-B', current: false, title: 'B', status: 'idle',
      model: 'm', last_active: 1, message_count: 0, preview: '', started_at: 0 }],
  });
  gw.handlers.set('session.activate', (p) => (p.session_id === 'sess-A'
    ? { session_id: 'sess-A', session_key: 'key-A', messages: [], open_requests: [] }
    : { session_id: 'sess-B', session_key: 'key-B', messages: [], open_requests: [] }));
  const a = makeConv(gw, { sessionId: 'sess-A', sessionKey: 'key-A' });
  const b = makeConv(gw, { sessionId: 'sess-B', sessionKey: 'key-B' });
  await a.bind({ expectedEpoch: EPOCH });
  await b.bind({ expectedEpoch: EPOCH });
  a.setDraft('draft survives dispose');
  a.dispose();
  assert.equal(a.getState().phase, 'disposed');
  // Late traffic no longer mutates the disposed controller.
  gw.event('message.delta', 'sess-A', 7, { text: 'post-dispose' });
  gw.event('message.delta', 'sess-B', 7, { text: 'b lives' });
  await tick();
  assert.equal(a.getState().turn, null);
  assert.equal(b.getState().turn.text, 'b lives');
  // Stale actions on the disposed controller are refused.
  await assert.rejects(a.send('x'), (e) => e.code === 'disposed');
  await assert.rejects(a.answerRequest('srq-1', {}), (e) => e.code === 'disposed');
  assert.equal(a.getState().draft.text, 'draft survives dispose'); // draft survives
  assert.equal(gw.wire.state, 'open');
  // Rebinding a fresh controller to the same session on the same wire works.
  const a2 = makeConv(gw, { sessionId: 'sess-A', sessionKey: 'key-A' });
  await a2.bind({ expectedEpoch: EPOCH });
  assert.equal(a2.getState().phase, 'bound');
  a2.dispose(); b.dispose(); gw.end();
});

test('syncFromReplay applies unseen ordered events and merges open_requests', async () => {
  const gw = new FakeGateway().bindDefaults();
  const conv = makeConv(gw);
  await conv.bind({ expectedEpoch: EPOCH });
  // Peer returns three new events + one still-open request; repeating the same
  // window later must dedupe by seq, never double-apply.
  gw.handlers.set('session.events.since', (p) => ({
    events: p.last_seen === 0 ? [
      { type: 'message.delta', session_id: 'sess-A', seq: 1, payload: { text: 're' } },
      { type: 'message.delta', session_id: 'sess-A', seq: 2, payload: { text: 'play' } },
      { type: 'message.complete', session_id: 'sess-A', seq: 3, payload: { text: 'replay', status: 'complete' } },
    ] : [
      { type: 'message.delta', session_id: 'sess-A', seq: 2, payload: { text: 'play' } },
      { type: 'message.complete', session_id: 'sess-A', seq: 3, payload: { text: 'replay', status: 'complete' } },
    ],
    latest_seq: 3, truncated: false, count: 0, epoch: EPOCH,
    open_requests: p.last_seen === 0
      ? [{ id: 'srq-re', method: 'clarify', params: { session_id: 'sess-A', questions: [] } }]
      : [],
  }));
  const out = await conv.syncFromReplay();
  assert.equal(out.applied, 3);
  assert.equal(out.openRequests, 1);
  const s = conv.getState();
  assert.equal(s.lastSeq, 3);
  assert.equal(s.transcript.at(-1).text, 'replay');
  assert.equal(s.pendingRequests[0].id, 'srq-re');
  assert.equal(s.pendingRequests[0].replayed, true);
  // A second sync re-delivering overlapping seqs applies nothing twice.
  const again = await conv.syncFromReplay();
  assert.equal(again.applied, 0);
  assert.ok(conv.getState().stats.duplicateEvents >= 2);
  assert.equal(conv.getState().transcript.length, 1);
  conv.dispose();
  gw.end();
});

test('truncated replay marks the state review-required and disables writes', async () => {
  const gw = new FakeGateway().bindDefaults();
  const conv = makeConv(gw);
  await conv.bind({ expectedEpoch: EPOCH });
  gw.handlers.set('session.events.since', () => ({
    events: [], latest_seq: 40, truncated: true, count: 0, epoch: EPOCH, open_requests: [],
  }));
  const out = await conv.syncFromReplay();
  assert.equal(out.truncated, true);
  const s = conv.getState();
  assert.equal(s.phase, 'review');
  assert.equal(s.truncated.replay, true);
  assert.equal(s.needsReview, true);
  await assert.rejects(conv.send('x'), (e) => e.code === 'needs_review');
  await assert.rejects(conv.answerRequest('x', {}), (e) => e.code === 'needs_review');
  // stop stays allowed — interrupting a reviewed-for-incompleteness session is safe.
  gw.on('session.interrupt', () => ({ status: 'not_interrupted' }));
  await conv.stop();
  conv.dispose();
  gw.end();
});

test('replay on a changed epoch blocks rather than reconciles', async () => {
  const gw = new FakeGateway().bindDefaults();
  const conv = makeConv(gw);
  await conv.bind({ expectedEpoch: EPOCH });
  gw.handlers.set('session.events.since', () => ({
    events: [], latest_seq: 0, truncated: false, count: 0, epoch: 'epoch-OTHER', open_requests: [],
  }));
  await assert.rejects(conv.syncFromReplay(), (e) => e.code === 'epoch_mismatch');
  const s = conv.getState();
  assert.equal(s.phase, 'blocked');
  assert.equal(s.epochChanged, true);
  conv.dispose();
  gw.end();
});

test('finite bounds report truncation honestly', async () => {
  const gw = new FakeGateway({ maxPendingServerRequests: 8 }).bindDefaults();
  const conv = makeConv(gw, { maxTranscriptEntries: 4, maxStreamedChars: 10, maxPendingRequests: 2 });
  await conv.bind({ expectedEpoch: EPOCH });
  // Transcript overflow.
  gw.on('prompt.submit', () => ({ status: 'queued' }));
  for (let i = 0; i < 6; i++) await conv.send(`m${i}`);
  let s = conv.getState();
  assert.equal(s.transcript.length, 4);
  assert.equal(s.transcriptDropped, 2);
  assert.equal(s.truncated.transcript, true);
  // Streamed text cap.
  gw.handlers.set('prompt.submit', () => ({ status: 'streaming' }));
  await conv.send('go');
  gw.event('message.delta', 'sess-A', 1, { text: '0123456789ABCDEF' });
  await tick();
  s = conv.getState();
  assert.equal(s.turn.text.length, 10);
  assert.equal(s.turn.truncated, true);
  // Pending request cap.
  gw.request('srq-p1', 'clarify', { session_id: 'sess-A', questions: [] });
  gw.request('srq-p2', 'clarify', { session_id: 'sess-A', questions: [] });
  gw.request('srq-p3', 'clarify', { session_id: 'sess-A', questions: [] });
  await tick();
  s = conv.getState();
  assert.equal(s.pendingRequests.length, 2);
  assert.equal(s.stats.droppedRequests, 1);
  // Draft bound.
  assert.throws(() => conv.setDraft('x'.repeat(70000)), (e) => e.code === 'draft_too_large');
  conv.dispose();
  gw.end();
});

test('draft text is preserved literally, including markup', async () => {
  const gw = new FakeGateway().bindDefaults();
  const conv = makeConv(gw);
  await conv.bind({ expectedEpoch: EPOCH });
  conv.setDraft('  keep **all** `of` <this>\nverbatim  ');
  assert.equal(conv.getState().draft.text, '  keep **all** `of` <this>\nverbatim  ');
  conv.dispose();
});

// Electron-as-Node24 compatibility of the controller.
test('controller works under Electron-as-Node (embedded Node 24)', { timeout: 30000 }, async (t) => {
  let electron;
  try { electron = require('electron'); } catch { electron = null; }
  if (!electron || typeof electron !== 'string' || !fs.existsSync(electron)) {
    t.skip('electron binary unavailable');
    return;
  }
  const script = path.join(__dirname, 'hermes-conversation-electron.cjs');
  const child = spawn(electron, [script], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '', err = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { err += c; });
  const code = await new Promise((r) => child.once('exit', r));
  assert.equal(code, 0, `electron-as-node run failed: ${err}\n${out}`);
  assert.match(out, /ELECTRON-CONVERSATION-PASS/);
});

test('binding does not append a completion already in the activation snapshot', async () => {
  const gw = new FakeGateway().bindDefaults();
  gw.on('session.activate', () => {
    gw.event('message.complete', 'sess-A', 1, { text: 'Finished answer', status: 'complete' });
    return { session_id: 'sess-A', session_key: 'key-A', messages: [{ role: 'assistant', text: 'Finished answer' }], open_requests: [] };
  });
  gw.on('session.events.since', () => ({ epoch: EPOCH, events: [], open_requests: [], latest_seq: 1, truncated: false }));
  const c = makeConv(gw);
  try {
    await c.bind({ expectedEpoch: EPOCH });
    assert.deepEqual(c.getState().transcript.map(row => row.text), ['Finished answer']);
    assert.equal(c.getState().needsReview, true, 'the snapshot has no cursor to disambiguate concurrent updates');
    assert.equal(c.getState().errors.at(-1).code, 'activation_overlap');
    await assert.rejects(c.send('before reviewing'), e => e.code === 'needs_review');
  } finally { c.dispose(); gw.end(); }
});

test('binding preserves completions arriving after the activation snapshot while replay is pending', async () => {
  const gw = new FakeGateway().bindDefaults({ transcript: [{ role: 'assistant', text: 'Earlier' }] });
  gw.on('session.events.since', () => {
    gw.event('message.complete', 'sess-A', 1, { text: 'Later', status: 'complete' });
    return { epoch: EPOCH, events: [], open_requests: [], latest_seq: 1, truncated: false };
  });
  const c = makeConv(gw);
  try {
    await c.bind({ expectedEpoch: EPOCH });
    assert.deepEqual(c.getState().transcript.map(row => row.text), ['Earlier', 'Later']);
  } finally { c.dispose(); gw.end(); }
});

test('snapshot-only requests remain visible and unavailable until a fresh wire request arrives', async () => {
  const request = { id: 'replayed-request', method: 'approval', params: { session_id: 'sess-A', choices: ['once', 'deny'] } };
  const gw = new FakeGateway().bindDefaults({ openRequests: [request] });
  const c = makeConv(gw, { maxPendingRequests: 1 });
  try {
    await c.bind({ expectedEpoch: EPOCH });
    assert.equal(c.getState().pendingRequests[0].answerable, false);
    await assert.rejects(c.answerRequest(request.id, { choice: 'once' }), e => e.code === 'request_unavailable');
    await assert.rejects(c.refuseRequest(request.id), e => e.code === 'request_unavailable');
    assert.equal(c.getState().pendingRequests.length, 1);
    assert.equal(c.getState().requestOutcomes.length, 0);
    gw.request(request.id, request.method, request.params);
    assert.equal(c.getState().pendingRequests[0].answerable, true);
    await c.answerRequest(request.id, { choice: 'once' });
    assert.equal(gw.received.filter(f => f.id === request.id && f.result?.choice === 'once').length, 1);
    await assert.rejects(c.answerRequest(request.id, { choice: 'once' }), e => e.code === 'unknown_request');
  } finally { c.dispose(); gw.end(); }
});

test('review acknowledgement enables explicit actions without concealing missing history', async () => {
  const gw = new FakeGateway().bindDefaults();
  gw.on('session.events.since', () => ({ epoch: EPOCH, events: [], open_requests: [], latest_seq: 50, truncated: true }));
  gw.on('prompt.submit', () => ({ status: 'admitted' }));
  const c = makeConv(gw);
  try {
    await c.bind({ expectedEpoch: EPOCH });
    await assert.rejects(c.send('before review'), e => e.code === 'needs_review');
    c.acknowledgeReview();
    assert.equal(c.getState().phase, 'bound');
    assert.equal(c.getState().truncated.replay, true);
    assert.equal(c.getState().needsReview, false);
    await c.send('after review');
    assert.equal(gw.received.filter(f => f.method === 'prompt.submit').length, 1);
    gw.ready('changed-epoch');
    assert.throws(() => c.acknowledgeReview(), e => e.code === 'blocked');
  } finally { c.dispose(); gw.end(); }
});

test('a snapshot-only request is withdrawn by its session cancellation event without a reply', async () => {
  const request = { id: 'snapshot-cancel', method: 'approval', params: { session_id: 'sess-A', choices: ['once'] } };
  const gw = new FakeGateway().bindDefaults({ openRequests: [request] }); const c = makeConv(gw);
  try {
    await c.bind({ expectedEpoch: EPOCH });
    gw.cancelRequest(request.id, 'sess-A', 1);
    assert.deepEqual(c.getState().pendingRequests, []);
    assert.equal(c.getState().requestOutcomes.at(-1).outcome, 'withdrawn');
    assert.equal(gw.received.some(f => f.id === request.id), false);
  } finally { c.dispose(); gw.end(); }
});

test('a request already pending on the wire before controller creation can be answered after activation', async () => {
  const request = { id: 'early-frame', method: 'approval', params: { session_id: 'sess-A', choices: ['once'] } };
  const gw = new FakeGateway().bindDefaults({ openRequests: [request] });
  gw.request(request.id, request.method, request.params);
  const c = makeConv(gw);
  try {
    await c.bind({ expectedEpoch: EPOCH });
    assert.equal(c.getState().pendingRequests[0].answerable, true);
    await c.answerRequest(request.id, { choice: 'once' });
    assert.equal(gw.received.filter(f => f.id === request.id && f.result?.choice === 'once').length, 1);
  } finally { c.dispose(); gw.end(); }
});

test('the fresh replay request list supersedes older activation requests', async () => {
  const request = { id: 'old-snapshot', method: 'approval', params: { session_id: 'sess-A', choices: ['once'] } };
  const gw = new FakeGateway().bindDefaults({ openRequests: [request] });
  gw.on('session.events.since', () => ({ epoch: EPOCH, events: [], open_requests: [], latest_seq: 0, truncated: false }));
  const c = makeConv(gw);
  try {
    await c.bind({ expectedEpoch: EPOCH });
    assert.deepEqual(c.getState().pendingRequests, []);
  } finally { c.dispose(); gw.end(); }
});

test('a cancellation racing the replay response cannot resurrect a snapshot-only request', async () => {
  const request = { id: 'cancel-during-replay', method: 'approval', params: { session_id: 'sess-A', choices: ['once'] } };
  const gw = new FakeGateway().bindDefaults({ openRequests: [request] });
  gw.on('session.events.since', () => {
    gw.cancelRequest(request.id, 'sess-A', 1);
    return { epoch: EPOCH, events: [], open_requests: [request], latest_seq: 1, truncated: false };
  });
  const c = makeConv(gw);
  try {
    await c.bind({ expectedEpoch: EPOCH });
    assert.deepEqual(c.getState().pendingRequests, []);
    assert.equal(c.getState().requestOutcomes.filter(r => r.id === request.id && r.outcome === 'withdrawn').length, 1);
    assert.equal(gw.received.some(f => f.id === request.id), false);
  } finally { c.dispose(); gw.end(); }
});
