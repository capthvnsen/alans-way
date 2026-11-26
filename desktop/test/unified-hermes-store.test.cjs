const test = require('node:test');
const assert = require('node:assert/strict');
const { createUnifiedHermesStore } = require('../src/unified-hermes-store.cjs');

const apiError = (code, message, status = 0) => Object.assign(new Error(message), { name: 'ApiError', code, status });
const row = (sessionId, id, role, text, timestamp) => ({ id, session_id: sessionId, role, content: text, timestamp, tool_calls: null, tool_name: null, finish_reason: role === 'assistant' ? 'stop' : null, display_kind: null });
const session = (id, source, extra = {}) => ({ id, source, user_id: null, title: `${id} title`, started_at: 1, last_active: 2, preview: `${id} preview`, pinned: false, archived: false, hidden: false, is_internal_child: false, ...extra });

function fakeClient({ sessions = [], histories = {}, secret = '' } = {}) {
  const calls = [], failures = new Map();
  return {
    calls, failures, secret,
    async getMessages(id, { limit = 500, offset = 0, order = 'latest' } = {}) {
      calls.push({ method: 'getMessages', id, limit, offset, order });
      if (failures.has(id)) throw failures.get(id);
      const rows = histories[id] || [], end = Math.max(0, rows.length - offset);
      const data = rows.slice(Math.max(0, end - limit), end);
      return { object: 'list', session_id: id, data, pagination: { limit, offset, order, returned: data.length } };
    },
    async listSessions({ limit = 50, offset = 0, title, includeHidden } = {}) {
      calls.push({ method: 'listSessions', limit, offset, title, includeHidden });
      if (failures.has('sessions')) throw failures.get('sessions');
      let rows = sessions.filter((s) => !title || s.title === title);
      if (!(title && includeHidden)) rows = rows.filter((s) => !s.hidden);
      return { object: 'list', data: rows.slice(offset, offset + limit), limit, offset, has_more: rows.length > offset + limit };
    },
  };
}

const bindings = { telegramSessionId: 'telegram_1', hermesSessionId: 'local_1', nativeSessionId: 'api_1' };

test('refresh loads all bound lanes and snapshot merges their messages in time order', async () => {
  const client = fakeClient({ histories: {
    telegram_1: [row('telegram_1', 1, 'user', 'telegram question', 10), row('telegram_1', 2, 'assistant', 'telegram answer', 40)],
    local_1: [row('local_1', 1, 'user', 'desktop question', 20), row('local_1', 2, 'assistant', 'desktop answer', 50)],
    api_1: [row('api_1', 1, 'user', 'native question', 30), row('api_1', 2, 'assistant', 'native answer', 60), row('api_1', 3, 'session_meta', null, 61)],
  } });
  const store = createUnifiedHermesStore({ client, bindings });
  assert.equal(store.snapshot().lanes.telegram.health, 'syncing');
  await store.refresh();
  const snapshot = store.snapshot();
  assert.deepEqual(snapshot.lanes, {
    telegram: { health: 'live', sessionId: 'telegram_1' },
    'hermes-desktop': { health: 'live', sessionId: 'local_1' },
    native: { health: 'live', sessionId: 'api_1' },
  });
  assert.deepEqual(snapshot.messages.map((m) => [m.lane, m.text]), [
    ['telegram', 'telegram question'], ['hermes-desktop', 'desktop question'], ['native', 'native question'],
    ['telegram', 'telegram answer'], ['hermes-desktop', 'desktop answer'], ['native', 'native answer'],
  ]);
});

test('refresh starts every bound lane before any lane finishes', async () => {
  const started = [], resolvers = new Map();
  const client = {
    getMessages: (id) => new Promise((resolve) => { started.push(id); resolvers.set(id, resolve); }),
    listSessions: async () => ({ data: [] }),
  };
  const store = createUnifiedHermesStore({ client, bindings });
  const pending = store.refresh();
  assert.deepEqual(started, ['telegram_1', 'local_1', 'api_1']);
  for (const id of started) resolvers.get(id)({ data: [] });
  await pending;
  assert.equal(store.snapshot().lanes.native.health, 'live');
});

