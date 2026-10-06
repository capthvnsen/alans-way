const { test } = require('node:test');
const assert = require('node:assert/strict');
const { shouldOnboard } = require('../src/onboarding.cjs');

test('fresh install onboards', () => assert.equal(shouldOnboard({}), true));
test('finished or skipped does not', () => assert.equal(shouldOnboard({ onboarded: true }), false));
test('an existing setup from before the wizard does not', () => assert.equal(shouldOnboard({ macSshHost: 'me@mac' }), false));
test('reopened from settings onboards again', () => assert.equal(shouldOnboard({ onboarded: false, macSshHost: 'me@mac' }), true));
