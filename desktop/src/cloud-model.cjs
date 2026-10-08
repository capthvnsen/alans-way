// Choosing the model login on the new computer: a Claude subscription signs
// in through the hermes OAuth flow, or an API key is written to the chosen
// profile's .env. ANTHROPIC_BASE_URL is never written, and no key is written
// for the subscription path — the gateway only restarts after the env edit.
'use strict';
const { shellQuote } = require('./cloud-migrate.cjs');

// One KEY=value line replaced or appended; every other byte of the file is
// preserved exactly. The value is single-quoted for the remote shell.
function setEnvValue(text, key, value) {
  if (key === 'ANTHROPIC_BASE_URL') return String(text ?? '');
  const line = `${key}=${shellQuote(value)}`;
  const source = String(text ?? '');
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  if (pattern.test(source)) return source.replace(pattern, line);
  if (!source) return line + '\n';
  return source.endsWith('\n') ? source + line + '\n' : source + '\n' + line + '\n';
}

// The gateway's supervisor program name is read from the machine; when nothing
// matches, restart only the gateway — never 'all', which would bounce the
// tailscaled and other Orgo programs mid-onboarding.
function gatewayProgram(statusOutput) {
  for (const line of String(statusOutput || '').split('\n')) {
    const name = line.trim().split(/\s+/)[0] || '';
    if (/gateway/i.test(name)) return name;
  }
  return 'hermes-gateway';
}
function gatewayRestartCommand(statusOutput) {
  return `supervisorctl restart ${shellQuote(gatewayProgram(statusOutput))}`;
}

// `hermes auth login` does not exist; the OAuth login for a Claude
// subscription is `hermes auth add anthropic --type oauth`.
function authLoginCommand() {
  return 'hermes auth add anthropic --type oauth';
}
function extractAuthUrl(output) {
  return /https?:\/\/[^\s'"]+/.exec(String(output || ''))?.[0] || '';
}
// "not logged in" and "never logged in" are the unauthenticated answers, so a
// line only counts when the negation is absent.
function authLoggedIn(statusOutput) {
  return String(statusOutput || '').split('\n')
    .some((line) => /logged in/i.test(line) && !/\b(?:not|never)\b/i.test(line));
}

// Profiles live at ~/.hermes/profiles/<name>/.env; a bare install keeps one
// env file at the home level.
function envPathFor(profile) {
  return profile ? `~/.hermes/profiles/${profile}/.env` : '~/.hermes/.env';
}
function chooseProfile(lsOutput) {
  return String(lsOutput || '').split('\n').map((line) => line.trim()).filter(Boolean).sort()[0] || '';
}

module.exports = { setEnvValue, gatewayProgram, gatewayRestartCommand, authLoginCommand, extractAuthUrl, authLoggedIn, envPathFor, chooseProfile };
