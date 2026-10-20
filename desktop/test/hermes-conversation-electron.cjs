'use strict';
// Electron-as-Node24 compatibility check for the session-bound conversation
// controller. Runs under `ELECTRON_RUN_AS_NODE=1 electron <this file>`
// (spawned by hermes-conversation.test.cjs). Plain asserts — nonzero on failure.
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { HermesSessionWire } = require('../src/hermes-session-wire.cjs');
const { HermesConversation } = require('../src/hermes-conversation.cjs');

const line = (o) => JSON.stringify(o) + '\n';
const EPOCH = 'electron-epoch-1';

async function main() {
  // Wire timers are unref'd by contract: this script owns its liveness.
  const keepAlive = setInterval(() => {}, 1000);

  // Scripted fake gateway over the real wire.
  const inbound = new PassThrough();
  const outbound = new PassThrough();
  const wire = new HermesSessionWire({ input: inbound, output: outbound });
  const received = [];
  let rest = '';
  const handlers = {
    'gateway.capabilities': () => ({ per_session_exclusive_submit: true }),
    'client.capabilities': () => ({ server_requests: ['clarify', 'approval'] }),
    'session.active_list': () => ({ sessions: [{ id: 'e-sess', session_key: 'e-key' }] }),
    'session.activate': (p) => ({ session_id: p.session_id, session_key: 'e-key',
      stored_session_id: 'e-key', message_count: 0, messages: [], open_requests: [] }),
    'session.events.since': () => ({ events: [], latest_seq: 0, truncated: false, count: 0, epoch: EPOCH, open_requests: [] }),
    'prompt.submit': (p) => {
      assert.equal(p.session_id, 'e-sess');
      inbound.write(line({ jsonrpc: '2.0', method: 'event',
        params: { type: 'message.delta', session_id: 'e-sess', seq: 1, payload: { text: 'part ' } } }));
      inbound.write(line({ jsonrpc: '2.0', method: 'event',
        params: { type: 'message.delta', session_id: 'e-sess', seq: 2, payload: { text: 'one `<tag>`' } } }));
      return { status: 'streaming' };
    },
    'session.interrupt': (p) => {
      assert.equal(p.session_id, 'e-sess');
      setTimeout(() => inbound.write(line({ jsonrpc: '2.0', method: 'event',
        params: { type: 'message.complete', session_id: 'e-sess', seq: 3,
          payload: { text: 'part one `<tag>`', status: 'interrupted' } } })), 5);
      return { status: 'interrupted', interrupted: true };
    },
  };
  outbound.on('data', (c) => {
    rest += c.toString('utf8');
    let i;
    while ((i = rest.indexOf('\n')) >= 0) {
      const f = JSON.parse(rest.slice(0, i));
      rest = rest.slice(i + 1);
      received.push(f);
      if (f.method && f.id !== undefined && handlers[f.method]) {
        Promise.resolve(handlers[f.method](f.params || {}, f))
          .then((result) => inbound.write(line({ jsonrpc: '2.0', id: f.id, result })))
          .catch((e) => inbound.write(line({ jsonrpc: '2.0', id: f.id, error: { code: -32603, message: String(e && e.message || e) } })));
      }
    }
  });

  const conv = new HermesConversation({
    wire,
    identity: { profile: 'electron-fixture', sessionKey: 'e-key', sessionId: 'e-sess', reviewed: true },
  });
  const snap = await conv.bind({ expectedEpoch: EPOCH });
  assert.equal(snap.phase, 'bound');
  assert.equal(snap.attested.replayEpoch, EPOCH);

  // Foreign-session events never enter bound state.
  inbound.write(line({ jsonrpc: '2.0', method: 'event',
    params: { type: 'message.delta', session_id: 'other-sess', seq: 1, payload: { text: 'FOREIGN' } } }));
  await new Promise((r) => setImmediate(r));
  assert.equal(conv.getState().turn, null);
  assert.equal(conv.getState().stats.foreignEvents, 1);

  // Literal send + streamed deltas through controller state.
  conv.setDraft('keep **literal** `markup`');
  await conv.send('send `<verbatim>` text');
  assert.equal(conv.getState().draft.text, 'keep **literal** `markup`'); // unrelated draft survives
  const s1 = conv.getState();
  assert.equal(s1.turn.text, 'part one `<tag>`');
  assert.equal(s1.transcript[0].text, 'send `<verbatim>` text');

  // Server→client clarify request: exact-id explicit answer, single-use.
  inbound.write(line({ jsonrpc: '2.0', id: 'srq-e1', method: 'clarify',
    params: { session_id: 'e-sess', questions: [{ qid: 'q0', question: 'Pick?' }] } }));
  await new Promise((r) => setImmediate(r));
  const pend = conv.getState().pendingRequests[0];
  assert.equal(pend.id, 'srq-e1');
  assert.equal(pend.supported, true);
  await conv.answerRequest('srq-e1', { answers: { q0: 'Fig' } });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(received.find((f) => f.id === 'srq-e1').result, { answers: { q0: 'Fig' } });
  await assert.rejects(conv.answerRequest('srq-e1', {}), (e) => e.code === 'unknown_request');

  // stop() is an RPC; the turn ends on the terminal event.
  await conv.stop();
  assert.equal(conv.getState().lastInterrupt.status, 'interrupted');
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(conv.getState().turn, null);
  assert.equal(conv.getState().transcript.at(-1).status, 'interrupted');

  // EOF → disconnected; dispose detaches only this controller.
  inbound.end();
  await new Promise((r) => setImmediate(r));
  assert.equal(conv.getState().phase, 'disconnected');
  conv.dispose();
  assert.equal(conv.getState().phase, 'disposed');
  assert.equal(conv.getState().draft.text, 'keep **literal** `markup`');

  clearInterval(keepAlive);
  console.log('ELECTRON-CONVERSATION-PASS', process.version);
}

main().catch((e) => { console.error(e); process.exit(1); });
