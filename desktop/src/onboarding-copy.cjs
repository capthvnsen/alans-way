'use strict';

const ONBOARDING_SETUP_GUIDE_URL = 'https://github.com/capthvnsen/alans-way/blob/main/docs/setup-for-agents.md';
const ONBOARDING_PREREQUISITES = {
  title: 'Before you start',
  intro: 'You need one of these before setup can connect this computer.',
  server: 'Your own Hermes server: a computer already running Hermes that you can reach over SSH or Tailscale.',
  serverGuide: 'Read the setup steps',
  serverPath: 'Use my own server',
  claim: 'A claim code from openalan.com for a hosted bot.',
  claimPath: 'Paste a claim code',
};

// Step 1 sits over the chat pane. Only the login screen actually shows a QR
// code; connecting, offline, and locked states need a line that matches them.
function onboardingTelegramLine(status) {
  if (status === 'connected') return '✓ Signed in to Telegram';
  if (status === 'loading') return '○ Telegram is still connecting on the left. A QR code appears there when it is ready for you to sign in.';
  if (status === 'offline') return '○ Telegram is offline and will retry on its own. The QR code appears on the left once it reconnects.';
  if (status === 'locked') return '○ Unlock Telegram on the left. Scan the QR code there if it asks you to sign in again: Telegram → Settings → Devices → Link Desktop Device.';
  if (status === 'layout-changed') return '○ Telegram’s layout changed, so the sign-in QR code may not appear until Alan’s Workspace is updated.';
  return '○ Scan the QR code on the left with your phone: Telegram → Settings → Devices → Link Desktop Device.';
}

if (typeof module === 'object' && module.exports) module.exports = { onboardingTelegramLine, ONBOARDING_PREREQUISITES, ONBOARDING_SETUP_GUIDE_URL };
