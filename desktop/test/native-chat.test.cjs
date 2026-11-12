const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createNativeChat, mergeMessages, toMessage } = require('../src/native-chat.cjs');

const msg = (id, text = `m${id}`, extra = {}) => ({ id, role: id % 2 ? 'user' : 'assistant', text, ts: id, ...extra });
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test('mergeMessages merges by id, fresh rows win, order is by id, live locals stay last', () => {
  const cached = [msg(1), msg(2, 'old'), msg(4), { id: 'local-1', role: 'user', text: 'hi', state: 'sending' }, { id: 'local-2', role: 'user', text: 'x', state: 'sent' }];
  const merged = mergeMessages(cached, [msg(2, 'new'), msg(3), msg(5)], (m) => m.state === 'sending');
  assert.deepEqual(merged.map((m) => m.id), [1, 2, 3, 4, 5, 'local-1']);
  assert.equal(merged[1].text, 'new');
});

test('toMessage keeps user/assistant text only', () => {
  assert.deepEqual(toMessage({ id: 7, role: 'assistant', content: 'ok', timestamp: 3 }), { id: 7, role: 'assistant', text: 'ok', ts: 3 });
  for (const row of [{ id: 1, role: 'session_meta', content: null }, { id: 2, role: 'tool', content: '{}' }, { id: 3, role: 'assistant', content: '', tool_calls: [{}] }, { id: 'x', role: 'user', content: 'hi' }]) assert.equal(toMessage(row), null);
});

function fakeApi(overrides = {}) {
  const calls = [];
  const api = {
    calls,
    listSessions: async () => { calls.push('list'); return { data: [{ id: 'api_1', source: 'api_server', title: 'One' }, { id: 'telegram_1', source: 'telegram', title: 'TG' }] }; },
    getMessages: async (id) => { calls.push(`messages:${id}`); return { data: [{ id: 1, role: 'user', content: 'hello', timestamp: 1 }, { id: 2, role: 'assistant', content: 'pong', timestamp: 2 }, { id: 3, role: 'session_meta', content: null }] }; },
    ...overrides,
  };
  return api;
}

test('the last-open thread paints from the disk cache before any request', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-chat-'));
  fs.mkdirSync(path.join(dir, 'native-chat-cache'));
  fs.writeFileSync(path.join(dir, 'native-chat-cache', 'api_1.json'), JSON.stringify({ sessionId: 'api_1', messages: [msg(1, 'cached'), { id: 'bad' }] }));
  const api = fakeApi();
  const chat = createNativeChat({ dir, apiFactory: () => api, loadConfig: () => ({ baseUrl: 'http://127.0.0.1:8642', key: 'k'.repeat(20), lastSessionId: 'api_1', sessions: [{ id: 'api_1', source: 'api_server', title: 'One' }] }) });
  const state = chat.getState();
  assert.deepEqual(api.calls, []);
  assert.equal(state.thread.title, 'One');
  assert.deepEqual(state.thread.messages.map((m) => m.text), ['cached']);
  chat.activate();
  await tick(); await tick();
  assert.deepEqual(chat.getState().thread.messages.map((m) => m.text), ['hello', 'pong']);
  chat.flush();
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'native-chat-cache', 'api_1.json'), 'utf8'));
  assert.deepEqual(saved.messages.map((m) => m.id), [1, 2]);
  assert.equal(JSON.stringify(chat.getState()).includes('k'.repeat(20)), false, 'the key never reaches the projection');
});

test('pushes leave out unchanged thread messages', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-chat-'));
  const chat = createNativeChat({ dir, apiFactory: () => fakeApi(), loadConfig: () => ({ baseUrl: 'http://127.0.0.1:8642', key: 'k'.repeat(20), lastSessionId: 'api_1' }) });
  assert.ok(Array.isArray(chat.pushState().thread.messages));
  assert.equal(chat.pushState().thread.same, true);
});

