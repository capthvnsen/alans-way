const { test } = require('node:test');
const assert = require('node:assert/strict');
const { computerDecision } = require('../src/computer-policy.cjs');

test('computer use refuses keychain, the frontmost app, and a missing app', () => {
  assert.equal(computerDecision(null, 1).ok, false);
  assert.match(computerDecision({ pid: 4, bundleId: 'com.apple.keychainaccess' }, 9).reason, /off limits/);
  assert.match(computerDecision({ pid: 4, bundleId: 'com.apple.SecurityAgent' }, 9).reason, /off limits/);
  assert.match(computerDecision({ pid: 7, bundleId: 'com.apple.calculator' }, 7).reason, /in front/);
  assert.equal(computerDecision({ pid: 7, bundleId: 'com.apple.calculator' }, 3).ok, true);
});
