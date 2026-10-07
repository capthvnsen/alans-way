const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isBlocked, helperPolicy } = require('../src/computer-policy.cjs');

test('password managers, keychains, login surfaces, and this app are off limits on every OS', () => {
  for (const id of [
    'com.apple.keychainaccess', 'com.apple.SecurityAgent', 'com.apple.security.SecurityAgent',
    'com.apple.LocalAuthentication.UIAgent', 'com.apple.loginwindow', 'com.apple.Passwords',
    'com.1password.1password', 'com.agilebits.onepassword7', 'com.bitwarden.desktop',
    'com.dashlane.dashlanephonefinal', 'org.keepassxc.keepassxc', 'com.lastpass.LastPass',
    'com.sinew.Enpass-Desktop', 'me.proton.pass.electron', 'app.alans-way.localapp',
    '1Password.exe', 'Bitwarden.exe', 'Dashlane.exe', 'KeePassXC.exe', 'KeePass.exe', 'LastPass.exe',
    'Enpass.exe', 'Proton Pass.exe', 'ProtonPass.exe', 'alans-way-localapp.exe',
    'consent.exe', 'LogonUI.exe', 'LockApp.exe',
    'com.nordsec.nordpass', 'NordPass.exe', 'com.callpod.keepermac.lite', 'KeeperPasswordManager.exe', 'keeper.exe', 'RoboForm.exe', 'com.siber.roboform',
    'keepassxc', '1password', 'bitwarden', 'alans-way-localapp', 'seahorse',
  ]) assert.equal(isBlocked(id), true, id);
});

test('Terminal, System Settings, and ordinary apps stay drivable', () => {
  for (const id of ['com.apple.Terminal', 'com.apple.systempreferences', 'com.apple.TextEdit', 'notepad.exe', 'gedit', '', undefined])
    assert.equal(isBlocked(id), false, String(id));
});

test('the helper receives the same policy as lowercase exact ids and substrings', () => {
  const policy = helperPolicy();
  assert.ok(policy.exact.includes('com.apple.passwords'));
  assert.ok(policy.exact.includes('app.alans-way.localapp'));
  assert.ok(policy.contains.includes('1password'));
  for (const value of [...policy.exact, ...policy.contains]) assert.equal(value, value.toLowerCase());
});
