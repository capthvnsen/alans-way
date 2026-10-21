const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { cachedSnapshot } = require('../src/browser-page.cjs');

function page(title) {
  const context = vm.createContext({
    document: { title, readyState: 'complete', body: null, querySelectorAll: () => [], querySelector: () => null },
    location: { href: 'https://fixture.example/', hostname: 'fixture.example', pathname: '/' },
    innerWidth: 800, innerHeight: 600, devicePixelRatio: 1,
    performance, setTimeout, clearTimeout,
  });
  context.window = context;
  return context;
}
test('reader installs once, sends small options, and refills after context loss', async () => {
  let context = page('First');
  const sent = [];
  const execute = async code => { sent.push(code); return vm.runInContext(code, context); };
  assert.equal((await cachedSnapshot(execute, { maxChars: 0, maxElements: 0 })).title, 'First');
  assert.equal((await cachedSnapshot(execute, { maxChars: 0, maxElements: 0 })).title, 'First');
  assert.equal(sent.length, 3);
  assert.ok(sent[1].length > 20000);
  assert.ok(sent[2].length < 1500);
  context = page('Second');
  assert.equal((await cachedSnapshot(execute, { maxChars: 0, maxElements: 0 })).title, 'Second');
  assert.equal(sent.length, 5);
  vm.runInContext('delete window[Symbol.for("hw.snapshotReader")]', context);
  await cachedSnapshot(execute, { maxChars: 0, maxElements: 0 });
  assert.equal(sent.length, 7);
});

test('a page that seals the cache slot still permits an uncached read', async () => {
  const context = page('Sealed');
  vm.runInContext('Object.defineProperty(window, Symbol.for("hw.snapshotReader"), { value: null })', context);
  assert.equal((await cachedSnapshot(code => vm.runInContext(code, context), { maxChars: 0, maxElements: 0 })).title, 'Sealed');
});
