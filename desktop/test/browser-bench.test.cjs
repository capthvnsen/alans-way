const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../scripts/browser-bench.cjs'), 'utf8');
const Agent = vm.runInNewContext(source.slice(source.indexOf('const isRef ='), source.indexOf('// ---------------------------------------------------------------- tasks')) + '\nAgent', {
  require, Buffer, URL, sleep: async () => {}, think: 0,
});
const tasks = vm.runInNewContext(source.slice(source.indexOf('const tasks ='), source.indexOf('// ---------------------------------------------------------------- run')) + '\ntasks', { isDeepStrictEqual: require('node:util').isDeepStrictEqual });

test('product prices ignore object key order but preserve ordered exact values', () => {
  const check = tasks.find(t => t.id === 'product-prices').check;
  const items = Array.from({ length: 20 }, (_, i) => ({ price: '$' + (12 + i * 0.75).toFixed(2), title: 'Product ' + String(i + 1).padStart(2, '0') }));
  const fx = { reports: {} };
  assert.equal(check(fx, JSON.stringify(items)), true);
  assert.equal(check(fx, JSON.stringify(items.toReversed())), false);
  assert.equal(check(fx, JSON.stringify(items.slice(1))), false);
  assert.equal(check(fx, JSON.stringify(items.map((item, i) => i ? item : { ...item, price: '$0.01' }))), false);
  assert.equal(check(fx, JSON.stringify(items.map(item => ({ ...item, price: Number(item.price.slice(1)) })))), false);
  assert.equal(check({ reports: { products: 'ordered' } }, JSON.stringify(items)), false);
  assert.equal(check(fx, 'not json'), false);
});

test('reading a popup preserves the original tab controls and generation', async () => {
  const a = new Agent({ callTool: async () => ({ content: [{ type: 'text', text: JSON.stringify({ elements: [], generation: 1, text: 'Code: K123456' }) }] }) }, {});
  a.tab = { id: 'original', epoch: 1 };
  a.absorb({ elements: [{ ref: 'e14', name: 'Access code' }], generation: 7 });
  await a.call('cua_alans_way_snapshot', { tabId: 'popup', maxElements: 0 });
  assert.equal(a.generation, 7);
  assert.equal(a.find(/^Access code/).ref, 'e14');
});

test('fixture approval is unavailable for public tasks and existing connections', async () => {
  const a = new Agent({}, {});
  a.tab = { id: 'original', epoch: 1 };
  await assert.rejects(() => a.review({ action: 'click', ref: 'e1' }), /disposable fixture/);
});

test('fixture approval refuses a document outside the fixture origin', async () => {
  const a = new Agent({}, { fixtureApproval: 'http://fixture.example:1234' });
  a.tab = { id: 'original', epoch: 1 };
  a.snapshot = async () => ({ url: 'https://example.com' });
  await assert.rejects(() => a.review({ action: 'click', ref: 'e1' }), /left the disposable fixture/);
});

test('a refused batch step counts in the reported errors', async () => {
  const a = new Agent({ callTool: async () => ({ content: [{ type: 'text', text: JSON.stringify({ results: [{ ok: true }, { ok: false, error: 'commit_required: Submit' }] }) }] }) }, {});
  await a.call('cua_alans_way_action', { tabId: 'original', action: 'batch' });
  assert.equal(a.stats.errors, 1);
  assert.match(a.log[0].error, /commit_required/);
});

test('observation bytes count UTF-8 separately from character token estimates', async () => {
  const text = JSON.stringify({ text: 'Price: €12' });
  const a = new Agent({ callTool: async () => ({ content: [{ type: 'text', text }] }) }, {});
  await a.call('cua_alans_way_snapshot', {});
  assert.equal(a.stats.bytes, Buffer.byteLength(text));
  assert.equal(a.stats.chars, text.length);
});

test('a refused batch reviews only the unexecuted step', async () => {
  const a = new Agent({}, { fixtureApproval: 'http://fixture.example' });
  a.known = [{ ref: 'e1', name: 'Name' }, { ref: 'e2', name: 'Send request' }];
  let batches = 0, reviews = 0;
  a.act = async body => {
    batches++;
    assert.equal(body.steps.length, 2);
    return { results: [{ ok: true }, { ok: false, error: 'commit_required: Send request' }] };
  };
  a.review = async body => {
    reviews++;
    assert.equal(body.ref, 'e2');
    return { dispatched: true };
  };
  await a.run([{ action: 'type', target: [/^Name$/], text: 'Ada' }, { action: 'click', target: [/^Send request$/] }]);
  assert.equal(batches, 1);
  assert.equal(reviews, 1);
});
