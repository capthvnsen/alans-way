'use strict';
// Focused unit suite for the public Hermes session-wire adapter. In-memory
// streams only — no native Hermes process here (see hermes-session-wire-native.cjs).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { PassThrough, Writable } = require('node:stream');
const { spawn } = require('node:child_process');
const { HermesSessionWire, WireError } = require('../src/hermes-session-wire.cjs');

const tick = () => new Promise((r) => setImmediate(r));
const line = (obj) => JSON.stringify(obj) + '\n';

function makeWire(limits) {
  const inbound = new PassThrough();  // peer → wire
  const outbound = new PassThrough(); // wire → peer
  const wire = new HermesSessionWire({ input: inbound, output: outbound, ...limits });
  const sent = [];
  let rest = '';
  outbound.on('data', (c) => {
    rest += c.toString('utf8');
    let i;
    while ((i = rest.indexOf('\n')) >= 0) { sent.push(JSON.parse(rest.slice(0, i))); rest = rest.slice(i + 1); }
  });
  return {
    wire, inbound, outbound, sent,
    feed: (obj) => inbound.write(line(obj)),
    feedRaw: (s) => inbound.write(s),
  };
}

const nextEvent = (wire, name, timeoutMs = 2000) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`timed out waiting for ${name}`)), timeoutMs);
  wire.once(name, (v) => { clearTimeout(timer); resolve(v); });
});

test('call/response correlates interleaved replies by exact id', async () => {
  const h = makeWire();
  const a = h.wire.call('session.list', { limit: 1 });
  const b = h.wire.call('ping');
  await tick();
  assert.deepEqual(h.sent.map((f) => [f.method, f.id]), [['session.list', 'w-1'], ['ping', 'w-2']]);
  // Reply out of order: b first, then a.
  h.feed({ jsonrpc: '2.0', id: 'w-2', result: { pong: true } });
  h.feed({ jsonrpc: '2.0', id: 'w-1', result: { sessions: [] } });
  assert.deepEqual(await b, { pong: true });
  assert.deepEqual(await a, { sessions: [] });
  h.wire.close();
});

test('remote error rejects with code detail, not a resolved value', async () => {
  const h = makeWire();
  const p = h.wire.call('session.create', { title: 'x' });
  await tick();
  h.feed({ jsonrpc: '2.0', id: 'w-1', error: { code: -32602, message: 'bad pair', data: { model: 'm' } } });
  await assert.rejects(p, (e) => e instanceof WireError && e.code === 'remote_error' && e.detail.code === -32602);
  h.wire.close();
});

test('split, coalesced and multi-byte-UTF8 frames decode correctly', async () => {
  const h = makeWire();
  const events = [];
  h.wire.on('event', (e) => events.push(e));
  const p = h.wire.call('ping');
  // One reply split mid-multibyte inside a 5-frame coalesced write.
  const payload = line({ jsonrpc: '2.0', method: 'event', params: { type: 'message.delta', session_id: 's1', seq: 1, payload: { text: 'héllo—世界' } } })
    + line({ jsonrpc: '2.0', method: 'event', params: { type: 'x', session_id: 's1', seq: 2 } });
  const bytes = Buffer.from(payload, 'utf8');
  const mid = bytes.indexOf(0x80); // inside a multibyte char
  h.feedRaw(bytes.subarray(0, mid));
  h.feedRaw(bytes.subarray(mid));
  await tick();
  assert.equal(events.length, 2);
  assert.equal(events[0].payload.text, 'héllo—世界');
  assert.equal(events[0].type, 'message.delta');
  assert.equal(events[0].seq, 1);
  // Reply arrives split at arbitrary byte boundary.
  const reply = Buffer.from(line({ jsonrpc: '2.0', id: 'w-1', result: { pong: true } }), 'utf8');
  h.feedRaw(reply.subarray(0, 5));
  h.feedRaw(reply.subarray(5));
  assert.deepEqual(await p, { pong: true });
  h.wire.close();
});

test('wrong-id and duplicate replies never settle a pending call', async () => {
  const h = makeWire();
  const stray = [];
  h.wire.on('strayResponse', (r) => stray.push(r));
  const p = h.wire.call('ping', {}, { timeoutMs: 3000 });
  await tick();
  h.feed({ jsonrpc: '2.0', id: 'w-99', result: {} });            // unknown id
  h.feed({ jsonrpc: '2.0', id: 'w-1', result: { pong: true } }); // real reply
  h.feed({ jsonrpc: '2.0', id: 'w-1', result: { pong: 'dupe' } }); // duplicate after settle
  assert.deepEqual(await p, { pong: true });
  assert.equal(stray.length, 2);
  h.wire.close();
});

