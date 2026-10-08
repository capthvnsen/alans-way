const { test } = require('node:test');
const assert = require('node:assert/strict');
const { shouldOnboard, pinOnboarding, cloudStep, nextCloudStep, setCloudStep } = require('../src/onboarding.cjs');

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

test('the wizard resumes at the persisted step', () => {
  assert.equal(cloudStep({ cloud: { step: 'migrate' } }), 'migrate');
  assert.equal(cloudStep({ cloud: { step: 'telegram' } }), 'telegram');
});

test('a finished flow and an empty cloud object resolve to no setup step', () => {
  assert.equal(cloudStep({}), null);
  assert.equal(cloudStep({ cloud: {} }), null);
  assert.equal(cloudStep({ cloud: { step: 'done' } }), null);
});

test('a stale or unknown stored step restarts at connect', () => {
  assert.equal(cloudStep({ cloud: { step: 'cloud-wait' } }), 'connect');
  assert.equal(cloudStep({ cloud: { step: 'bogus' } }), 'connect');
});

test('the telegram step is skipped only when every discovered profile carries a token', () => {
  const prefs = { cloud: { step: 'model', profiles: ['a', 'b'], tokenedProfiles: ['a', 'b'] } };
  assert.equal(nextCloudStep(prefs, 'model'), 'done');
  prefs.cloud.tokenedProfiles = ['a'];
  assert.equal(nextCloudStep(prefs, 'model'), 'telegram', 'an untokened profile still needs a bot');
  prefs.cloud.tokenedProfiles = [];
  assert.equal(nextCloudStep(prefs, 'model'), 'telegram');
});

test('a token in the shared home env or secrets dir covers every profile', () => {
  const prefs = { cloud: { step: 'model', profiles: ['a', 'b'], tokenedProfiles: ['*'] } };
  assert.equal(nextCloudStep(prefs, 'model'), 'done');
});

test('steps still advance and finish in order', () => {
  const prefs = { cloud: { step: 'migrate' } };
  assert.equal(nextCloudStep(prefs, 'connect'), 'migrate');
  assert.equal(nextCloudStep(prefs, 'telegram'), 'done');
  assert.equal(nextCloudStep(prefs, 'bogus'), 'done');
});

test('step writes only accept known steps', () => {
  const prefs = { cloud: { step: 'connect' } };
  assert.equal(setCloudStep(prefs, 'migrate'), true);
  assert.equal(prefs.cloud.step, 'migrate');
  assert.equal(setCloudStep(prefs, 'bogus'), false);
  assert.equal(prefs.cloud.step, 'migrate');
  assert.equal(setCloudStep({}, 'connect'), false);
});
