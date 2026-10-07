'use strict';

// Apps the agent must never drive, on every OS. The helpers receive this list
// and enforce it themselves, so one request is also the policy check.
// Ids are the mac bundle id, the lowercase Windows exe name, or the lowercase
// Linux process name. Terminal and System Settings are deliberately allowed.
const BLOCKED_IDS = new Set([
  // Keychains, the login window, and this app itself.
  'com.apple.keychainaccess',
  'com.apple.securityagent',
  'com.apple.security.securityagent',
  'com.apple.localauthentication.uiagent',
  'com.apple.loginwindow',
  'com.apple.passwords',
  'app.alans-way.localapp',
  'alans-way-localapp.exe',
  'alans-way-localapp',
  'seahorse',
  'keeper.exe',
  // consent.exe/LogonUI/LockApp live on the secure desktop; UIA cannot reach
  // them anyway, listing them makes the refusal explicit rather than silent.
  'consent.exe',
  'logonui.exe',
  'lockapp.exe',
  'credentialuibroker.exe',
  'useraccountbroker.exe',
  'sechealthui.exe',
]);

// Substrings, so every vendor's bundle id, exe, and process name is covered
// without listing each variant.
const BLOCKED_KEYWORDS = [
  '1password', 'agilebits', 'bitwarden', 'dashlane', 'keepass', 'lastpass', 'enpass',
  'proton.pass', 'proton pass', 'proton-pass', 'protonpass', 'nordpass', 'roboform',
  'keepersecurity', 'callpod', 'keeperpassword',
];

function isBlocked(id) {
  const value = String(id || '').toLowerCase();
  return BLOCKED_IDS.has(value) || BLOCKED_KEYWORDS.some((word) => value.includes(word));
}

function helperPolicy() {
  return { exact: [...BLOCKED_IDS], contains: [...BLOCKED_KEYWORDS] };
}

module.exports = { BLOCKED_IDS, BLOCKED_KEYWORDS, isBlocked, helperPolicy };
