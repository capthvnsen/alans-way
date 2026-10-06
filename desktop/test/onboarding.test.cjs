const { test } = require('node:test');
const assert = require('node:assert/strict');
const { shouldOnboard, pinOnboarding } = require('../src/onboarding.cjs');

test('fresh install onboards', () => assert.equal(shouldOnboard({}), true));
test('finished or skipped does not', () => assert.equal(shouldOnboard({ onboarded: true }), false));
test('an existing setup from before the wizard does not', () => assert.equal(shouldOnboard({ macSshHost: 'me@mac' }), false));
test('reopened from settings onboards again', () => assert.equal(shouldOnboard({ onboarded: false, macSshHost: 'me@mac' }), true));
test('a wizard pinned at startup survives saving an SSH address mid-setup', () => {
  const prefs = {};
  pinOnboarding(prefs);
  prefs.macSshHost = 'me@mac';
  assert.equal(shouldOnboard(prefs), true);
});
test('pinning leaves upgraders alone', () => {
  const prefs = { macSshHost: 'me@mac' };
  pinOnboarding(prefs);
  assert.equal(shouldOnboard(prefs), false);
  assert.equal(prefs.onboarded, undefined);
});