test('timeout rejects and a late reply is dropped, not delivered', async () => {
  const h = makeWire({ defaultTimeoutMs: 30 });
  const stray = [];
  h.wire.on('strayResponse', (r) => stray.push(r));
  await assert.rejects(h.wire.call('ping'), (e) => e.code === 'timeout');
  assert.equal(h.wire.pendingCalls.length, 0);
  h.feed({ jsonrpc: '2.0', id: 'w-1', result: { pong: true } });
  await tick();
  assert.equal(stray.length, 1);
  assert.equal(stray[0].id, 'w-1');
  h.wire.close();
});

test('abort signal settles the call without sending a cancel frame', async () => {
  const h = makeWire();
  const ac = new AbortController();
  const p = h.wire.call('prompt.submit', { session_id: 's' }, { signal: ac.signal });
  ac.abort();
  await assert.rejects(p, (e) => e.code === 'aborted');
  await tick();
  assert.equal(h.sent.length, 1, 'only the request frame went out; no fabricated cancel');
  assert.equal(h.sent[0].method, 'prompt.submit');
  h.wire.close();
});

test('EOF rejects every pending call and marks server requests dead', async () => {
  const h = makeWire();
  const reqs = [];
  h.wire.on('serverRequest', (r) => reqs.push(r));
  const p = h.wire.call('session.list');
  h.feed({ jsonrpc: '2.0', id: 'srq-1', method: 'clarify', params: { session_id: 's1', questions: [] } });
  await tick();
  h.inbound.end();
  await assert.rejects(p, (e) => e.code === 'eof');
  assert.equal(h.wire.state, 'eof');
  await assert.rejects(h.wire.answerServerRequest('srq-1', {}), (e) => e.code === 'unknown_request');
  await assert.rejects(h.wire.call('ping'), (e) => e.code === 'eof');
});

test('malformed JSON, ambiguous envelope and wrong version all fail closed', async () => {
  for (const bad of [
    '{"jsonrpc":"2.0",oops\n',
    JSON.stringify({ jsonrpc: '2.0', id: 'x', method: 'm', result: {} }) + '\n', // ambiguous
    JSON.stringify({ jsonrpc: '1.0', method: 'event', params: {} }) + '\n',
    JSON.stringify({ jsonrpc: '2.0', id: 'x' }) + '\n',                          // shapeless
    JSON.stringify(['not', 'an', 'object']) + '\n',
  ]) {
    const h = makeWire();
    const closed = nextEvent(h.wire, 'close');
    const p = h.wire.call('ping').then(
      () => { throw new Error('resolved unexpectedly'); },
      (e) => e);
    await tick();
    h.feedRaw(bad);
    const settled = await p;
    assert.equal(settled.code, 'failed');
    assert.equal(h.wire.state, 'failed');
    const note = await closed;
    assert.equal(note.state, 'failed');
    // Wire stays dead; nothing more is written or parsed.
    h.feedRaw(line({ jsonrpc: '2.0', id: 'w-1', result: {} }));
    h.wire.close();
  }
});

test('oversized inbound frame and runaway buffer are terminal', async () => {
  const h = makeWire({ maxFrameBytes: 64 });
  const p = h.wire.call('ping').then(() => 'resolved', (e) => e);
  await tick();
  h.feedRaw('{"jsonrpc":"2.0","method":"event","params":{"pad":"' + 'x'.repeat(128) + '"}}\n');
  const e = await p;
  assert.equal(e.code, 'failed');
  assert.equal(h.wire.state, 'failed');

  const h2 = makeWire({ maxBufferedBytes: 128 });
  const p2 = h2.wire.call('ping').then(() => 'resolved', (e2) => e2);
  await tick();
  h2.feedRaw('x'.repeat(200)); // no newline, over buffer cap
  assert.equal((await p2).code, 'failed');
});

test('oversized outbound call rejects before any byte is written', async () => {
  const h = makeWire({ maxFrameBytes: 256 });
  const big = 'x'.repeat(4096);
  await assert.rejects(h.wire.call('prompt.submit', { session_id: 's', text: big }), (e) => e.code === 'oversized_out');
  assert.equal(h.sent.length, 0);
  assert.equal(h.wire.state, 'open');
  h.wire.close();
});

test('invalid UTF-8 inbound frame is terminal', async () => {
  const h = makeWire();
  const closed = nextEvent(h.wire, 'close');
  h.feedRaw(Buffer.concat([Buffer.from('{"jsonrpc":"2.0","method":"e","params":{"t":"'), Buffer.from([0xff, 0xfe]), Buffer.from('"}}\n')]));
  const note = await closed;
  assert.equal(note.state, 'failed');
});

