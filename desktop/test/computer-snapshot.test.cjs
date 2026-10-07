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
  const again = seen.action('a', 7, { ok: true, ...tree(12, '2') });
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
