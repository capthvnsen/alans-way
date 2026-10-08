const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createConfig } = require('../electron-builder.cjs');
const { isDeveloperIdSigned, updaterDriver } = require('../src/mac-update.cjs');
const { githubFeed } = require('../src/win-update.cjs');

const SECRETS = { CSC_LINK: 'p12', CSC_KEY_PASSWORD: 'pw', APPLE_ID: 'me@example.com', APPLE_APP_SPECIFIC_PASSWORD: 'app-pw', APPLE_TEAM_ID: 'TEAMID00000' };

test('without the signing secrets the mac build stays ad-hoc', () => {
  const config = createConfig({});
  assert.equal(config.mac.identity, '-');
  assert.equal(config.mac.hardenedRuntime, false);
  assert.equal(config.mac.notarize, false);
  assert.equal(config.afterSign, undefined);
});

test('empty-string secrets count as missing, so forks still build ad-hoc', () => {
  const config = createConfig({ CSC_LINK: '', CSC_KEY_PASSWORD: '', APPLE_ID: '', APPLE_APP_SPECIFIC_PASSWORD: '', APPLE_TEAM_ID: '' });
  assert.equal(config.mac.identity, '-');
});

test('a certificate alone signs, but never notarizes', () => {
  const config = createConfig({ CSC_LINK: 'p12', CSC_KEY_PASSWORD: 'pw' });
  assert.equal(config.mac.identity, undefined);
  assert.equal(config.mac.hardenedRuntime, true);
  assert.equal(config.mac.notarize, false);
  assert.equal(config.afterSign, undefined);
});

test('with all secrets the mac build signs, notarizes and staples', () => {
  const config = createConfig(SECRETS);
  assert.equal(config.mac.identity, undefined);
  assert.equal(config.mac.hardenedRuntime, true);
  assert.equal(config.mac.notarize, true);
  assert.equal(typeof config.afterSign, 'function');
  assert.ok(fs.existsSync(path.join(__dirname, '..', config.mac.entitlements)));
  assert.equal(config.mac.entitlementsInherit, config.mac.entitlements);
});

test('the mac build ships a zip for electron-updater alongside the dmg', () => {
  const targets = createConfig({}).mac.target.map((entry) => entry.target).sort();
  assert.deepEqual(targets, ['dmg', 'zip']);
});

test('the packaged app declares the alansway scheme so open-url reaches it', () => {
  const protocols = createConfig({}).protocols;
  assert.ok(Array.isArray(protocols), 'protocols missing from the build config');
  assert.ok(protocols.some((p) => Array.isArray(p.schemes) && p.schemes.includes('alansway')), JSON.stringify(protocols));
});

test('the publish config feeds GitHub releases', () => {
  assert.deepEqual(createConfig({}).publish, [{ provider: 'github', owner: 'capthvnsen', repo: 'alans-way', releaseType: 'draft' }]);
});

test('the release workflow ships the blockmaps electron-updater diffs against', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '..', '..', '.github', 'workflows', 'release.yml'), 'utf8');
  const releaseUpload = workflow.split('\n').find((line) => line.includes('gh release upload'));
  for (const name of ['OpenAlan-mac.zip.blockmap', 'OpenAlan-windows-setup.exe.blockmap']) {
    assert.ok(workflow.includes(`desktop/dist/${name}`), `${name} is missing from the build artifacts`);
    assert.ok(releaseUpload.includes(`dist/${name}`), `${name} is missing from the release upload`);
  }
});

test('the feed helper uses that publish config for builds without app-update.yml', () => {
  const feed = githubFeed(false, createConfig({}).publish);
  assert.deepEqual(feed, { provider: 'github', owner: 'capthvnsen', repo: 'alans-way' });
});

test('updater selection: electron-updater when signed or on Windows, self-update otherwise', () => {
  assert.equal(updaterDriver('win32', false), 'electron-updater');
  assert.equal(updaterDriver('darwin', true), 'electron-updater');
  assert.equal(updaterDriver('darwin', false), 'self');
  assert.equal(updaterDriver('linux', false), 'none');
});