test('a network failure in one lane keeps the other lanes and that lane’s last good messages', async () => {
  const histories = {
    telegram_1: [row('telegram_1', 1, 'user', 'last good telegram', 10)],
    local_1: [row('local_1', 1, 'user', 'desktop still live', 20)],
    api_1: [row('api_1', 1, 'user', 'native before', 30)],
  };
  const client = fakeClient({ histories });
  const store = createUnifiedHermesStore({ client, bindings });
  await store.refresh();
  client.failures.set('telegram_1', apiError('unreachable', 'The connection closed.'));
  histories.api_1.push(row('api_1', 2, 'assistant', 'native after', 40));
  await store.refresh();
  const snapshot = store.snapshot();
  assert.equal(snapshot.lanes.telegram.health, 'offline');
  assert.equal(snapshot.lanes['hermes-desktop'].health, 'live');
  assert.equal(snapshot.lanes.native.health, 'live');
  assert.ok(snapshot.messages.some((m) => m.lane === 'telegram' && m.text === 'last good telegram'));
  assert.ok(snapshot.messages.some((m) => m.lane === 'native' && m.text === 'native after'));
});

test('an auth failure maps to signin', async () => {
  const client = fakeClient({ histories: { api_1: [row('api_1', 1, 'user', 'kept', 1)] } });
  const store = createUnifiedHermesStore({ client, bindings: { nativeSessionId: 'api_1' } });
  client.failures.set('api_1', apiError('unauthorized', 'Hermes refused the API key.', 401));
  await store.refresh();
  assert.equal(store.snapshot().lanes.native.health, 'signin');
});

test('a lane without a binding is unavailable and stays out of the thread', async () => {
  const client = fakeClient({ histories: { api_1: [row('api_1', 1, 'user', 'native only', 1)] } });
  const store = createUnifiedHermesStore({ client, bindings: { nativeSessionId: 'api_1' } });
  await store.refresh();
  const snapshot = store.snapshot();
  assert.equal(snapshot.lanes.telegram.health, 'unavailable');
  assert.equal(snapshot.lanes.telegram.sessionId, '');
  assert.equal(snapshot.lanes['hermes-desktop'].health, 'unavailable');
  assert.deepEqual(snapshot.messages.map((m) => m.lane), ['native']);
});

test('history reads page by offset until a short page', async () => {
  const rows = [1, 2, 3, 4, 5].map((id) => row('api_1', id, 'user', `m${id}`, id));
  const client = fakeClient({ histories: { api_1: rows } });
  const store = createUnifiedHermesStore({ client, bindings: { nativeSessionId: 'api_1' }, pageSize: 2 });
  await store.refresh();
  assert.deepEqual(client.calls.filter((c) => c.method === 'getMessages').map((c) => c.offset), [0, 2, 4]);
  assert.deepEqual(store.snapshot().messages.map((m) => m.text), ['m1', 'm2', 'm3', 'm4', 'm5']);
});

test('candidates groups sessions by lane and marks only one Telegram candidate without choosing among two', async () => {
  const local = session('local-1', 'local', { title: 'Desktop chat' });
  const botChat = session('local-bot', 'local', { title: 'Bot Chat', hidden: true });
  const native = session('api_1', 'api_server');
  const none = createUnifiedHermesStore({ client: fakeClient({ sessions: [local, botChat, native] }) });
  const empty = await none.candidates();
  assert.deepEqual(empty.telegram, []);
  assert.deepEqual(empty['hermes-desktop'].map((s) => s.id), ['local-1', 'local-bot']);
  assert.equal(empty.native[0].id, 'api_1');
  assert.equal(empty.native[0].only, undefined, 'only is a Telegram ambiguity marker');

  const oneTelegram = session('telegram_1', 'telegram');
  const one = createUnifiedHermesStore({ client: fakeClient({ sessions: [oneTelegram] }) });
  const single = await one.candidates();
  assert.deepEqual(single.telegram.map((s) => s.id), ['telegram_1']);
  assert.equal(single.telegram[0].only, true);

  const twoTelegram = [session('telegram_1', 'telegram'), session('telegram_2', 'telegram')];
  const two = createUnifiedHermesStore({ client: fakeClient({ sessions: twoTelegram }) });
  const multiple = await two.candidates();
  assert.deepEqual(multiple.telegram.map((s) => s.id), ['telegram_1', 'telegram_2']);
  assert.equal(multiple.telegram.some((s) => s.only), false, 'two Telegram sessions are both returned for a person to choose');
});

test('a secret held by the client and raw failure details never reach snapshot JSON', async () => {
  const secret = 'test-api-key-0123456789abcdef0123456789abcdef';
  const client = fakeClient({ secret, histories: { api_1: [row('api_1', 1, 'user', 'safe text', 1)] } });
  const store = createUnifiedHermesStore({ client, bindings: { nativeSessionId: 'api_1' } });
  await store.refresh();
  client.failures.set('api_1', apiError('unreachable', `network detail carrying ${secret}`));
  await store.refresh();
  const json = JSON.stringify(store.snapshot());
  assert.equal(json.includes(secret), false);
  assert.equal(json.includes('network detail'), false);
});