test('server requests surface verbatim and answer exactly once', async () => {
  const h = makeWire();
  const got = [];
  h.wire.on('serverRequest', (r) => got.push(r));
  h.feed({ jsonrpc: '2.0', id: 'srq-aa', method: 'clarify', params: { session_id: 'sess-A', questions: [{ qid: 'q0', question: 'Pick?' }] } });
  h.feed({ jsonrpc: '2.0', id: 'srq-bb', method: 'approval', params: { session_id: 'sess-B', request_id: 'r1', command: 'rm -rf /tmp/x' } });
  await tick();
  assert.equal(got.length, 2);
  assert.equal(got[0].sessionId, 'sess-A');
  assert.equal(got[1].method, 'approval');
  assert.deepEqual(h.wire.pendingServerRequests.map((r) => r.id), ['srq-aa', 'srq-bb']);
  // Answer the SECOND first — order is the caller's.
  await h.wire.answerServerRequest('srq-bb', { choice: 'deny' });
  await h.wire.answerServerRequest('srq-aa', { answers: { q0: 'Apple' } });
  await tick();
  assert.deepEqual(h.sent[0], { jsonrpc: '2.0', id: 'srq-bb', result: { choice: 'deny' } });
  assert.deepEqual(h.sent[1], { jsonrpc: '2.0', id: 'srq-aa', result: { answers: { q0: 'Apple' } } });
  // Single-use: a second answer to either is refused without writing.
  await assert.rejects(h.wire.answerServerRequest('srq-aa', { answers: {} }), (e) => e.code === 'unknown_request');
  await assert.rejects(h.wire.refuseServerRequest('srq-bb'), (e) => e.code === 'unknown_request');
  // And ids we never saw are refused without writing.
  await assert.rejects(h.wire.answerServerRequest('srq-zz', {}), (e) => e.code === 'unknown_request');
  assert.equal(h.sent.length, 2);
  h.wire.close();
});

test('refuseServerRequest emits an explicit JSON-RPC error, never a fake result', async () => {
  const h = makeWire();
  h.feed({ jsonrpc: '2.0', id: 'srq-1', method: 'sudo', params: { session_id: 's', command: 'sudo x' } });
  await tick();
  await h.wire.refuseServerRequest('srq-1', { code: -32601, message: 'unsupported' });
  await tick();
  assert.equal(h.sent[0].id, 'srq-1');
  assert.equal(h.sent[0].error.code, -32601);
  assert.ok(!('result' in h.sent[0]));
  h.wire.close();
});

test('request.cancel withdraws one open request only', async () => {
  const h = makeWire();
  const withdrawn = [];
  h.wire.on('serverRequestWithdrawn', (r) => withdrawn.push(r));
  h.feed({ jsonrpc: '2.0', id: 'srq-1', method: 'clarify', params: { session_id: 's1', questions: [] } });
  h.feed({ jsonrpc: '2.0', id: 'srq-2', method: 'clarify', params: { session_id: 's1', questions: [] } });
  await tick();
  h.feed({ jsonrpc: '2.0', method: 'event', params: { type: 'request.cancel', session_id: 's1', seq: 9, payload: { id: 'srq-1', method: 'clarify', reason: 'interrupted' } } });
  await tick();
  assert.equal(withdrawn.length, 1);
  assert.equal(withdrawn[0].id, 'srq-1');
  await assert.rejects(h.wire.answerServerRequest('srq-1', {}), (e) => e.code === 'unknown_request');
  // srq-2 is still open and answerable.
  await h.wire.answerServerRequest('srq-2', { answers: {} });
  await tick();
  assert.equal(h.sent[0].id, 'srq-2');
  h.wire.close();
});

test('duplicate server request id fails the wire closed', async () => {
  const h = makeWire();
  h.feed({ jsonrpc: '2.0', id: 'srq-1', method: 'clarify', params: { session_id: 's' } });
  await tick();
  h.feed({ jsonrpc: '2.0', id: 'srq-1', method: 'clarify', params: { session_id: 's' } });
  await tick();
  assert.equal(h.wire.state, 'failed');
});

test('pending caps fail closed instead of growing unbounded', async () => {
  const h = makeWire({ maxPendingCalls: 2 });
  const held1 = h.wire.call('ping').then(() => 'resolved', (e) => e);
  const held2 = h.wire.call('ping').then(() => 'resolved', (e) => e);
  await assert.rejects(h.wire.call('ping'), (e) => e.code === 'queue_full');
  h.wire.close();
  assert.equal((await held1).code, 'closed');
  assert.equal((await held2).code, 'closed');

  const h2 = makeWire({ maxPendingServerRequests: 2 });
  h2.feed({ jsonrpc: '2.0', id: 'srq-1', method: 'clarify', params: {} });
  h2.feed({ jsonrpc: '2.0', id: 'srq-2', method: 'clarify', params: {} });
  await tick();
  h2.feed({ jsonrpc: '2.0', id: 'srq-3', method: 'clarify', params: {} });
  await tick();
  assert.equal(h2.wire.state, 'failed');
});