test('send: optimistic bubble, streamed reply, reconcile with the server, read-only refused', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-chat-'));
  let emit, release;
  const api = fakeApi({
    streamChat: (_id, _text, { onEvent }) => { emit = onEvent; return new Promise((resolve) => { release = resolve; }); },
    getMessages: async () => ({ data: [{ id: 10, role: 'user', content: 'hi', timestamp: 10 }, { id: 11, role: 'assistant', content: 'pong: hi', timestamp: 11 }] }),
  });
  const chat = createNativeChat({ dir, apiFactory: () => api, loadConfig: () => ({ baseUrl: 'http://127.0.0.1:8642', key: 'k'.repeat(20), lastSessionId: 'api_1', sessions: [{ id: 'api_1', source: 'api_server' }, { id: 'telegram_1', source: 'telegram' }] }) });
  await chat.command('send', { sessionId: 'api_1', text: 'hi' });
  assert.deepEqual(chat.getState().thread.messages.map((m) => [m.text, m.state]), [['hi', 'sending']]);
  emit('run.started', { run_id: 'run_1' });
  emit('message.started', { message: { id: 'msg_1' } });
  emit('tool.started', { tool_name: 'terminal' });
  assert.equal(chat.getState().run.tool, 'Running a command');
  emit('tool.completed', { tool_name: 'terminal' });
  emit('assistant.delta', { delta: 'pong' }); emit('assistant.delta', { delta: ': hi' });
  emit('approval.request', { request_id: 'r1', execution_generation: 1, command: 'rm -rf /x', description: 'delete', choices: ['once', 'deny'] });
  const state = chat.getState();
  assert.equal(state.thread.messages[0].state, 'sent');
  assert.deepEqual([state.run.text, state.run.status], ['pong: hi', 'waiting']);
  assert.equal(state.sessions.find((s) => s.id === 'api_1').waiting, true);
  assert.deepEqual(state.cards.map((c) => [c.kind, c.state, c.choices]), [['approval', 'open', ['once', 'deny']]]);
  assert.equal(state.cards[0].requestId, undefined, 'request identity stays in main');
  emit('run.completed', { messages: [{ role: 'assistant', content: 'pong: hi' }] });
  release();
  await tick(); await tick();
  const after = chat.getState();
  assert.equal(after.run, null);
  assert.deepEqual(after.thread.messages.map((m) => [m.id, m.text]), [[10, 'hi'], [11, 'pong: hi']]);
  assert.equal(after.cards[0].state, 'expired');
  await assert.rejects(chat.command('send', { sessionId: 'telegram_1', text: 'x' }), /read-only/);
  await assert.rejects(chat.command('nope'), /Unknown/);
});

test('a send that never starts is marked failed and can be retried', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-chat-'));
  let attempts = 0;
  const api = fakeApi({ streamChat: async () => { attempts++; const e = new Error("Can't reach Hermes."); e.code = 'unreachable'; throw e; } });
  const chat = createNativeChat({ dir, apiFactory: () => api, loadConfig: () => ({ baseUrl: 'http://127.0.0.1:8642', key: 'k'.repeat(20), lastSessionId: 'api_1' }) });
  await chat.command('send', { sessionId: 'api_1', text: 'hi' });
  await tick();
  const failed = chat.getState().thread.messages[0];
  assert.equal(failed.state, 'failed');
  assert.equal(chat.getState().status, 'unreachable');
  await chat.command('retry', { sessionId: 'api_1', localId: failed.id });
  await tick();
  assert.equal(attempts, 2);
  assert.equal(chat.getState().thread.messages.length, 1);
});

test('show: a bot opens its remembered conversation, else the newest Telegram-source one or one made here; a gone id falls back', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-chat-'));
  const sessions = [{ id: 'telegram_1', source: 'telegram' }, { id: 'api_2', source: 'api_server' }, { id: 'api_1', source: 'api_server' }];
  const chat = createNativeChat({ dir, apiFactory: () => fakeApi(), loadConfig: () => ({ baseUrl: 'http://127.0.0.1:8642', key: 'k'.repeat(20), lastSessionId: 'api_1', sessions }) });
  chat.show({ sessionId: 'api_1', telegram: true }); assert.equal(chat.activeId, 'api_1');
  chat.show({ sessionId: 'gone', telegram: true }); assert.equal(chat.activeId, 'telegram_1');
  chat.show({ sessionId: 'gone' }); assert.equal(chat.activeId, 'api_2');
  assert.equal(chat.info('gone'), null);
  assert.deepEqual(chat.info('api_2'), { unread: false, waiting: false, preview: '' });
  chat.show({}); chat.activate();
  await tick(); await tick();
  assert.equal(chat.info('api_2').preview, 'pong', 'last assistant text once the thread is in memory');
});