test('codesign output decides whether the running app is Developer ID signed', () => {
  const signed = () => ({ stdout: '', stderr: 'Executable=/a.app\nSignature=valid\nAuthority=Developer ID Application: Example (TEAMID00000)\nAuthority=Developer ID Certification Authority\n' });
  assert.equal(isDeveloperIdSigned('/a.app', signed), true);
  const adhoc = () => ({ stdout: '', stderr: 'Executable=/a.app\nSignature=adhoc\n' });
  assert.equal(isDeveloperIdSigned('/a.app', adhoc), false);
  const missing = () => ({ stdout: '', stderr: 'a.app: code object is not signed at all', status: 1 });
  assert.equal(isDeveloperIdSigned('/a.app', missing), false);
});

const SCRIPT = path.join(__dirname, '..', 'scripts', 'setup-signing-secrets.sh');

test('the secrets setup script parses as sh', () => {
  assert.equal(spawnSync('sh', ['-n', SCRIPT]).status, 0);
});

function fakeTools(t, { identities, out = 'out.log' }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'signing-test-'));
  const cert = path.join(dir, 'cert.pem');
  const res = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', path.join(dir, 'key.pem'), '-out', cert, '-days', '1', '-nodes', '-subj', '/CN=Developer ID Application: Fixture (TEAMID00000)/OU=TEAMID00000/O=Fixture']);
  assert.equal(res.status, 0, res.stderr);
  const log = path.join(dir, out);
  fs.writeFileSync(path.join(dir, 'security'), `#!/bin/sh
cmd=$1; shift
case "$cmd" in
  find-identity) printf '%s\\n' "$FAKE_IDENTITIES" ;;
  find-certificate) cat "$FAKE_CERT" ;;
  export) prev=''; out=''; for a in "$@"; do [ "$prev" = -o ] && out=$a; prev=$a; done; printf 'fake-p12' > "$out" ;;
  import|create-keychain|unlock-keychain|set-keychain-settings|delete-identity|delete-keychain) ;;
  *) exit 1 ;;
esac
`);
  fs.writeFileSync(path.join(dir, 'gh'), `#!/bin/sh
if [ "$1" = "auth" ]; then exit 0; fi
if [ "$1" = "secret" ]; then printf '%s\\n' "$3" >> "$GH_LOG"; cat >/dev/null; exit 0; fi
exit 1
`);
  fs.chmodSync(path.join(dir, 'security'), 0o755);
  fs.chmodSync(path.join(dir, 'gh'), 0o755);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, log, env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, FAKE_IDENTITIES: identities, FAKE_CERT: cert, GH_LOG: log } };
}

const IDENTITY_LINE = '     1) AABBCCDDEEFF00112233445566778899AABBCC "Developer ID Application: Fixture (TEAMID00000)"\n        1 valid identities found';

test('the setup script sets the five secrets over stdin and prints only names', (t) => {
  const { log, env } = fakeTools(t, { identities: IDENTITY_LINE });
  const res = spawnSync('sh', [SCRIPT], { env, input: 'me@example.com\napp-pw\n', encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split('\n'),
    ['CSC_LINK', 'CSC_KEY_PASSWORD', 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID']);
  assert.match(res.stdout, /CSC_LINK/);
  assert.doesNotMatch(res.stdout + res.stderr, /app-pw|me@example\.com/);
});

test('several identities prompt for a choice', (t) => {
  const two = '     1) AABBCCDDEEFF00112233445566778899AABBCC "Developer ID Application: Fixture (TEAMID00000)"\n  2) BBCCDDEEFF00112233445566778899AABBCCDD "Developer ID Application: Other (OTHERTEAMID)"\n        2 valid identities found';
  const { log, env } = fakeTools(t, { identities: two });
  const res = spawnSync('sh', [SCRIPT], { env, input: '2\nme@example.com\napp-pw\n', encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /Several Developer ID Application identities/);
  assert.match(res.stdout, /Identity: Developer ID Application: Other \(OTHERTEAMID\)/);
  assert.equal(fs.readFileSync(log, 'utf8').trim().split('\n').length, 5);
});

test('dry run prints the secret names without calling gh', (t) => {
  const { log, env } = fakeTools(t, { identities: IDENTITY_LINE });
  const res = spawnSync('sh', [SCRIPT, '--dry-run'], { env, input: 'me@example.com\napp-pw\n', encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(fs.existsSync(log), false);
  for (const name of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'])
    assert.match(res.stdout, new RegExp(name));
});

test('a missing identity fails with a clear message', (t) => {
  const { env } = fakeTools(t, { identities: '     0 valid identities found' });
  const res = spawnSync('sh', [SCRIPT], { env, input: '', encoding: 'utf8' });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /Developer ID/);
});
