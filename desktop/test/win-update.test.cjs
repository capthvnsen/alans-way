const { test } = require('node:test');
const assert = require('node:assert/strict');
const { githubFeed } = require('../src/win-update.cjs');

const publish = [{ provider: 'github', owner: 'o', repo: 'r', releaseType: 'draft' }];

test('an installer build with app-update.yml keeps its own feed', () => {
  assert.equal(githubFeed(true, publish), null);
});
test('a script-built install without app-update.yml falls back to the GitHub feed from the build config', () => {
  assert.deepEqual(githubFeed(false, publish), { provider: 'github', owner: 'o', repo: 'r' });
});
test('no github publish entry means no feed to set', () => {
  assert.equal(githubFeed(false, undefined), null);
  assert.equal(githubFeed(false, [{ provider: 's3' }]), null);
});
test('the shipped build config yields a feed', () => {
  assert.equal(githubFeed(false, require('../electron-builder.cjs').PUBLISH).provider, 'github');
});
