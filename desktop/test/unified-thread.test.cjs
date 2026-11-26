const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { normalizeRows, mergeThread, defaultSendLane, laneOfSession } = require('../src/unified-thread.cjs');

const serverMessage = (lane, sessionId, rowId, text, ts, extra = {}) => ({
  key: `hermes:${sessionId}:${rowId}`, lane, sessionId, rowId, role: rowId % 2 ? 'user' : 'assistant', text, ts, state: 'sent', ...extra,
});

test('normalizeRows keeps user and assistant text and hides tool-only and metadata rows', () => {
  const rows = [
    { id: 1, role: 'user', content: 'hello', timestamp: 10.5, display_kind: 'internal_notification' },
    { id: 2, role: 'assistant', content: 'answer', timestamp: 11 },
    { id: 3, role: 'assistant', content: '', tool_calls: [{ name: 'terminal' }], timestamp: 12 },
    { id: 4, role: 'tool', content: '{"ok":true}', timestamp: 13 },
    { id: 5, role: 'session_meta', content: null, timestamp: 14 },
    { id: 6, role: 'assistant', content: '   ', timestamp: 15 },
    { id: '7', role: 'user', content: 'not a server row id', timestamp: 16 },
  ];
  assert.deepEqual(normalizeRows('native', 'api_1', rows), [
    { key: 'hermes:api_1:1', lane: 'native', sessionId: 'api_1', rowId: 1, role: 'user', text: 'hello', ts: 10.5, state: 'sent' },
    { key: 'hermes:api_1:2', lane: 'native', sessionId: 'api_1', rowId: 2, role: 'assistant', text: 'answer', ts: 11, state: 'sent' },
  ]);
  assert.deepEqual(normalizeRows('native', 'api_1', null), []);
});

test('mergeThread sorts by time, session and row id, dedupes only by key, and keeps repeated text in two sessions', () => {
  const a5 = serverMessage('native', 'api_a', 5, 'tie', 10);
  const b2 = serverMessage('telegram', 'tg_b', 2, 'tie', 10);
  const b10 = serverMessage('telegram', 'tg_b', 10, 'later row', 10);
  const optimistic = { key: 'local:cmid-1', lane: 'native', sessionId: 'api_a', rowId: 'cmid-1', role: 'user', text: 'waiting', ts: 12, state: 'queued' };
  const sameOne = serverMessage('telegram', 'tg_one', 1, 'same words', 20);
  const sameTwo = serverMessage('native', 'api_two', 1, 'same words', 21);
  const merged = mergeThread({
    native: [sameTwo, b10, optimistic, a5],
    telegram: [sameOne, { ...a5, lane: 'telegram' }, b2],
    'hermes-desktop': [],
  });
  assert.deepEqual(merged.map((m) => m.key), [
    'hermes:api_a:5', 'hermes:tg_b:2', 'hermes:tg_b:10', 'local:cmid-1', 'hermes:tg_one:1', 'hermes:api_two:1',
  ]);
  assert.equal(merged.filter((m) => m.text === 'same words').length, 2, 'identical text in two sessions is two real posts');
  assert.equal(merged.filter((m) => m.key === a5.key).length, 1, 'the same row bound twice merges once');
});

test('mergeThread uses an optimistic row’s local creation time', () => {
  const merged = mergeThread({ native: [
    serverMessage('native', 'api_a', 3, 'server after', 30),
    { key: 'local:cmid-2', lane: 'native', sessionId: 'api_a', rowId: 'cmid-2', role: 'user', text: 'typed now', ts: 20, state: 'sending' },
    serverMessage('native', 'api_a', 1, 'server before', 10),
  ] });
  assert.deepEqual(merged.map((m) => m.text), ['server before', 'typed now', 'server after']);
});

test('defaultSendLane follows the latest message only when that lane can send', () => {
  const message = (lane, ts) => ({ key: `${lane}:${ts}`, lane, sessionId: 's', rowId: ts, role: 'user', text: lane, ts, state: 'sent' });
  assert.equal(defaultSendLane([message('native', 1), message('telegram', 3)], ['native', 'telegram']), 'telegram');
  assert.equal(defaultSendLane([message('native', 1), message('hermes-desktop', 3)], ['native', 'telegram']), 'native');
  assert.equal(defaultSendLane([], ['native', 'telegram']), 'native');
  assert.equal(defaultSendLane([message('telegram', 1)], { native: true }), 'native');
  assert.equal(defaultSendLane([message('telegram', 1)], []), '');
});

test('laneOfSession maps the captured Telegram, local, Bot Chat and api_server records', () => {
  const listed = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'native-chat', 'sessions-list.json'), 'utf8')).data;
  assert.equal(laneOfSession(listed.find((s) => s.source === 'telegram')), 'telegram');
  assert.equal(laneOfSession(listed.find((s) => s.source === 'api_server')), 'native');
  const local = { ...listed[1], id: 'local-regular', source: 'local', title: 'Desktop chat' };
  const botChat = { ...listed[1], id: 'local-0b07c4a7', source: 'local', title: 'Bot Chat', hidden: true };
  assert.equal(laneOfSession(local), 'hermes-desktop');
  assert.equal(laneOfSession(botChat), 'hermes-desktop');
  assert.equal(laneOfSession({ ...botChat, source: 'cli' }), 'hermes-desktop');
  assert.equal(laneOfSession({ ...listed[0], source: 'discord' }), '');
  assert.equal(laneOfSession({ title: 'Bot Chat' }), '');
  assert.equal(laneOfSession(null), '');
});
