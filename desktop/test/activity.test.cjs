const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createActivityTracker, ACTIVITY_TTL_MS, BRIDGE_TTL_MS, ACTIVITY_SOURCE } = require('../src/activity.cjs');

function fixture() {
  const tracker = createActivityTracker();
  const context = { accountId: '100', connected: true, bots: [{ id: '200', isBot: true }, { id: '201', isBot: true }, { id: '300', isBot: false }] };
  tracker.setContext(context);
  let sequence = 0;
  const packet = (overrides = {}) => ({ version: 1, source: ACTIVITY_SOURCE, accountId: '100', type: 'action',
    botId: '200', actorId: '200', action: 'typing', observedAt: 10000, sequence: ++sequence, ...overrides });
  return { tracker, context, packet };
}

test('only a fresh real chat action activates its verified bot and it expires after six seconds', () => {
  const { tracker, packet } = fixture();
  assert.equal(tracker.get('200', 10000).state, 'unknown');
  assert.equal(tracker.ingest(packet(), 10000), true);
  assert.deepEqual(tracker.get('200', 10001), { state: 'active', action: 'typing', label: 'Typing', source: ACTIVITY_SOURCE, observedAt: 10000, expiresAt: 16000 });
  assert.equal(tracker.get('201', 10001).state, 'idle');
  assert.equal(tracker.get('200', 10000 + ACTIVITY_TTL_MS).state, 'idle');
  assert.equal(tracker.expire(16000), true);
  assert.equal(tracker.expire(16000), false);
});

test('availability heartbeats never extend an action; a fresh Telegram update does', () => {
  const { tracker, packet } = fixture();
  tracker.ingest(packet(), 10000);
  tracker.ingest(packet({ type: 'ready', observedAt: 15000 }), 15000);
  assert.equal(tracker.get('200', 16000).state, 'idle');
  tracker.ingest(packet({ observedAt: 17000 }), 17000);
  assert.equal(tracker.get('200', 17000).state, 'active');
  assert.equal(tracker.get('200', 23000).state, 'idle');
});

test('cancellation immediately stops animation and replay cannot reactivate it', () => {
  const { tracker, packet } = fixture();
  const original = packet();
  tracker.ingest(original, 10000);
  tracker.ingest(packet({ action: 'cancel', observedAt: 10100 }), 10100);
  assert.equal(tracker.get('200', 10100).state, 'idle');
  assert.equal(tracker.ingest(original, 10100), false);
  assert.equal(tracker.get('200', 10100).state, 'idle');
});

test('stale, future, unverified, different-actor, group, and message packets cannot activate bots', () => {
  const { tracker, packet } = fixture();
  for (const overrides of [
    { observedAt: 4000 }, { observedAt: 10251 }, { sequence: -1 }, { sequence: NaN }, { accountId: '101' },
    { botId: '300', actorId: '300' }, { actorId: '201' }, { botId: '-100200', actorId: '200' },
    { type: 'message', text: 'typing', action: 'typing' }, { action: 'thinking' },
    { source: 'telegram-cache' }, { version: 2 },
  ]) assert.equal(tracker.ingest(packet(overrides), 10000), false, JSON.stringify(overrides));
  assert.equal(tracker.get('200', 10000).state, 'unknown');
});

test('account changes, lock/disconnect, missing adapter, and deleted bots clear activity', () => {
  const { tracker, context, packet } = fixture();
  tracker.ingest(packet(), 10000);
  tracker.setContext({ ...context, accountId: '101' });
  assert.equal(tracker.get('200', 10000).state, 'unknown');
  assert.equal(tracker.ingest(packet(), 10000), false);
  tracker.setContext(context);
  tracker.ingest(packet(), 10000);
  tracker.setContext({ ...context, connected: false });
  assert.equal(tracker.get('200', 10000).state, 'unknown');
  tracker.setContext(context);
  tracker.ingest(packet(), 10000);
  tracker.ingest(packet({ type: 'unavailable' }), 10000);
  assert.equal(tracker.get('200', 10000).state, 'unknown');
  tracker.ingest(packet(), 10000);
  tracker.setContext({ ...context, bots: [] });
  assert.equal(tracker.get('200', 10000).state, 'unknown');
});

