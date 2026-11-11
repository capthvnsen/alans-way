const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { createHermesApi, createSseParser, parseBaseUrl } = require('../src/hermes-api.cjs');
const { createMock } = require('./native-chat-mock.cjs');

const KEY = 'mock-key-0000000000000001';
const BASE_ID = 'api_1794430525_b34278ca';
let mock, api;
test.before(async () => { mock = await createMock({ key: KEY }).listen(); api = createHermesApi({ baseUrl: mock.url, key: KEY }); });
test.after(() => mock.close());

test('lists sessions from every source', async () => {
  const body = await api.listSessions({ limit: 10 });
  assert.equal(body.object, 'list');
  assert.deepEqual(new Set(body.data.map((s) => s.source)), new Set(['api_server', 'telegram']));
  assert.match(mock.requests.at(-1).search, /limit=10/);
});

test('pages messages newest first by offset', async () => {
  const id = [...mock.sessions.values()].find((s) => s.meta.title === 'seed 1k').meta.id;
  const newest = await api.getMessages(id, { limit: 500 });
  const older = await api.getMessages(id, { limit: 500, offset: 500 });
  assert.equal(newest.data.length, 500);
  assert.equal(older.data.length, 500);
  assert.ok(older.data.at(-1).id < newest.data[0].id, 'the second page is older');
  assert.ok(newest.data[0].id < newest.data.at(-1).id, 'a page reads oldest to newest');
  assert.equal((await api.getMessages(id, { limit: 500, offset: 1000 })).data.length, 0);
});

test('streams a reply, even when every frame arrives split into tiny chunks', async () => {
  for (const chunk of [0, 7]) {
    mock.chunk = chunk;
    const events = [];
    await api.streamChat(BASE_ID, 'hello world', { onEvent: (name, data) => events.push([name, data]) });
    assert.deepEqual(events.map(([name]) => name), ['run.started', 'message.started', 'assistant.delta', 'assistant.delta', 'assistant.delta', 'assistant.delta', 'assistant.delta', 'assistant.completed', 'run.completed', 'done']);
    assert.equal(events.filter(([name]) => name === 'assistant.delta').map(([, d]) => d.delta).join(''), 'pong: hello world');
  }
  mock.chunk = 0;
});

test('the SSE parser skips keepalive comments, joins data lines and handles CRLF', () => {
  const seen = [];
  const feed = createSseParser((name, data) => seen.push([name, data]));
  for (const piece of [': keepalive\n\n', 'event: a\r\nda', 'ta: {"x":', '\ndata: 1}\r\n', '\r\n', ': keepalive\n\nevent: done\ndata: {}\n\n']) feed(piece);
  assert.deepEqual(seen, [['a', { x: 1 }], ['done', {}]]);
  assert.throws(() => feed(`data: ${'x'.repeat(3 * 1024 * 1024)}`), /too large/);
});

test('approval round trip: the stream waits on the card answer, keepalives included', async () => {
  const events = [];
  let answered;
  await api.streamChat(BASE_ID, 'APPROVE please', {
    onEvent: (name, data) => {
      events.push(name);
      if (name === 'approval.request') answered = api.answerApproval(data.run_id, { requestId: data.request_id, generation: data.execution_generation, choice: 'once' });
    },
  });
  assert.deepEqual(await answered, { run_id: 'run_4c6921b8a14d47e78d98126eb6e7bc46', status: 'resolved', prompt_id: '19df287c2cb24f8a97a8b85cf2270321' });
  const approval = mock.requests.find((r) => r.path.endsWith('/approval'));
  assert.equal(approval.method, 'POST');
  assert.ok(events.indexOf('tool.failed') > events.indexOf('approval.request'));
  assert.equal(events.at(-1), 'done');
});

