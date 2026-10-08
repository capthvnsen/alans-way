const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { shellQuote, migrateCommand, migrateCheckCommand, profilesWithTokenCommand, profilesWithToken, profileNames, namedTokenedProfiles, MIGRATED_MARKER, SHARED_TOKEN } = require('../src/cloud-migrate.cjs');

test('the migrate command quotes the destination host for the local shell', () => {
  assert.equal(migrateCommand('me@vps'), "curl -fsSL https://openalan.com/migrate | bash -s -- --to 'me@vps'");
  assert.equal(migrateCommand("o'hare@host name"), "curl -fsSL https://openalan.com/migrate | bash -s -- --to 'o'\\''hare@host name'");
});

test('single-quote wrapping survives shell-special characters', () => {
  assert.equal(shellQuote("a'b"), `'a'\\''b'`);
  assert.equal(shellQuote('$(rm -rf /)'), `'$(rm -rf /)'`);
  assert.equal(shellQuote(''), `''`);
});

test('the marker check watches for the migrated flag and pre-migrate backups', () => {
  const command = migrateCheckCommand();
  assert.ok(command.includes('.hermes/.migrated'), command);
  assert.ok(command.includes('.hermes.pre-migrate-'), command);
  assert.ok(command.includes('2>/dev/null'), command);
});

test('either marker alone prints a match even though ls exits non-zero', (t) => {
  if (process.platform === 'win32') return t.skip('posix sh only');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-check-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.hermes'));
  fs.writeFileSync(path.join(home, '.hermes', '.migrated'), '');
  const res = spawnSync('sh', ['-c', migrateCheckCommand()], { env: { ...process.env, HOME: home } });
  assert.ok(res.stdout.toString().includes('.migrated'), `stdout: ${res.stdout}`);
  assert.equal(res.stderr.toString(), '', 'errors stay off the wire');
});

test('the token grep covers profile envs, the home env and the secrets dir, export lines included', () => {
  const command = profilesWithTokenCommand();
  assert.ok(command.includes('-l'), command);
  assert.ok(command.includes('export'), command, 'orgo writes export KEY= lines');
  assert.ok(command.includes('~/.hermes/.env'), command);
  assert.ok(command.includes('.secrets'), command);
  assert.ok(command.includes('~/.hermes/profiles/*/.env'), command);
});

test('grep output lists profile names; tokens elsewhere report the shared sentinel', () => {
  const out = '/root/.hermes/profiles/personal/.env\n/root/.hermes/profiles/work/.env\n';
  assert.deepEqual(profilesWithToken(out), ['personal', 'work']);
  assert.deepEqual(profilesWithToken(''), []);
  assert.deepEqual(profilesWithToken('grep: no matches\n'), []);
  assert.deepEqual(profilesWithToken('/home/user/.hermes/profiles/a b/.env'), ['a b']);
  assert.deepEqual(profilesWithToken('/root/.hermes/.env\n'), [SHARED_TOKEN]);
  assert.deepEqual(profilesWithToken('/root/.hermes/.secrets/telegram-bots.env\n/root/.hermes/profiles/work/.env\n'), [SHARED_TOKEN, 'work']);
});

test('the shared-env sentinel is not counted as a profile', () => {
  assert.deepEqual(namedTokenedProfiles([SHARED_TOKEN, 'work']), ['work']);
  assert.deepEqual(namedTokenedProfiles([SHARED_TOKEN]), []);
  assert.deepEqual(namedTokenedProfiles(['work']), ['work']);
  assert.deepEqual(namedTokenedProfiles(undefined), []);
});

test('profileNames parses the remote ls of the profiles dir', () => {
  assert.deepEqual(profileNames('work\npersonal\n'), ['personal', 'work']);
  assert.deepEqual(profileNames(''), []);
});

test('the marker name is the one the agents repo coordinates on', () => {
  assert.equal(MIGRATED_MARKER, '~/.hermes/.migrated');
});
