'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createPointerFeed } = require('../src/shell-support.cjs');
const { createActivityTracker, ACTIVITY_SOURCE } = require('../src/activity.cjs');

test('pointer feed sends only on movement, slows when still, and stops while hidden', async () => {
  let cursor = { x: 100, y: 200 };
  let clock = 1000;
  let reads = 0;
  const sent = [];
  const feed = createPointerFeed({
    activeMs: 10,
    idleMs: 60,
    stillAfterMs: 30,
    now: () => clock,
    read: () => { reads++; return { ...cursor }; },
    send: (pt) => sent.push(pt),
  });
  assert.equal(feed.running, false, 'does not run before visible');
  feed.setVisible(true);
  assert.equal(feed.running, true);

  await new Promise((r) => setTimeout(r, 25));
  assert.equal(sent.length, 1, 'initial position sent once');
  assert.deepEqual(sent[0], { x: 100, y: 200 });

  // Advance virtual clock past stillAfterMs while cursor stays still.
  clock += 50;
  const readsBeforeStill = reads;
  await new Promise((r) => setTimeout(r, 90));
  assert.equal(sent.length, 1, 'still pointer sends zero IPC');
  assert.ok(reads - readsBeforeStill <= 4, `slowed polling while still (${reads - readsBeforeStill} reads)`);

  // Moving the pointer sends immediately and returns to active cadence.
  cursor = { x: 120, y: 205 };
  clock += 10;
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1], { x: 120, y: 205 });

  // Hiding stops all polling completely.
  feed.setVisible(false);
  assert.equal(feed.running, false);
  const readsWhenHidden = reads;
  cursor = { x: 300, y: 400 };
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(reads, readsWhenHidden, 'zero wakeups while hidden');
  assert.equal(sent.length, 2, 'zero IPC while hidden');

  // Restoring resumes polling and picks up the new position.
  feed.setVisible(true);
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(sent.length, 3);
  assert.deepEqual(sent[2], { x: 300, y: 400 });
  feed.stop();
  assert.equal(feed.running, false);
});

test('pointer feed recovers cleanly after read returns null', async () => {
  let visible = false;
  const sent = [];
  const feed = createPointerFeed({
    activeMs: 10,
    idleMs: 50,
    stillAfterMs: 100,
    read: () => (visible ? { x: 5, y: 6 } : null),
    send: (pt) => sent.push(pt),
  });
  feed.setVisible(true);
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(feed.running, false);
  assert.equal(sent.length, 0);

  visible = true;
  feed.setVisible(true);
  await new Promise((r) => setTimeout(r, 25));
  assert.deepEqual(sent, [{ x: 5, y: 6 }]);
  feed.stop();
});

test('activity tracker reports hasActive only when bridge or action leases exist', () => {
  const tracker = createActivityTracker();
  assert.equal(tracker.hasActive(), false);
  tracker.setContext({ accountId: '1', connected: true, bots: [{ id: '42', isBot: true }] });
  assert.equal(tracker.hasActive(), false);
  tracker.ingest({ version: 1, source: ACTIVITY_SOURCE, accountId: '1', type: 'ready', sequence: 1, observedAt: 1000 }, 1000);
  assert.equal(tracker.hasActive(), true);
  tracker.expire(20000);
  assert.equal(tracker.hasActive(), false);
});
