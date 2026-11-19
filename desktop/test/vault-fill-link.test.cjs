'use strict';
process.env.HERMES_WORKSPACE_ALLOW_LOOPBACK = '1'; // loopback fixtures under HERMES_WORKSPACE_REQUIRE_TAILNET=1, as the other hermes tests
// The vault requests over a fake Hermes connection: the REAL wire, link and controller run over in-memory
// streams against the shared gateway engine, and the fake Hermes pushes the server requests a real one sends
// (preview.act with action "vault", vault.code, vault.unlock_prompt). No sockets, no Electron.
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { HermesSessionWire } = require('../src/hermes-session-wire.cjs');
const { createGatewayLink } = require('../src/gateway-link.cjs');
const { createVaultFill } = require('../src/vault-fill.cjs');
const { createGatewayEngine } = require('./hermes-gateway-engine.cjs');
const { PW, ORIGIN, inspectJs, fillJs, makeTab } = require('./vault-fixtures.cjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(pred, ms = 3000, what = 'condition') {
  const end = Date.now() + ms;
  while (!pred()) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await sleep(2); }
}

function memConn(engine) {
  const input = new PassThrough(), output = new PassThrough();
  input.on('error', () => {});
  const wire = new HermesSessionWire({ input, output });
  const peer = engine.connect((o) => { if (!input.destroyed) input.write(`${JSON.stringify(o)}\n`); });
  const conn = { wire, input, epoch: engine.epoch(), answers: [], closed: false,
    push: (frame) => input.write(`${JSON.stringify({ jsonrpc: '2.0', ...frame })}\n`),
    close: () => { if (!conn.closed) { conn.closed = true; engine.disconnect(peer); } } };
  let rest = '';
  output.on('data', (chunk) => {
    rest += chunk.toString('utf8');
    let i;
    while ((i = rest.indexOf('\n')) >= 0) {
      const f = JSON.parse(rest.slice(0, i)); rest = rest.slice(i + 1);
      if (f.method === undefined && f.id !== undefined) { conn.answers.push(f); continue; } // an answer to a server request
      if (f.id === undefined) continue;
      Promise.resolve(engine.handle(peer, f)).then((r) => { if (r !== undefined && !input.destroyed) input.write(`${JSON.stringify({ jsonrpc: '2.0', id: f.id, ...r })}\n`); });
    }
  });
  setImmediate(() => input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'gateway.ready', payload: { replay_epoch: engine.epoch() } } })}\n`));
  return conn;
}

const live = [];
afterEach(() => { for (const stop of live.splice(0)) stop(); });

async function rig({ vault } = {}) {
  const engine = createGatewayEngine({ orphanGraceMs: 5000, deltaCount: 1, deltaMs: 1 });
  const conns = [], logs = [], requests = [], closed = [];
  const link = createGatewayLink({ open: async () => { const c = memConn(engine); conns.push(c); return c; },
    log: (event, fields) => logs.push([event, fields]), ...(vault ? { vault } : {}),
    options: { baseMs: 5, capMs: 20, stableMs: 40, pingIdleMs: 1e9, pingDeadMs: 50, connectTimeoutMs: 500, bindTimeoutMs: 500 } });
  link.on('request', (r) => requests.push(r)); link.on('requestClosed', (r) => closed.push(r));
  live.push(() => { link.stop(); engine.close(); });
  link.start();
  await until(() => link.isLive(), 3000, 'live');
  await link.attach('key-1');
  return { engine, link, conns, logs, requests, closed, conn: () => conns.at(-1) };
}
const vaultRequest = (id, vault, session = 'sess-1') => ({ id, method: 'preview.act', params: { session_id: session, action: 'vault', vault } });
const answer = (r, id) => r.conn().answers.find((a) => a.id === id);

test('a vault fill request is answered by the vault handler and never held by the controller', async () => {
  const seen = [];
  const vault = { handle: async (req) => { seen.push({ ...req, expression: req.params.vault.expression }); req.params.vault.expression = ''; return { value: '{"success":true,"result":"{\\"filled\\":1}"}' }; } };
  const r = await rig({ vault });
  r.conn().push(vaultRequest('srv-1', { operation: 'evaluate', target: 'tt', expression: `fill ${PW}` }));
  await until(() => answer(r, 'srv-1'), 3000, 'the answer');
  assert.deepEqual(answer(r, 'srv-1'), { jsonrpc: '2.0', id: 'srv-1', result: { value: '{"success":true,"result":"{\\"filled\\":1}"}' } });
  assert.deepEqual([seen[0].storedId, seen[0].sessionId], ['key-1', 'sess-1'], 'attributed to the conversation the link attached');
  assert.equal(seen[0].expression, `fill ${PW}`);
  assert.deepEqual(r.link.pending('key-1'), [], 'the controller holds no request');
  assert.equal(JSON.stringify(r.link.getState()).includes('CANARY'), false);
  assert.equal(JSON.stringify([r.requests, r.closed, r.logs]).includes('CANARY'), false, 'nothing the link emitted or logged carries the password');
});

test('a real fill: open, inspect, Allow, fill, over the link, with no trace of the password', async () => {
  const tab = makeTab({ botId: 'alan' });
  const asks = [];
  const vault = createVaultFill({ botFor: (storedId) => (storedId === 'key-1' ? 'alan' : ''), nameFor: () => 'Alan', listTabs: () => [tab],
    ask: async (info) => { asks.push(info); return true; }, log: (event, fields) => r.logs.push([event, fields]) });
  const r = await rig({ vault });
  const call = async (id, v) => {
    r.conn().push(vaultRequest(id, v));
    await until(() => answer(r, id), 3000, id);
    return JSON.parse(answer(r, id).result.value);
  };
  const opened = await call('a1', { operation: 'open' });
  assert.equal(opened.success, true);
  assert.equal((await call('a2', { operation: 'evaluate', target: opened.target, expression: 'window.location.href' })).result, `${ORIGIN}/`);
  assert.equal((await call('a3', { operation: 'evaluate', target: opened.target, expression: inspectJs() })).success, true);
  const filled = await call('a4', { operation: 'evaluate', target: opened.target, expression: fillJs() });
  assert.deepEqual([filled.success, filled.result], [true, '{"filled":1}']);
  assert.deepEqual(asks, [{ botId: 'alan', botName: 'Alan', origin: ORIGIN }]);
  assert.equal((await call('a5', { operation: 'close', target: opened.target })).success, true);
  const everything = JSON.stringify([r.conn().answers, r.logs, r.requests, r.closed, r.link.getState(), r.link.pending('key-1')]);
  assert.equal(everything.includes('CANARY'), false);
  assert.equal(tab.frame.ran.filter((c) => c.includes('CANARY')).length, 1, 'only the page ever received it');
});

test('one-time codes and unlock are refused as not supported yet, and the controller keeps nothing', async () => {
  const r = await rig({ vault: { handle: async () => { throw new Error('not for this'); } } });
  for (const [id, method] of [['c1', 'vault.code'], ['c2', 'vault.unlock_prompt'], ['c3', 'vault.save_login']]) {
    r.conn().push({ id, method, params: { session_id: 'sess-1', site: 'example.com' } });
    await until(() => answer(r, id), 3000, method);
    assert.equal(answer(r, id).error.code, -32601, method);
    assert.match(answer(r, id).error.message, /not supported yet/i, method);
  }
  assert.deepEqual(r.link.pending('key-1'), []);
});

test('without a vault handler a vault request is refused at once, not left to time out', async () => {
  const r = await rig();
  r.conn().push(vaultRequest('n1', { operation: 'open' }));
  await until(() => answer(r, 'n1'), 3000, 'refusal');
  assert.equal(answer(r, 'n1').error.code, -32601);
});

test('a vault request for a conversation the link has not attached is refused', async () => {
  let called = 0;
  const r = await rig({ vault: { handle: async () => { called++; return { value: '{}' }; } } });
  r.conn().push(vaultRequest('x1', { operation: 'open' }, 'sess-2'));
  r.conn().push({ id: 'x2', method: 'preview.act', params: { action: 'vault', vault: { operation: 'open' } } });
  await until(() => answer(r, 'x1') && answer(r, 'x2'), 3000, 'refusals');
  assert.ok(answer(r, 'x1').error && answer(r, 'x2').error);
  assert.equal(called, 0);
});

test('a withdrawn request or a dropped connection closes the prompt', async () => {
  const signals = [];
  const vault = { handle: ({ signal }) => new Promise((resolve) => { signals.push(signal); signal.addEventListener('abort', () => resolve({ value: '{"success":false}' })); }) };
  const r = await rig({ vault });
  r.conn().push(vaultRequest('w1', { operation: 'evaluate', target: 't', expression: 'x' }));
  await until(() => signals.length === 1, 3000, 'handler');
  assert.equal(signals[0].aborted, false);
  r.conn().push({ method: 'event', params: { type: 'request.cancel', session_id: 'sess-1', payload: { id: 'w1', method: 'preview.act', reason: 'interrupted' } } });
  await until(() => signals[0].aborted, 3000, 'abort on withdraw');
  r.conn().push(vaultRequest('w2', { operation: 'evaluate', target: 't', expression: 'x' }));
  await until(() => signals.length === 2, 3000, 'second handler');
  r.conn().input.destroy(new Error('reset'));
  await until(() => signals[1].aborted, 3000, 'abort on drop');
});
