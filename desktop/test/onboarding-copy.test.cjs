'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { onboardingTelegramLine } = require('../src/onboarding-copy.cjs');

test('setup does not tell you to scan a QR code until Telegram is ready for it', () => {
  assert.match(onboardingTelegramLine('loading'), /still connecting/);
  assert.doesNotMatch(onboardingTelegramLine('loading'), /Scan the QR code/);
  assert.match(onboardingTelegramLine('offline'), /offline/);
  assert.doesNotMatch(onboardingTelegramLine('offline'), /Scan the QR code/);
  assert.match(onboardingTelegramLine('locked'), /Unlock Telegram/);
  assert.match(onboardingTelegramLine('layout-changed'), /layout changed/);
});

test('the login and signed-in lines stay specific', () => {
  assert.match(onboardingTelegramLine('login'), /Scan the QR code on the left/);
  assert.match(onboardingTelegramLine(undefined), /Scan the QR code on the left/);
  assert.equal(onboardingTelegramLine('connected'), '✓ Signed in to Telegram');
});