test('a wedged output fails the wire and its pending callers honestly', async () => {
  const stuck = new Writable({ write(_c, _e, _cb) { /* never flushes */ } });
  const inbound = new PassThrough();
  const wire = new HermesSessionWire({ input: inbound, output: stuck, sendTimeoutMs: 30 });
  const p = wire.call('ping');
  // The exact typed cause must reach the caller, not a generic 'failed':
  // the wire's terminal failure was a send timeout, and that is what settles
  // every pending call — including calls still queued behind the stuck write.
  const queued = wire.call('session.list');
  await assert.rejects(p, (e) => e instanceof WireError && e.code === 'send_timeout');
  await assert.rejects(queued, (e) => e instanceof WireError && e.code === 'send_timeout');
  assert.equal(wire.state, 'failed');
  assert.equal(wire.failReason, 'send timeout');
  assert.equal(wire.pendingCalls.length, 0);
  // Terminal: nothing further is writable or callable.
  await assert.rejects(wire.call('ping'), (e) => e.code === 'failed');
});

test('close() ends only the owned output; input peer is untouched', async () => {
  const h = makeWire();
  let inputEnded = false;
  h.inbound.on('end', () => { inputEnded = true; });
  const p = h.wire.call('ping');
  const outFinished = new Promise((r) => h.outbound.once('finish', r));
  h.wire.close();
  await assert.rejects(p, (e) => e.code === 'closed');
  await outFinished; // our writable saw end()
  await tick();
  assert.equal(inputEnded, false, 'peer input stream must not be ended by us');
  assert.equal(h.wire.state, 'closed');
});

test('call validation is synchronous and honest', async () => {
  const h = makeWire();
  await assert.rejects(h.wire.call(''), (e) => e.code === 'bad_method');
  await assert.rejects(h.wire.call('ping', 42), (e) => e.code === 'bad_params');
  await assert.rejects(h.wire.call('ping', {}, { timeoutMs: Number.NaN }), (e) => e.code === 'bad_timeout');
  await assert.rejects(h.wire.call('ping', {}, { timeoutMs: 0 }), (e) => e.code === 'bad_timeout');
  h.wire.close();
});

test('limits must be finite positive numbers', async () => {
  const inbound = new PassThrough(); const outbound = new PassThrough();
  for (const bad of [0, -1, Number.NaN, Infinity, '5', true]) {
    assert.throws(() => new HermesSessionWire({ input: inbound, output: outbound, maxFrameBytes: bad }), (e) => e.code === 'bad_limit');
  }
});

// Real stdio child: newline JSON-RPC echo over actual pipes through the adapter.
test('real child stdio round-trip, event and EOF', { timeout: 15000 }, async () => {
  const server = `const rl=require('node:readline').createInterface({input:process.stdin});
rl.on('line',(l)=>{try{const f=JSON.parse(l);
 if(f.method&&f.id!==undefined){process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'event',params:{type:'seen',session_id:'s',seq:1,payload:{m:f.method}}})+'\\n');
  if(f.method==='shutdown'){process.exit(0)}
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:f.id,result:{echo:f.method}})+'\\n')}
 else{process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'event',params:{type:'note'}})+'\\n')}}catch(e){process.exit(2)}});`;
  const child = spawn(process.execPath, ['-e', server], { stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    const wire = new HermesSessionWire({ input: child.stdout, output: child.stdin });
    const sawEvent = nextEvent(wire, 'event');
    assert.deepEqual(await wire.call('ping'), { echo: 'ping' });
    const evt = await sawEvent;
    assert.equal(evt.type, 'seen');
    assert.equal(evt.payload.m, 'ping');
    const open = wire.call('never-answered', {}, { timeoutMs: 5000 });
    wire.close(); // ends child stdin -> EOF on its readline -> process exits
    await assert.rejects(open, (e) => e.code === 'closed');
    const code = await new Promise((r) => child.once('exit', r));
    assert.equal(code, 0);
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
  }
});

// Electron-as-Node24 compatibility: run the shared compat script under the
// embedded Node runtime of the vendored Electron binary.
test('module works under Electron-as-Node (embedded Node 24)', { timeout: 30000 }, async (t) => {
  let electron;
  try { electron = require('electron'); } catch { electron = null; }
  if (!electron || typeof electron !== 'string' || !fs.existsSync(electron)) {
    t.skip('electron binary unavailable');
    return;
  }
  const script = path.join(__dirname, 'hermes-session-wire-electron.cjs');
  const child = spawn(electron, [script], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '', err = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { err += c; });
  const code = await new Promise((r) => child.once('exit', r));
  assert.equal(code, 0, `electron-as-node run failed: ${err}\n${out}`);
  assert.match(out, /ELECTRON-WIRE-PASS/);
});
