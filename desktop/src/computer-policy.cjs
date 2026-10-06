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

// On Windows the driver reports the lowercase exe basename as bundleId.
// consent.exe/LogonUI/LockApp live on the secure desktop — UIA cannot reach
// them anyway; listing them makes the refusal explicit rather than silent.
const BLOCKED_PROCESSES = new Set([
  'consent.exe',
  'logonui.exe',
  'lockapp.exe',
  'credentialuibroker.exe',
  'useraccountbroker.exe',
  'sechealthui.exe',
]);

function isBlocked(bundleId, platform = process.platform) {
  const id = String(bundleId || '');
  return platform === 'win32' ? BLOCKED_PROCESSES.has(id.toLowerCase()) : BLOCKED_BUNDLES.has(id);
}

function computerDecision(app, frontmostPid, platform = process.platform) {
  if (!app || !Number.isInteger(app.pid)) return { ok: false, reason: 'App not found.' };
  if (isBlocked(app.bundleId, platform)) return { ok: false, reason: 'That app is off limits.' };
  if (Number.isInteger(frontmostPid) && app.pid === frontmostPid) {
    return { ok: false, reason: 'That app is the one in front. Leave it in the background; the real cursor stays yours.' };
  }
  return { ok: true };
}

module.exports = { BLOCKED_BUNDLES, BLOCKED_PROCESSES, isBlocked, computerDecision };