test('the profile\'s Bot Chat is writable and shared; other Hermes Desktop or Telegram conversations stay read-only', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-chat-'));
  let emit, release;
  const sessions = [{ id: 'local-bot', source: 'local', title: 'Bot Chat' }, { id: 'local-2', source: 'local', title: 'Other' }, { id: 'telegram_1', source: 'telegram', title: 'Bot Chat' }];
  const api = fakeApi({ listSessions: async ({ title } = {}) => ({ data: title ? sessions.filter((s) => s.title === title) : sessions }), streamChat: (_id, _text, { onEvent }) => { emit = onEvent; return new Promise((resolve) => { release = resolve; }); } });
  const chat = createNativeChat({ dir, apiFactory: () => api, loadConfig: () => ({ baseUrl: 'http://127.0.0.1:8642', key: 'k'.repeat(20), lastSessionId: 'local-bot', sessions }) });
  const state = chat.getState();
  assert.deepEqual(state.sessions.map((s) => [s.id, s.readOnly, s.shared]), [['local-bot', false, true], ['local-2', true, false], ['telegram_1', true, false]]);
  assert.deepEqual([state.thread.readOnly, state.thread.shared], [false, true]);
  await assert.rejects(chat.command('send', { sessionId: 'local-2', text: 'x' }), /read-only/);
  await chat.command('send', { sessionId: 'local-bot', text: 'hello world' });
  emit('run.started', { run_id: 'run_b' }); emit('message.started', { message: { id: 'msg_b' } });
  emit('assistant.completed', { content: 'pong: hello world' }); emit('run.completed', {});
  release();
  await tick(); await tick();
  assert.equal(chat.getState().thread.notice, '');
});

test('the hidden Bot Chat comes from a title lookup and is pinned first', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-chat-'));
  const bot = { id: 'local-bot', source: 'local', title: 'Bot Chat', hidden: true, last_active: 1 };
  const asked = [];
  const api = fakeApi({ listSessions: async (params) => { asked.push(params); return { data: params.title ? [bot] : [{ id: 'api_1', source: 'api_server', title: 'One', last_active: 9 }, { ...bot }] }; } });
  const chat = createNativeChat({ dir, apiFactory: () => api, loadConfig: () => ({ baseUrl: 'http://127.0.0.1:8642', key: 'k'.repeat(20), lastSessionId: 'api_1' }) });
  await chat.command('refresh');
  assert.deepEqual(asked.find((p) => p.title), { limit: 1, title: 'Bot Chat', includeHidden: true });
  assert.deepEqual(chat.getState().sessions.map((s) => [s.id, s.shared]), [['local-bot', true], ['api_1', false]]);
});

test('a refused or queued turn says so in plain words', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-chat-'));
  const script = { refused: [['run.started', { run_id: 'r1' }], ['error', { message: 'permission_denied' }], ['done', {}]], queued: [['run.started', { run_id: 'r2' }], ['run.queued', { status: 'queued' }], ['done', {}]] };
  let next;
  const api = fakeApi({ streamChat: async (_id, _text, { onEvent }) => { for (const [name, data] of script[next]) onEvent(name, data); } });
  const chat = createNativeChat({ dir, apiFactory: () => api, loadConfig: () => ({ baseUrl: 'http://127.0.0.1:8642', key: 'k'.repeat(20), lastSessionId: 'api_1', sessions: [{ id: 'api_1', source: 'api_server' }] }) });
  next = 'refused'; await chat.command('send', { sessionId: 'api_1', text: 'x' }); await tick(); await tick();
  assert.equal(chat.getState().thread.notice, 'Hermes does not let this app write to that conversation.');
  next = 'queued'; await chat.command('send', { sessionId: 'api_1', text: 'y' }); await tick(); await tick();
  assert.match(chat.getState().thread.notice, /^Hermes queued this message/);
});

test('a conversation deleted in Hermes says so in its own thread, not as a connection error', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-chat-'));
  const gone = Object.assign(new Error('Session not found'), { code: 'http_404' });
  const chat = createNativeChat({ dir, apiFactory: () => fakeApi({ getMessages: async () => { throw gone; } }), loadConfig: () => ({ baseUrl: 'http://127.0.0.1:8642', key: 'k'.repeat(20), sessions: [{ id: 'api_1', source: 'api_server' }] }) });
  await chat.command('open', { sessionId: 'api_1' });
  await tick(); await tick();
  const state = chat.getState();
  assert.notEqual(state.status, 'error');
  assert.equal(state.thread.notice, 'This conversation was deleted in Hermes.');
});
