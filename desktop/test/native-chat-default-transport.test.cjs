'use strict';
process.env.HERMES_WORKSPACE_ALLOW_LOOPBACK = '1'; // loopback fixtures under HERMES_WORKSPACE_REQUIRE_TAILNET=1, as the other hermes tests
// Which transport native chat uses. Never chosen ('') means the WebSocket link once it works, and REST+SSE while it
// has never come up (older Hermes, signed out, refused address); 'websocket' and 'sse' are choices and are kept.
// Native chat over the real link, the real wire and the shared fake Hermes gateway. No sockets, no Electron.
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createGatewayLink } = require('../src/gateway-link.cjs');
const { createGatewayApi } = require('../src/gateway-api.cjs');
const { createNativeChat } = require('../src/native-chat.cjs');
const { createGatewayEngine, memConn } = require('./hermes-gateway-engine.cjs');

const SID = 'api_1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(pred, what, ms = 5000) {
  const end = Date.now() + ms;
  while (!pred()) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await sleep(2); }
}
const cleanup = [];
afterEach(() => { for (const fn of cleanup.splice(0)) fn(); });

// `fail`: the code open() throws while set (a Hermes with no /api/ws is 'unreachable'; signed out is 'needs_signin'); `gate`: open() waits for it first.
function rig({ transport = '', fail = '', gate = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-chat-transport-'));
  const engine = createGatewayEngine({ sessions: [{ id: 'sess-1', session_key: SID, title: 'One', profile: 'default' }], deltaCount: 2 });
  const server = { fail, gate, conns: [] };
  const link = createGatewayLink({
    open: async () => {
      if (server.gate) await server.gate;
      if (server.fail) throw Object.assign(new Error('refused'), { code: server.fail });
      const c = memConn(engine); server.conns.push(c); return c;
    },
    options: { baseMs: 5, capMs: 40, pingIdleMs: 1e9, offlinePollMs: 10, connectTimeoutMs: 500, bindTimeoutMs: 500 },
  });
  const rest = {
    listSessions: async () => ({ data: [{ id: SID, source: 'api_server', title: 'One' }] }),
    getMessages: async () => ({ data: engine.history(SID).slice().reverse() }),
    streamChat: async (id, text, { onEvent, clientMessageId }) => {
      rest.sent.push({ id, text, clientMessageId });
      engine.stored(SID).messages.push({ id: 100 + rest.sent.length, role: 'user', content: text, timestamp: Date.now() / 1000 });
      onEvent('run.started', { run_id: 'run_1' }); onEvent('run.completed', {});
    },
    getRun: async () => ({}), sent: [],
  };
  const chat = createNativeChat({ dir, retryMs: 10, apiFactory: () => createGatewayApi({ rest, link, transport: () => server.transport }),
    loadConfig: () => ({ baseUrl: 'http://127.0.0.1:8642', key: 'k'.repeat(20), lastSessionId: SID, sessions: [{ id: SID, source: 'api_server', title: 'One' }] }) });
  server.transport = transport;
  cleanup.push(() => { link.stop(); engine.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { engine, link, chat, rest, server, rows: () => chat.getState().thread.messages.map((m) => `${m.role}:${m.text}:${m.state || 'server'}`),
    idle: () => chat.getState().run === null && chat.getState().thread.messages.every((m) => typeof m.id === 'number') };
}

test('never chosen means the WebSocket: with a working link the message goes over it, not REST', async () => {
  const r = rig();
  r.link.start();
  await until(() => r.link.getState().state === 'live', 'the link');
  await r.chat.command('send', { sessionId: SID, text: 'hello' });
  await until(() => r.engine.submits.length === 1 && r.idle(), 'the message');
  assert.deepEqual(r.rest.sent, []);
});

test('an explicit sse is kept even with a working link', async () => {
  const r = rig({ transport: 'sse' });
  r.link.start();
  await until(() => r.link.getState().state === 'live', 'the link');
  await r.chat.command('send', { sessionId: SID, text: 'hello' });
  await until(() => r.rest.sent.length === 1 && r.idle(), 'the message');
  assert.equal(r.engine.submits.length, 0);
});

for (const [why, code, state] of [['Hermes has no WebSocket', 'unreachable', 'reconnecting'], ['the WebSocket is not signed in', 'needs_signin', 'signin']]) {
  test(`never chosen, and ${why}: the message goes over REST+SSE exactly once, with no banner or error`, async () => {
    let release; const gate = new Promise((res) => { release = res; });
    const r = rig({ fail: code, gate });
    r.link.start();
    await until(() => r.link.getState().state === 'connecting', 'the first attempt');
    await r.chat.command('send', { sessionId: SID, text: 'hello' });
    await sleep(40);
    assert.deepEqual([r.rest.sent.length, r.engine.submits.length], [0, 0], 'the first attempt is waited for, once');
    release();
    await until(() => r.rest.sent.length === 1 && r.idle(), 'the REST send');
    await sleep(80);
    assert.equal(r.link.getState().state, state);
    assert.equal(r.rest.sent.length, 1, 'not sent a second time');
    assert.match(r.rest.sent[0].clientMessageId, /^[\w-]{8,64}$/);
    assert.deepEqual([r.engine.submits.length, r.chat.getState().link, r.chat.getState().thread.notice], [0, null, '']);
    assert.deepEqual(r.rows(), ['user:hello:server']);
  });
}

test('never chosen: a link that stays down never holds a message; once Hermes can do it, the next one goes over the WebSocket', async () => {
  const r = rig({ fail: 'unreachable' });
  r.link.start();
  await until(() => r.link.getState().failures >= 2, 'the link to fail twice');
  await r.chat.command('send', { sessionId: SID, text: 'one' });
  await until(() => r.rest.sent.length === 1 && r.idle(), 'the REST send');
  r.server.fail = '';
  await until(() => r.link.getState().state === 'live', 'the link to come up');
  await r.chat.command('send', { sessionId: SID, text: 'two' });
  await until(() => r.engine.submits.length === 1 && r.idle(), 'the WebSocket send');
  assert.deepEqual([r.rest.sent.length, r.engine.submits[0].text], [1, 'two']);
});

test('never chosen, but the link worked and dropped: a message waits for it like a chosen WebSocket and is not sent over REST', async () => {
  const r = rig();
  r.link.start();
  await until(() => r.link.getState().state === 'live', 'the link');
  r.server.gate = new Promise((res) => { r.release = res; });
  r.server.conns.at(-1).reset();
  await until(() => r.link.getState().state !== 'live', 'the link to drop');
  await r.chat.command('send', { sessionId: SID, text: 'hello' });
  await sleep(60);
  assert.deepEqual([r.rest.sent.length, r.engine.submits.length, r.rows()], [0, 0, ['user:hello:queued']]);
  r.server.gate = null; r.release();
  await until(() => r.engine.submits.length === 1 && r.idle(), 'the message once the link is back');
  assert.equal(r.rest.sent.length, 0);
});

test('an explicit websocket keeps today: with the link down the message waits and is not sent over REST', async () => {
  const r = rig({ transport: 'websocket', fail: 'unreachable' });
  r.link.start();
  await until(() => r.link.getState().failures >= 2, 'the link to fail twice');
  await r.chat.command('send', { sessionId: SID, text: 'hello' });
  await sleep(60);
  assert.deepEqual([r.rest.sent.length, r.rows()], [0, ['user:hello:queued']]);
  assert.equal(r.chat.getState().link.state === 'live', false);
});