test('stop ends a long reply with run.cancelled', async () => {
  const names = [];
  let runId;
  const done = api.streamChat(BASE_ID, 'LONG please', { onEvent: (name, data) => { names.push(name); if (name === 'run.started') runId = data.run_id; } });
  while (names.filter((n) => n === 'assistant.delta').length < 2) await new Promise((r) => setTimeout(r, 20));
  assert.equal((await api.stopRun(runId)).status, 'stopping');
  await done;
  assert.ok(names.filter((n) => n === 'assistant.delta').length < 24, 'stopped before the end');
  assert.deepEqual(names.slice(-3), ['assistant.completed', 'run.cancelled', 'done']);
});

test('aborting a live stream rejects as aborted', async () => {
  const controller = new AbortController();
  const done = api.streamChat(BASE_ID, 'LONG please', { signal: controller.signal, onEvent: (name) => { if (name === 'assistant.delta') controller.abort(); } });
  await assert.rejects(done, { code: 'aborted' });
});

test('a silent stream is dropped by the watchdog', async () => {
  const server = net.createServer((socket) => socket.once('data', () => socket.write('HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n: keepalive\n\n')));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const quiet = createHermesApi({ baseUrl: `http://127.0.0.1:${server.address().port}`, key: KEY, idleMs: 150 });
  await assert.rejects(quiet.streamChat('s', 'x'), { code: 'stream_dropped' });
  server.close();
});

test('errors are clean codes: unauthorized, unreachable, http_<code>, unconfigured', async () => {
  await assert.rejects(createHermesApi({ baseUrl: mock.url, key: 'wrong-key-000000000000' }).listSessions(), { code: 'unauthorized' });
  await assert.rejects(api.getMessages('api_missing_00000000'), { code: 'http_404', message: 'Session not found' });
  const closed = net.createServer();
  await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve));
  const port = closed.address().port;
  closed.close();
  await assert.rejects(createHermesApi({ baseUrl: `http://127.0.0.1:${port}`, key: KEY }).listSessions(), { code: 'unreachable' });
  await assert.rejects(createHermesApi({ baseUrl: '', key: KEY }).listSessions(), { code: 'unconfigured' });
  await assert.rejects(createHermesApi({ baseUrl: mock.url, key: '' }).listSessions(), { code: 'unconfigured' });
});

test('a REST call that never answers times out as unreachable', async () => {
  const server = net.createServer(() => {});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  await assert.rejects(createHermesApi({ baseUrl: `http://127.0.0.1:${server.address().port}`, key: KEY, timeoutMs: 150 }).listSessions(), { code: 'unreachable', message: /in time/ });
  server.closeAllConnections?.(); server.close();
});

test('no request ever carries an Origin header, and the profile prefix is used', async () => {
  assert.ok(mock.requests.length > 10);
  for (const request of mock.requests) assert.equal(request.headers.origin, undefined, `${request.method} ${request.path}`);
  await createHermesApi({ baseUrl: mock.url, key: KEY, profile: 'work' }).listSessions();
  assert.equal(mock.requests.at(-1).path, '/p/work/api/sessions');
});

test('base URLs: loopback over http, everything else only over https', () => {
  assert.deepEqual(parseBaseUrl('http://127.0.0.1:8642'), { baseUrl: 'http://127.0.0.1:8642', profile: '' });
  assert.deepEqual(parseBaseUrl(' http://localhost:8642/ '), { baseUrl: 'http://localhost:8642', profile: '' });
  assert.deepEqual(parseBaseUrl('http://[::1]:8642'), { baseUrl: 'http://[::1]:8642', profile: '' });
  assert.deepEqual(parseBaseUrl('https://alan.tail1234.ts.net/p/work/'), { baseUrl: 'https://alan.tail1234.ts.net', profile: 'work' });
  assert.deepEqual(parseBaseUrl('https://example.com/hermes'), { baseUrl: 'https://example.com/hermes', profile: '' });
  for (const refused of ['http://remote.example:8642', 'http://example.com', 'ftp://127.0.0.1', 'https://user:pw@example.com', 'https://example.com/?key=1', 'https://example.com/#x', 'not a url', '']) {
    assert.equal(parseBaseUrl(refused), null, refused);
  }
});
