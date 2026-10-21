const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../scripts/browser-bench.cjs'), 'utf8');
const Agent = vm.runInNewContext(source.slice(source.indexOf('const isRef ='), source.indexOf('// ---------------------------------------------------------------- tasks')) + '\nAgent', {
  require, Buffer, URL, sleep: async () => {}, think: 0,
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

test('the article-link benchmark requires a navigation to the actual requested destination', async () => {
  const tasks = vm.runInNewContext(source.slice(source.indexOf('const tasks ='), source.indexOf('// ---------------------------------------------------------------- run')) + '\ntasks', { RESULTS: [] });
  const task = tasks.find(t => t.id === 'pub-wiki-link');
  const url = 'https://en.wikipedia.org/wiki/Charles_Babbage';
  const a = { open: async () => {}, need: async () => 'e1', act: async () => ({ effect: { navigated: true, url } }) };
  assert.equal(task.check({ lastUrl: url }, await task.run(a)), true);
  assert.equal(task.check({ lastUrl: 'https://en.wikipedia.org/wiki/Ada_Lovelace' }, url), false);
  a.act = async () => ({ effect: { navigated: false, url } });
  assert.equal(task.check({ lastUrl: url }, await task.run(a)), false);
});
