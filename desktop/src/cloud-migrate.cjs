// Moving an existing Hermes to the new computer: the user runs the migrate
// script on the old machine, it leaves ~/.hermes/.migrated behind (and
// ~/.hermes.pre-migrate-* backups), and we inventory which profiles already
// carry a Telegram bot token without ever reading token values.
'use strict';

// Wrapped in single quotes with the standard '\'' escape, any host string
// reaches bash as one literal word.
function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function migrateCommand(sshHost) {
  return `curl -fsSL https://openalan.com/migrate | bash -s -- --to ${shellQuote(sshHost)}`;
}

// Marker name coordinated with the agents repo: the migrate script touches it
// when a Hermes home has been moved in.
const MIGRATED_MARKER = '~/.hermes/.migrated';
function migrateCheckCommand() {
  return `ls -d ${MIGRATED_MARKER} ~/.hermes.pre-migrate-* 2>/dev/null`;
}

// -l prints paths only: the token value itself never crosses SSH. Tokens on
// real installs also live in the shared ~/.hermes/.env and in
// ~/.hermes/.secrets/*.env, and Orgo's env writer emits `export KEY='v'`, so
// all three places and both line shapes are covered.
function profilesWithTokenCommand() {
  return `grep -lE '^[[:space:]]*(export[[:space:]]+)?TELEGRAM_BOT_TOKEN=' ~/.hermes/profiles/*/.env ~/.hermes/.env ~/.hermes/.secrets/*.env 2>/dev/null`;
}

// A token found outside a profile env (the shared home .env or the secrets
// dir) covers the whole install — minting another bot would write a
// conflicting token.
const SHARED_TOKEN = '*';
function profilesWithToken(grepOutput) {
  return [...new Set(String(grepOutput || '').split('\n')
    .map((line) => line.trim())
    .filter((line) => line.endsWith('.env'))
    .map((line) => /profiles\/(.+)\/\.env$/.exec(line)?.[1] || SHARED_TOKEN))];
}

// The '*' sentinel marks a shared-env token, not a profile — keep it out of
// any "N profiles" count shown to the user.
function namedTokenedProfiles(tokened) {
  return (Array.isArray(tokened) ? tokened : []).filter((name) => name !== SHARED_TOKEN);
}

// `ls ~/.hermes/profiles` gives one profile name per line.
function profileNames(lsOutput) {
  return String(lsOutput || '').split('\n').map((line) => line.trim()).filter(Boolean).sort();
}

module.exports = { shellQuote, migrateCommand, migrateCheckCommand, profilesWithTokenCommand, profilesWithToken, namedTokenedProfiles, profileNames, MIGRATED_MARKER, SHARED_TOKEN };