test('silent or destroyed preload loses availability and cannot leave an active animation', () => {
  const { tracker, packet } = fixture();
  tracker.ingest(packet(), 10000);
  assert.equal(tracker.get('200', 10000 + BRIDGE_TTL_MS).state, 'unknown');
  assert.equal(tracker.expire(10000 + BRIDGE_TTL_MS), true);
  tracker.ingest(packet({ observedAt: 20000 }), 20000);
  assert.equal(tracker.clear(), true);
  assert.equal(tracker.get('200', 20000).state, 'unknown');
});

// Execute the actual serialized preload adapter, with the same Worker envelope
// used by Telegram Web A. This checks extraction without logging in or sending.
function workerObserver() {
  let source;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/telegram-preload.cjs'), 'utf8'), {
    require: () => ({ ipcRenderer: { on() {}, send() {} }, contextBridge: { executeInMainWorld(script) { source = script.func.toString(); } } }),
    location: { origin: 'https://web.telegram.org', pathname: '/a/' },
    window: { addEventListener() {} },
  });
  assert.ok(source, 'adapter is installed during preload, before DOMContentLoaded');
  const reports = [];
  class Worker {
    constructor(url) { this.url = url; this.listeners = new Map(); }
    addEventListener(type, listener) { this.listeners.set(type, listener); }
    emit(update, isTrusted = true) { this.listeners.get('message')?.({ isTrusted, data: { payloads: [{ type: 'updates', updates: [update] }] } }); }
    terminate() { this.terminated = true; }
  }
  const window = { Worker };
  vm.runInNewContext(`(${source})(report)`, { window, URL, location: { href: 'https://web.telegram.org/a/' }, report: (event) => reports.push(JSON.parse(JSON.stringify(event))) });
  return { worker: new window.Worker('https://web.telegram.org/a/assets/worker-fixture.js'), reports, window };
}

test('actual Worker observer forwards identity and action only, including cancellation', () => {
  const { worker, reports } = workerObserver();
  worker.emit({ '@type': 'updateChatTypingStatus', id: '200', peerId: '200', typingStatus: { type: 'typing', timestamp: 12345 } });
  assert.deepEqual(reports.at(-1), { type: 'action', botId: '200', actorId: '200', action: 'typing' });
  worker.emit({ '@type': 'updateChatTypingStatus', id: '200', peerId: '200' });
  assert.deepEqual(reports.at(-1), { type: 'action', botId: '200', actorId: '200', action: 'cancel' });
  worker.terminate();
  assert.equal(worker.terminated, true);
  assert.equal(reports.at(-1).type, 'unavailable');
});

test('Worker observer ignores text content, group actors, synthetic messages, and unrelated workers', () => {
  const { worker, reports, window } = workerObserver();
  worker.emit({ '@type': 'newMessage', id: '200', text: 'typing…', message: { text: 'working' } });
  worker.emit({ '@type': 'updateChatTypingStatus', id: '-100200', peerId: '200', typingStatus: { type: 'typing' } });
  worker.emit({ '@type': 'updateChatTypingStatus', id: '200', peerId: '201', typingStatus: { type: 'typing' } });
  worker.emit({ '@type': 'updateChatTypingStatus', id: '200', peerId: '200', typingStatus: { type: 'typing' } }, false);
  new window.Worker('https://example.com/worker.js').emit({ '@type': 'updateApiReady' });
  assert.deepEqual(reports, []);
});

test('Worker observer forwards connection and account changes without carrying session data', () => {
  const { worker, reports } = workerObserver();
  worker.emit({ '@type': 'updateConnectionState', connectionState: 'connectionStateBroken' });
  worker.emit({ '@type': 'updateCurrentUser', currentUser: { id: '100', firstName: 'Private', phoneNumber: 'private' } });
  worker.emit({ '@type': 'updateAuthorizationState', authorizationState: 'authorizationStateWaitPhoneNumber' });
  assert.deepEqual(reports, [{ type: 'connection', ready: false }, { type: 'account', accountId: '100' }, { type: 'logout' }]);
});
