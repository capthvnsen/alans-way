'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { onboardingTelegramLine, ONBOARDING_PREREQUISITES, ONBOARDING_SETUP_GUIDE_URL } = require('../src/onboarding-copy.cjs');

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

test('the first step names the two ways setup can start', () => {
  assert.equal(ONBOARDING_PREREQUISITES.title, 'Before you start');
  assert.equal(ONBOARDING_PREREQUISITES.intro, 'You need one of these before setup can connect this computer.');
  assert.match(ONBOARDING_PREREQUISITES.server, /^Your own Hermes server: a computer already running Hermes/);
  assert.match(ONBOARDING_PREREQUISITES.server, /over SSH or Tailscale\.$/);
  assert.equal(ONBOARDING_PREREQUISITES.claim, 'A claim code from openalan.com for a hosted bot.');
  assert.equal(ONBOARDING_PREREQUISITES.serverGuide, 'Read the setup steps');
  assert.equal(ONBOARDING_PREREQUISITES.serverPath, 'Use my own server');
  assert.equal(ONBOARDING_PREREQUISITES.claimPath, 'Paste a claim code');
  assert.equal(ONBOARDING_SETUP_GUIDE_URL, 'https://github.com/capthvnsen/alans-way/blob/main/docs/setup-for-agents.md');
  for (const copy of Object.values(ONBOARDING_PREREQUISITES)) assert.doesNotMatch(copy, /!/);
});
