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

// -l prints paths only: the token value itself never crosses SSH.
function profilesWithTokenCommand() {
  return `grep -l '^TELEGRAM_BOT_TOKEN=' ~/.hermes/profiles/*/.env 2>/dev/null`;
}

function profilesWithToken(grepOutput) {
  return String(grepOutput || '').split('\n')
    .map((line) => /profiles\/(.+)\/\.env\s*$/.exec(line.trim())?.[1])
    .filter(Boolean);
}

module.exports = { shellQuote, migrateCommand, migrateCheckCommand, profilesWithTokenCommand, profilesWithToken, MIGRATED_MARKER };
