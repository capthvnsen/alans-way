const { test } = require('node:test');
const assert = require('node:assert/strict');
const { shouldOnboard, pinOnboarding, nextCloudStep } = require('../src/onboarding.cjs');

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

test('the telegram step is skipped only when every discovered profile carries a token', () => {
  const prefs = { cloud: { sessionEnc: 'x', step: 'model', profiles: ['a', 'b'], tokenedProfiles: ['a', 'b'] } };
  assert.equal(nextCloudStep(prefs, 'model'), 'done');
  prefs.cloud.tokenedProfiles = ['a'];
  assert.equal(nextCloudStep(prefs, 'model'), 'telegram', 'an untokened profile still needs a bot');
  prefs.cloud.tokenedProfiles = [];
  assert.equal(nextCloudStep(prefs, 'model'), 'telegram');
});

test('a token in the shared home env or secrets dir covers every profile', () => {
  const prefs = { cloud: { sessionEnc: 'x', step: 'model', profiles: ['a', 'b'], tokenedProfiles: ['*'] } };
  assert.equal(nextCloudStep(prefs, 'model'), 'done');
});

test('steps still advance and finish in order', () => {
  const prefs = { cloud: { sessionEnc: 'x', step: 'migrate' } };
  assert.equal(nextCloudStep(prefs, 'connect'), 'migrate');
  assert.equal(nextCloudStep(prefs, 'telegram'), 'done');
  assert.equal(nextCloudStep(prefs, 'bogus'), 'done');
});
