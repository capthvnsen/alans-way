const { test } = require('node:test');
const assert = require('node:assert/strict');
const { windowsFeed } = require('../src/win-update.cjs');

const pkg = { build: { publish: [{ provider: 'github', owner: 'o', repo: 'r', releaseType: 'draft' }] } };

test('an NSIS install with app-update.yml keeps its own feed', () => {
  assert.equal(windowsFeed(true, pkg), null);
});
test('a script-built install without app-update.yml falls back to the GitHub feed from package.json', () => {
  assert.deepEqual(windowsFeed(false, pkg), { provider: 'github', owner: 'o', repo: 'r' });
});
test('no github publish entry means no feed to set', () => {
  assert.equal(windowsFeed(false, {}), null);
  assert.equal(windowsFeed(false, { build: { publish: [{ provider: 's3' }] } }), null);
});
test('the shipped package.json yields a feed', () => {
  assert.equal(windowsFeed(false, require('../package.json')).provider, 'github');
});
