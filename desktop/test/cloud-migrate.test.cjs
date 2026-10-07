const { test } = require('node:test');
const assert = require('node:assert/strict');
const { shellQuote, migrateCommand, migrateCheckCommand, profilesWithToken, MIGRATED_MARKER } = require('../src/cloud-migrate.cjs');

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

test('grep output lists only profile names that carry a bot token', () => {
  const out = '/root/.hermes/profiles/personal/.env\n/root/.hermes/profiles/work/.env\n';
  assert.deepEqual(profilesWithToken(out), ['personal', 'work']);
  assert.deepEqual(profilesWithToken(''), []);
  assert.deepEqual(profilesWithToken('grep: no matches\n'), []);
  assert.deepEqual(profilesWithToken('/home/u/.hermes/profiles/a b/.env'), ['a b']);
});

test('the marker name is the one the agents repo coordinates on', () => {
  assert.equal(MIGRATED_MARKER, '~/.hermes/.migrated');
});
