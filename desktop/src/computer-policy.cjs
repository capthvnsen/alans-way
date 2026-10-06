'use strict';

// Apps the agent must never drive. Password UI and the login window sit here
// even when they are not the frontmost app.
const BLOCKED_BUNDLES = new Set([
  'com.apple.keychainaccess',
  'com.apple.SecurityAgent',
  'com.apple.security.SecurityAgent',
  'com.apple.LocalAuthentication.UIAgent',
  'com.apple.loginwindow',
]);

function computerDecision(app, frontmostPid) {
  if (!app || !Number.isInteger(app.pid)) return { ok: false, reason: 'App not found.' };
  if (BLOCKED_BUNDLES.has(app.bundleId)) return { ok: false, reason: 'That app is off limits.' };
  if (Number.isInteger(frontmostPid) && app.pid === frontmostPid) {
    return { ok: false, reason: 'That app is the one in front. Leave it in the background; the real cursor stays yours.' };
  }
  return { ok: true };
}

module.exports = { BLOCKED_BUNDLES, computerDecision };
