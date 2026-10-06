const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createComputerSnapshots } = require('../src/computer-snapshot.cjs');

const tree = { elements: [{ ref: 'c1', role: 'AXButton', name: '1', x: 1, y: 2, width: 3, height: 4 }] };

test('an unchanged desktop tree is not sent again', () => {
  const reply = createComputerSnapshots();
  const first = reply(7, tree, undefined);
  assert.equal(first.generation, 1);
  assert.equal(first.elements.length, 1);
  const again = reply(7, tree, 1);
  assert.deepEqual(again, { unchanged: true, generation: 1 });
  const changed = reply(7, { elements: [{ ref: 'c1', role: 'AXButton', name: '2' }] }, 1);
  assert.equal(changed.generation, 2);
  assert.equal(changed.unchanged, undefined);
  assert.equal(changed.elements[0].name, '2');
  const after = reply.observe(7, tree);
  assert.equal(after.unchanged, false);
  assert.equal(after.generation, 3);
  const same = reply.observe(7, tree);
  assert.deepEqual(same, { unchanged: true, generation: 3 });
});
