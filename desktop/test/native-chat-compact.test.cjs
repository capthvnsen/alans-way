'use strict';
process.env.HERMES_WORKSPACE_ALLOW_LOOPBACK = '1'; // loopback fixtures under HERMES_WORKSPACE_REQUIRE_TAILNET=1, as the other hermes tests
// Compacting before a send: native chat over the real gateway link, the real wire and the shared fake Hermes gateway
// (hermes-gateway-engine.cjs, which answers session.usage and session.compress as the tui gateway does). No sockets, no Electron.
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createGatewayLink } = require('../src/gateway-link.cjs');
const { createGatewayApi } = require('../src/gateway-api.cjs');
const { createNativeChat } = require('../src/native-chat.cjs');
const { shouldCompact } = require('../src/compact-policy.cjs');
const { createGatewayEngine, memConn } = require('./hermes-gateway-engine.cjs');

const SID = 'api_1', MIN = 60 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(pred, what, ms = 5000) {
  const end = Date.now() + ms;
  while (!pred()) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await sleep(2); }
}

const cleanup = [];
afterEach(() => { for (const fn of cleanup.splice(0)) fn(); });

// Hermes with one conversation (SID) whose context is `context`; native chat with the websocket transport on a controllable clock.
async function rig({ context = { used: 160000, max: 200000 }, engine: engineCfg = {}, chat: chatCfg = {}, enabled = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-chat-compact-'));
  const engine = createGatewayEngine({ sessions: [{ id: 'sess-1', session_key: SID, title: 'One', profile: 'default' }], context, deltaCount: 2, ...engineCfg });
  const server = { gate: null, conns: [] };
  const link = createGatewayLink({
    open: async () => { if (server.gate) await server.gate; const c = memConn(engine); server.conns.push(c); return c; },
    options: { baseMs: 5, capMs: 40, pingIdleMs: 1e9, offlinePollMs: 10, connectTimeoutMs: 500, bindTimeoutMs: 500 },
  });
  const rest = {
    listSessions: async () => ({ data: [{ id: SID, source: 'api_server', title: 'One' }] }),
    getMessages: async () => ({ data: engine.history(SID).slice().reverse() }),
    streamChat: async () => { throw new Error('the REST path must not be used'); },
  };
  const clock = { ms: Date.now() };
  const flags = { enabled };
  const chat = createNativeChat({ dir, retryMs: 10, now: () => clock.ms, compactEnabled: () => flags.enabled,
    apiFactory: () => createGatewayApi({ rest, link, transport: () => 'websocket' }),
    loadConfig: () => ({ baseUrl: 'http://127.0.0.1:8642', key: 'k'.repeat(20), lastSessionId: SID, sessions: [{ id: SID, source: 'api_server', title: 'One' }] }), ...chatCfg });
  cleanup.push(() => { link.stop(); engine.close(); });
  link.start();
  await until(() => link.getState().state === 'live', 'the link to go live');
  return { engine, link, chat, clock, flags, server, dir,
    cards: () => (chat.getState().cards || []).filter((c) => c.kind === 'compact').map((c) => `${c.state}:${c.text}`),
    rows: () => chat.getState().thread.messages.map((m) => `${m.role}:${m.text}:${m.state || 'server'}`),
    idle: () => chat.getState().run === null && chat.getState().thread.messages.every((m) => typeof m.id === 'number') };
}

test('over the limit: the chip applies, the conversation is compacted, then the message goes', async () => {
  const r = await rig();
  await until(() => r.chat.getState().compact, 'Hermes to report the context size');
  const c = r.chat.getState().compact;
  assert.deepEqual([c.usedTokens, c.windowTokens], [160000, 200000]);
  assert.equal(shouldCompact({ ...c, idleMs: 0 }), 'high');
  await r.chat.command('send', { sessionId: SID, text: 'hello' });
  await until(() => r.engine.submits.length === 1 && r.idle(), 'the message to go and the reply to finish');
  assert.equal(r.engine.compresses.length, 1);
  assert.ok(r.engine.compresses[0].at <= r.engine.submits[0].at, 'compacted before the message was submitted');
  assert.deepEqual(r.cards(), ['done:Conversation compacted']);
  assert.deepEqual(r.engine.history(SID).map((m) => `${m.role}:${m.content}`), ['user:hello', 'assistant:w0 w1 ']);
  assert.equal(r.chat.getState().compact.usedTokens, 32000, 'the new, smaller context is what the chip reads afterwards');
});

test('turned off for this message: it goes without compacting, and the next message is evaluated afresh', async () => {
  const r = await rig({ engine: { contextPerTurn: 0, compressTo: 0.9 } });
  await until(() => r.chat.getState().compact, 'usage');
  await r.chat.command('send', { sessionId: SID, text: 'one', compact: false });
  await until(() => r.engine.submits.length === 1 && r.idle(), 'the first message');
  assert.equal(r.engine.compresses.length, 0);
  assert.deepEqual(r.cards(), []);
  await r.chat.command('send', { sessionId: SID, text: 'two' });
  await until(() => r.engine.submits.length === 2 && r.idle(), 'the second message');
  assert.equal(r.engine.compresses.length, 1, 'the opt-out was for one message only');
});

test('a compaction that fails still sends the message, with a one-line note', async () => {
  const r = await rig({ engine: { compressFails: 'summary model unavailable' } });
  await until(() => r.chat.getState().compact, 'usage');
  await r.chat.command('send', { sessionId: SID, text: 'hello' });
  await until(() => r.engine.submits.length === 1 && r.idle(), 'the message to go anyway');
  assert.equal(r.engine.compresses.length, 1);
  assert.deepEqual(r.cards(), ['failed:Could not compact, so the message was sent as it is.']);
  assert.equal(r.engine.history(SID)[0].content, 'hello');
});

test('a compaction past its deadline is given up on and the message goes; Hermes queues it behind the compaction', async () => {
  const r = await rig({ engine: { compressMs: 300 }, chat: { compactDeadlineMs: 40 } });
  await until(() => r.chat.getState().compact, 'usage');
  await r.chat.command('send', { sessionId: SID, text: 'hello' });
  await until(() => r.engine.submits.length === 1, 'the message to go');
  assert.equal(r.engine.submits[0].queued, true, 'it arrived while the compaction was still running');
  assert.deepEqual(r.cards(), ['failed:Could not compact, so the message was sent as it is.']);
  await until(() => r.idle() && r.engine.history(SID).length === 2, 'Hermes to finish the compaction and answer');
  assert.equal(r.engine.compresses.length, 1);
});

test('Stop during the compaction cancels the wait: nothing is sent, the message stays as "Not sent", and Retry does not compact twice', async () => {
  const r = await rig({ engine: { compressMs: 250 } });
  await until(() => r.chat.getState().compact, 'usage');
  await r.chat.command('send', { sessionId: SID, text: 'hello' });
  await until(() => r.chat.getState().run?.status === 'compacting', 'the compaction to start');
  assert.deepEqual(r.cards(), ['working:Compacting conversation…']);
  await r.chat.command('stop', { sessionId: SID });
  await until(() => r.chat.getState().run === null, 'the stop to land');
  assert.deepEqual(r.rows(), ['user:hello:failed']);
  assert.deepEqual(r.cards(), ['failed:Compaction stopped.']);
  assert.equal(r.engine.submits.length, 0);
  await until(() => !r.engine.session('sess-1').compressing, 'Hermes to finish the compaction it was already running');
  const localId = r.chat.getState().thread.messages[0].id;
  await r.chat.command('retry', { sessionId: SID, localId });
  await until(() => r.engine.submits.length === 1 && r.idle(), 'the retry to go');
  assert.equal(r.engine.compresses.length, 1, 'the message is compacted for once only');
});

test('a message queued while Hermes is unreachable is judged when it is actually sent', async () => {
  const r = await rig({ context: { used: 60000, max: 200000 } });
  await until(() => r.chat.getState().compact, 'usage');
  await r.chat.command('send', { sessionId: SID, text: 'first' });
  await until(() => r.engine.submits.length === 1 && r.idle(), 'the first message');
  assert.equal(r.engine.compresses.length, 0, 'a warm cache at 30% needs no compaction');
  assert.equal(shouldCompact({ ...r.chat.getState().compact, idleMs: r.clock.ms - r.chat.getState().compact.idleSince }), null);
  let release; r.server.gate = new Promise((res) => { release = res; });
  r.server.conns.at(-1).reset();
  await until(() => r.link.getState().state !== 'live', 'the link to drop');
  await r.chat.command('send', { sessionId: SID, text: 'second' });
  await sleep(30);
  assert.equal(r.engine.submits.length, 1);
  assert.deepEqual(r.rows().at(-1), 'user:second:queued');
  r.clock.ms += 10 * MIN;
  const c = r.chat.getState().compact;
  assert.equal(shouldCompact({ ...c, idleMs: r.clock.ms - c.idleSince }), 'stale', 'ten minutes later the chip would say so');
  r.server.gate = null; release();
  await until(() => r.engine.submits.length === 2 && r.idle(), 'the queued message to go once Hermes is back');
  assert.equal(r.engine.compresses.length, 1, 'compacted at send time, on the state at that time');
  assert.ok(r.engine.compresses[0].at <= r.engine.submits[1].at);
  assert.deepEqual(r.cards(), ['done:Conversation compacted']);
});

test('an opt-out survives the queue: a queued message turned off for compaction goes uncompacted', async () => {
  const r = await rig();
  await until(() => r.chat.getState().compact, 'usage');
  let release; r.server.gate = new Promise((res) => { release = res; });
  r.server.conns.at(-1).reset();
  await until(() => r.link.getState().state !== 'live', 'the link to drop');
  await r.chat.command('send', { sessionId: SID, text: 'later', compact: false });
  r.chat.flush();
  assert.equal(JSON.parse(fs.readFileSync(path.join(r.dir, 'native-chat-queue', `${SID}.json`), 'utf8')).items[0].noCompact, true, 'the opt-out is saved with the message');
  r.server.gate = null; release();
  await until(() => r.engine.submits.length === 1 && r.idle(), 'the message to go');
  assert.equal(r.engine.compresses.length, 0);
});

test('the setting off: no chip, no compaction', async () => {
  const r = await rig({ enabled: false });
  await sleep(50);
  assert.equal(r.chat.getState().compact, null);
  await r.chat.command('send', { sessionId: SID, text: 'hello' });
  await until(() => r.engine.submits.length === 1 && r.idle(), 'the message');
  assert.equal(r.engine.compresses.length, 0);
  assert.deepEqual(r.cards(), []);
});

test('unknown context: no chip and no compaction on a guess', async () => {
  const r = await rig({ context: null });
  await sleep(50);
  assert.equal(r.chat.getState().compact, null);
  await r.chat.command('send', { sessionId: SID, text: 'hello' });
  await until(() => r.engine.submits.length === 1 && r.idle(), 'the message');
  assert.equal(r.engine.compresses.length, 0);
});

test('while a reply is running there is no chip and no second send, so nothing compacts mid-reply', async () => {
  const r = await rig({ engine: { deltaMs: 60, deltaCount: 5 }, enabled: false });
  await r.chat.command('send', { sessionId: SID, text: 'one' });
  await until(() => r.chat.getState().run, 'the reply to start');
  r.flags.enabled = true;
  assert.equal(r.chat.getState().compact, null);
  await assert.rejects(r.chat.command('send', { sessionId: SID, text: 'two' }), /Wait for the reply/);
  await until(() => r.idle(), 'the reply to finish');
  assert.equal(r.engine.compresses.length, 0);
});

// The prompt cache lives 5 minutes, or 1 hour on a Hermes configured so; the Settings choice decides which one "idle" means.
for (const [name, ttlMs, compresses] of [['5 minutes', 5 * MIN, 1], ['1 hour', 60 * MIN, 0]]) {
  test(`idle for 30 minutes with the cache lifetime at ${name}: ${compresses ? 'compacts' : 'does not compact'}`, async () => {
    const r = await rig({ context: { used: 60000, max: 200000 }, chat: { cacheTtlMs: () => ttlMs } });
    await until(() => r.chat.getState().compact, 'usage');
    await r.chat.command('send', { sessionId: SID, text: 'first' });
    await until(() => r.engine.submits.length === 1 && r.idle(), 'the first message');
    r.clock.ms += 30 * MIN;
    const c = r.chat.getState().compact;
    assert.equal(c.cacheTtlMs, ttlMs, 'the chip reads the same lifetime');
    assert.equal(shouldCompact({ ...c, idleMs: r.clock.ms - c.idleSince }), compresses ? 'stale' : null);
    await r.chat.command('send', { sessionId: SID, text: 'second' });
    await until(() => r.engine.submits.length === 2 && r.idle(), 'the second message');
    assert.equal(r.engine.compresses.length, compresses);
  });
}
