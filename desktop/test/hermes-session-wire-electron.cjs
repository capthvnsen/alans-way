'use strict';
// Electron-as-Node24 compatibility check for the session-wire adapter.
// Runs under `ELECTRON_RUN_AS_NODE=1 electron <this file>` (spawned by
// hermes-session-wire.test.cjs). Plain asserts — exits nonzero on failure.
const assert = require('node:assert/strict');
const { PassThrough, Writable } = require('node:stream');
const { HermesSessionWire, WireError } = require('../src/hermes-session-wire.cjs');

async function main() {
  // The wire's timers are unref'd by contract: a pending call/send never keeps
  // the host alive. This script owns its liveness with one ref'd interval.
  const keepAlive = setInterval(() => {}, 1000);
  const inbound = new PassThrough();
  const outbound = new PassThrough();
  const wire = new HermesSessionWire({ input: inbound, output: outbound });
  const sent = [];
  let rest = '';
  outbound.on('data', (c) => {
    rest += c.toString('utf8');
    let i;
    while ((i = rest.indexOf('\n')) >= 0) { sent.push(JSON.parse(rest.slice(0, i))); rest = rest.slice(i + 1); }
  });

  // Interleaved calls resolved out of order by exact id.
  const a = wire.call('session.list');
  const b = wire.call('ping');
  await new Promise((r) => setImmediate(r));
  assert.equal(sent.length, 2);
  // Reply to the second call first, using the ids we actually observed.
  inbound.write(JSON.stringify({ jsonrpc: '2.0', id: sent[1].id, result: { pong: true } }) + '\n');
  inbound.write(JSON.stringify({ jsonrpc: '2.0', id: sent[0].id, result: { sessions: ['s1'] } }) + '\n');
  assert.deepEqual(await a, { sessions: ['s1'] });
  assert.deepEqual(await b, { pong: true });
  assert.deepEqual(sent.map((f) => f.method), ['session.list', 'ping']);

  // Server request surfaced; explicit answer once; refusal rejects.
  const srP = new Promise((r) => wire.once('serverRequest', r));
  inbound.write(JSON.stringify({ jsonrpc: '2.0', id: 'srq-1', method: 'clarify', params: { session_id: 's1', questions: [{ qid: 'q0' }] } }) + '\n');
  const sr = await srP;
  assert.equal(sr.id, 'srq-1');
  assert.equal(sr.sessionId, 's1');
  await wire.answerServerRequest('srq-1', { answers: { q0: 'Apple' } });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(sent[2], { jsonrpc: '2.0', id: 'srq-1', result: { answers: { q0: 'Apple' } } });
  await assert.rejects(wire.answerServerRequest('srq-1', {}), (e) => e instanceof WireError && e.code === 'unknown_request');

  // UTF-8 event + EOF settlement.
  const evtP = new Promise((r) => wire.once('event', r));
  inbound.write(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'message.delta', session_id: 's1', seq: 1, payload: { text: 'é—界' } } }) + '\n');
  const evt = await evtP;
  assert.equal(evt.payload.text, 'é—界');
  const pending = wire.call('ping');
  inbound.end();
  await assert.rejects(pending, (e) => e.code === 'eof');

  // Typed send_timeout reaches pending callers (not a masked 'failed').
  const stuck = new Writable({ write(_c, _e, _cb) { /* never flushes */ } });
  const wire2 = new HermesSessionWire({ input: new PassThrough(), output: stuck, sendTimeoutMs: 30 });
  await assert.rejects(wire2.call('ping'), (e) => e instanceof WireError && e.code === 'send_timeout');
  assert.equal(wire2.state, 'failed');
  clearInterval(keepAlive);
  console.log('ELECTRON-WIRE-PASS', process.version);
}

main().catch((e) => { console.error(e); process.exit(1); });
