const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createComputerSnapshots } = require('../src/computer-snapshot.cjs');

const tree = (generation, name = '1') => ({
  generation, elements: [{ ref: 'c1', role: 'AXButton', name, x: 1, y: 2, width: 3, height: 4 }],
});

test('an unchanged desktop tree is not sent again', () => {
  const seen = createComputerSnapshots();
  const first = seen.snapshot('a', 7, tree(11), undefined);
  assert.equal(first.generation, 11);
  assert.equal(first.elements.length, 1);
  assert.deepEqual(seen.snapshot('a', 7, tree(11), 11), { unchanged: true, generation: 11 });
  const changed = seen.snapshot('a', 7, tree(12, '2'), 11);
  assert.equal(changed.generation, 12);
  assert.equal(changed.unchanged, undefined);
  assert.equal(changed.elements[0].name, '2');
});

test('an action reply is unchanged only against what this bot last saw', () => {
  const seen = createComputerSnapshots();
  seen.snapshot('a', 7, tree(11), undefined);
  seen.snapshot('b', 7, tree(11), undefined);
  // Bot b acts and the tree moves on to generation 12.
  const forB = seen.action('b', 7, { ok: true, ...tree(12, '2') });
  assert.equal(forB.elements.length, 1);
  // Bot a never saw generation 12, so its next action reply must carry the tree.
  const forA = seen.action('a', 7, { ok: true, ...tree(12, '2') });
  assert.equal(forA.unchanged, undefined);
  assert.equal(forA.elements[0].name, '2');
  // The same tree again for bot a is now known.
  const again = seen.action('a', 7, { ok: true, ...tree(12, '2') }, 12);
  assert.deepEqual(again, { ok: true, unchanged: true, generation: 12 });
});

test('replies that carry no tree pass through', () => {
  const seen = createComputerSnapshots();
  assert.deepEqual(seen.action('a', 7, { results: [{ ok: true }] }), { results: [{ ok: true }] });
});

test('truncated survives the trim only when the tree is sent', () => {
  const seen = createComputerSnapshots();
  const first = seen.snapshot('a', 7, { ...tree(5), truncated: true }, undefined);
  assert.equal(first.truncated, true);
});

const big = (generation, count, change = {}) => ({
  generation,
  elements: Array.from({ length: count }, (_, i) => ({ ref: `c${i + 1}`, role: 'AXButton', name: change[i + 1] ?? `Button ${i + 1}`, x: i, y: 2, width: 3, height: 4 })),
});

test('an action reply lists only what changed since this bot last saw the app', () => {
  const seen = createComputerSnapshots();
  seen.snapshot('a', 7, big(1, 20), undefined);
  const after = big(2, 20, { 3: 'Count: 1' });
  after.elements.pop();
  const reply = seen.action('a', 7, { ok: true, ...after }, 1);
  assert.equal(reply.elements, undefined);
  assert.deepEqual(reply.changed.map((element) => [element.ref, element.name]), [['c3', 'Count: 1']]);
  assert.deepEqual(reply.removed, ['c20']);
  assert.equal(reply.generation, 2);
  // The next delta is against the tree this bot now holds, not the snapshot.
  const next = seen.action('a', 7, { ok: true, ...big(3, 21, { 3: 'Count: 1' }) }, 2);
  assert.deepEqual(next.changed.map((element) => element.ref), ['c20', 'c21']);
  assert.deepEqual(next.removed, []);
});

test('a delta that is not much smaller than the tree is sent as the whole tree', () => {
  const seen = createComputerSnapshots();
  seen.snapshot('a', 7, big(1, 4), undefined);
  // Every ref shifts (an insert at the top, numbered in tree order): the whole tree is the cheaper read.
  const shifted = big(2, 4, { 1: 'New', 2: 'Button 1', 3: 'Button 2', 4: 'Button 3' });
  const reply = seen.action('a', 7, { ok: true, ...shifted, truncated: true }, 1);
  assert.equal(reply.elements.length, 4);
  assert.equal(reply.truncated, true);
});

test('key order in an element does not count as a change', () => {
  const seen = createComputerSnapshots();
  seen.snapshot('a', 7, big(1, 10), undefined);
  const reordered = big(2, 10, { 5: 'Changed' });
  reordered.elements = reordered.elements.map(({ height, width, y, x, name, role, ref }) => ({ height, width, y, x, name, role, ref }));
  assert.deepEqual(seen.action('a', 7, { ok: true, ...reordered }, 1).changed.map((element) => element.ref), ['c5']);
});

test('a caller that does not hold the last tree it was sent gets the whole tree', () => {
  const seen = createComputerSnapshots();
  seen.snapshot('a', 7, big(1, 20), undefined);
  // The reply carrying generation 2 never reached the caller, which still holds 1.
  seen.action('a', 7, { ok: true, ...big(2, 20, { 3: 'Count: 1' }) }, 1);
  const reply = seen.action('a', 7, { ok: true, ...big(3, 20, { 3: 'Count: 2' }) }, 1);
  assert.equal(reply.elements.length, 20);
  // No generation at all says nothing about what the caller holds.
  assert.equal(seen.action('a', 7, { ok: true, ...big(4, 20, { 3: 'Count: 3' }) }).elements.length, 20);
});

test('snapshot deltas use the held tree, preserve metadata, and resync lost replies', () => {
  const seen = createComputerSnapshots();
  seen.snapshot('a', 7, { ...big(1, 20), windowId: 42 });
  const after = { ...big(2, 19, { 3: 'Count: 1' }), truncated: true, windowId: 42, window: { x: 10, y: 20, width: 420, height: 520 } };
  const reply = seen.snapshot('a', 7, after, 1);
  assert.equal(reply.elements, undefined);
  assert.deepEqual(reply.changed, [after.elements[2]]);
  assert.deepEqual(reply.removed, ['c20']);
  assert.equal(reply.truncated, true);
  assert.deepEqual(reply.window, after.window);
  assert.equal(reply.windowId, 42);
  assert.equal(seen.snapshot('a', 7, big(3, 20), 1).elements.length, 20);
  assert.equal(seen.snapshot('b', 7, big(3, 20), 2).elements.length, 20);
});

test('unchanged replies require a held baseline and retain current truncation and geometry', () => {
  const seen = createComputerSnapshots();
  const current = { ...big(1, 20), truncated: true, windowId: 42, window: { x: 0, y: 0, width: 420, height: 520 } };
  assert.equal(seen.snapshot('a', 7, current, 1).elements.length, 20);
  const reply = seen.snapshot('a', 7, current, 1);
  assert.equal(reply.unchanged, true);
  assert.equal(reply.truncated, true);
  assert.deepEqual(reply.window, current.window);
  assert.equal(seen.action('a', 7, { ok: true, ...current }, 99).elements.length, 20);
});

test('switching windows always returns a full tree even with an identical generation', () => {
  const seen = createComputerSnapshots();
  seen.snapshot('a', 7, { ...big(1, 20), windowId: 41 });
  const reply = seen.snapshot('a', 7, { ...big(1, 20), windowId: 42 }, 1);
  assert.equal(reply.elements.length, 20);
});
