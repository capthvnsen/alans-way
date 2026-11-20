'use strict';
process.env.HERMES_WORKSPACE_ALLOW_LOOPBACK = '1'; // loopback fixtures under HERMES_WORKSPACE_REQUIRE_TAILNET=1, as the other hermes tests
// The adapter and native chat over a scripted link: event names map to what
// native chat already handles, a gap reloads history with a note, the link
// state shows in getState, and with no gateway the SSE path is untouched.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createNativeChat } = require('../src/native-chat.cjs');
const { createGatewayApi } = require('../src/gateway-api.cjs');
const { LinkError } = require('../src/gateway-link.cjs');

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
async function until(pred, what, ms = 5000) {
  const end = Date.now() + ms;
  while (!pred()) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await tick(2); }
}

function fakeLink(state = 'live') {
  const link = new EventEmitter();
  link.s = { state, since: Date.now() };
  link.getState = () => ({ ...link.s });
  link.submit = async (id, text) => { link.sent = [...(link.sent || []), [id, text]]; if (link.s.state !== 'live') throw new LinkError('not_live', 'x'); return { status: 'streaming' }; };
  link.attach = async () => {};
  link.interrupt = async () => {};
  link.pending = () => [];
  link.answer = async (id, rid, result) => { link.answered = [id, rid, result]; };
  link.setState = (next) => { link.s = { state: next, since: Date.now() }; link.emit('state', link.getState()); };
  link.ev = (type, seq, payload = {}, storedId = 'api_1') => link.emit('event', { storedId, type, seq, payload });
  return link;
}
const rows = [{ id: 1, role: 'user', content: 'hi', timestamp: 10 }, { id: 2, role: 'assistant', content: 'pong', timestamp: 11 }];
function rig({ linkState = 'live', transport = 'websocket' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-api-'));
  const link = fakeLink(linkState);
  const sse = [];
  const rest = {
    listSessions: async () => ({ data: [{ id: 'api_1', source: 'api_server', title: 'One' }] }),
    getMessages: async () => ({ data: rows }),
    streamChat: async (id, text) => { sse.push([id, text]); },
    getRun: async () => ({}),
  };
  let mode = transport;
  const chat = createNativeChat({ dir, apiFactory: () => createGatewayApi({ rest, link, transport: () => mode }),
    loadConfig: () => ({ baseUrl: 'http://127.0.0.1:8642', key: 'k'.repeat(20), lastSessionId: 'api_1', sessions: [{ id: 'api_1', source: 'api_server', title: 'One' }] }) });
  return { chat, link, sse, setMode: (m) => { mode = m; } };
}

test('a reply over the link maps to the events native chat already handles, in one run', async () => {
  const { chat, link } = rig();
  await chat.command('send', { sessionId: 'api_1', text: 'hi' });
  await tick();
  assert.deepEqual(link.sent, [['api_1', 'hi']]);
  link.ev('message.start', 1); link.ev('message.delta', 2, { text: 'po' }); link.ev('tool.start', 3, { name: 'terminal' });
  assert.equal(chat.getState().run.tool, 'Running a command');
  link.ev('tool.complete', 4, { name: 'terminal' }); link.ev('message.delta', 5, { text: 'ng' });
  assert.equal(chat.getState().run.text, 'pong');
  assert.equal(chat.getState().thread.messages.find((m) => m.state).state, 'sent');
  link.ev('message.complete', 6, { text: 'pong', status: 'complete' });
  await until(() => chat.getState().run === null && chat.getState().thread.messages.every((m) => typeof m.id === 'number'), 'the run to finish and history to load');
  assert.equal(chat.getState().thread.notice, '');
  assert.deepEqual(chat.getState().thread.messages.map((m) => m.text), ['hi', 'pong']);
});

// The real server streams only thinking.delta (and session.usage) until message.complete, seconds later.
// Native chat draws "Thinking" for any live run with no text and no tool (native-chat.js, renderLive),
// so the pending state is already there from the send; thinking.delta must not disturb it.
test('between the send and the first token the run is pending with no text, and thinking.delta leaves it so', async () => {
  const { chat, link } = rig();
  await chat.command('send', { sessionId: 'api_1', text: 'hi' });
  await until(() => chat.getState().run?.status === 'running', 'the run to be admitted');
  assert.deepEqual({ text: chat.getState().run.text, tool: chat.getState().run.tool }, { text: '', tool: '' });
  link.ev('message.start', 1); link.ev('thinking.delta', 2, { text: 'hm' }); link.ev('session.usage', 3, {});
  assert.deepEqual({ status: chat.getState().run.status, text: chat.getState().run.text, tool: chat.getState().run.tool }, { status: 'running', text: '', tool: '' });
  link.ev('message.complete', 4, { text: 'pong', status: 'complete' });
  await until(() => chat.getState().run === null, 'the run to finish');
});

test('a gap during a reply ends it with the history note and reloads from REST', async () => {
  const { chat, link } = rig();
  await chat.command('send', { sessionId: 'api_1', text: 'hi' });
  await tick();
  link.ev('message.delta', 1, { text: 'po' });
  link.emit('gap', { storedId: 'api_1', reason: 'truncated' });
  await until(() => chat.getState().run === null && chat.getState().thread.messages.every((m) => typeof m.id === 'number'), 'the gap to end the run and history to load');
  const t = chat.getState().thread;
  assert.equal(t.notice, 'Part of this reply was missed and was reloaded from history.');
  assert.deepEqual(t.messages.map((m) => m.id), [1, 2], 'history replaced the partial local reply');
  assert.equal(chat.getState().run, null);
});

test('a gap with no reply running reloads the thread quietly', async () => {
  const { chat, link } = rig();
  chat.getState();
  link.emit('gap', { storedId: 'api_1', reason: 'reaped' });
  await until(() => chat.getState().thread.messages.length === 2, 'history to reload');
  assert.deepEqual(chat.getState().thread.messages.map((m) => m.id), [1, 2]);
  assert.equal(chat.getState().thread.notice, '');
});

test('link state shows in getState; a send while the link is down waits and goes when it is live again', async () => {
  const { chat, link } = rig();
  assert.equal(chat.getState().link.state, 'live');
  link.setState('reconnecting');
  assert.equal(chat.getState().link.state, 'reconnecting');
  await chat.command('send', { sessionId: 'api_1', text: 'hi' });
  await tick(20);
  assert.deepEqual(chat.getState().thread.messages.map((m) => m.state), ['queued']);
  assert.equal(link.sent, undefined, 'nothing was written to the dead link');
  link.setState('live');
  await until(() => link.sent?.length === 1, 'the queued send to go once the link is live');
  assert.deepEqual(link.sent, [['api_1', 'hi']]);
});

test('every link state that cannot send queues; idle and stopped (no gateway) use REST', async () => {
  for (const state of ['connecting', 'reconnecting', 'syncing', 'offline', 'suspended', 'signin', 'refused']) {
    const { chat, link, sse } = rig({ linkState: state });
    await chat.command('send', { sessionId: 'api_1', text: 'hi' });
    await tick(10);
    assert.deepEqual(chat.getState().thread.messages.map((m) => m.state), ['queued'], state);
    assert.deepEqual([link.sent, sse], [undefined, []], state);
  }
  const { chat, sse } = rig({ linkState: 'idle' });
  await chat.command('send', { sessionId: 'api_1', text: 'hi' });
  await until(() => sse.length === 1, 'the REST send');
});

test('the client message id rides on prompt.submit', async () => {
  const { chat, link } = rig();
  let opts;
  link.submit = async (id, text, o) => { opts = o; return { status: 'streaming' }; };
  await chat.command('send', { sessionId: 'api_1', text: 'hi' });
  await until(() => opts, 'the submit');
  assert.match(opts.clientMessageId, /^[\w-]{8,64}$/);
});

test('approval and clarify arrive as requests; answers go back through the link', async () => {
  const { chat, link } = rig();
  await chat.command('send', { sessionId: 'api_1', text: 'hi' });
  await tick();
  link.emit('request', { storedId: 'api_1', request: { id: 7, method: 'approval', params: { command: 'ls', description: 'list', choices: ['once', 'deny'] } } });
  link.emit('request', { storedId: 'api_1', request: { id: 8, method: 'clarify', params: { questions: [{ qid: 'q1', question: 'Which?' }] } } });
  const cards = chat.getState().cards;
  assert.deepEqual(cards.map((c) => [c.kind, c.state]), [['approval', 'open'], ['clarify', 'open']]);
  await chat.command('approve', { sessionId: 'api_1', cardId: cards[0].id, choice: 'once' });
  assert.deepEqual(link.answered, ['api_1', '7', { choice: 'once' }]);
  link.emit('requestClosed', { storedId: 'api_1', id: '8' });
  assert.equal(chat.getState().cards[1].state, 'expired');
});

test('with the setting on sse, or no gateway configured, the REST+SSE path carries the send', async () => {
  const a = rig({ transport: 'sse' });
  await a.chat.command('send', { sessionId: 'api_1', text: 'hi' });
  await tick();
  assert.deepEqual(a.sse, [['api_1', 'hi']]);
  assert.equal(a.chat.getState().link, null);
  const b = rig({ linkState: 'idle' });
  await b.chat.command('send', { sessionId: 'api_1', text: 'yo' });
  await tick();
  assert.deepEqual(b.sse, [['api_1', 'yo']]);
  assert.equal(b.link.sent, undefined);
});

test('answers for a run that went over REST+SSE go to REST, not the link', async () => {
  const calls = [];
  const link = fakeLink('live');
  const rest = { answerApproval: async (...a) => { calls.push(['approval', ...a]); }, answerClarify: async (...a) => { calls.push(['clarify', ...a]); }, getRun: async () => ({ pending_controls: [] }), stopRun: async (id) => { calls.push(['stop', id]); } };
  const api = createGatewayApi({ rest, link });
  await api.answerApproval('run_9', { requestId: 'r', choice: 'once' });
  await api.answerClarify('run_9', { requestId: 'r', answer: 'a' });
  await api.stopRun('run_9');
  assert.deepEqual(calls.map((c) => c[0]), ['approval', 'clarify', 'stop']);
  assert.equal(link.answered, undefined);
});
