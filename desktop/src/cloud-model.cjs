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
// USR1 is Hermes's drain-and-exit restart for a supervised gateway: supervisord
// relaunches it. `restart` escalates to SIGKILL after stopwaitsecs, and a kill
// mid-checkpoint corrupts state.db, so it is only the fallback.
function gatewayRestartCommand(statusOutput) {
  const program = shellQuote(gatewayProgram(statusOutput));
  return `supervisorctl signal USR1 ${program} || supervisorctl restart ${program}`;
}

// `hermes auth login` does not exist; the OAuth login for a Claude
// subscription is `hermes auth add anthropic --type oauth`.
function authLoginCommand() {
  return 'hermes auth add anthropic --type oauth';
}
function extractAuthUrl(output) {
  return /https?:\/\/[^\s'"]+/.exec(String(output || ''))?.[0] || '';
}
// Real output is exactly `provider: logged in` (for example
// `anthropic: logged in`); the "not/never logged in" answers and any prose
// that merely contains the words do not count.
function authLoggedIn(statusOutput) {
  return String(statusOutput || '').split('\n')
    .some((line) => /^\s*[a-z0-9._-]+:\s*logged in\s*$/i.test(line));
}

// Query only public model identifiers, never the full config or auth/env files.
// Missing/older CLIs fail closed; main bounds the entire SSH command to 8s.
function existingModelCommand() {
  return `provider=$(hermes config get model.provider 2>/dev/null) && model=$(hermes config get model.default 2>/dev/null) && printf '%s\\n%s\\n' "$provider" "$model"`;
}
// Documented one-shot CLI query, with only read-only search tools exposed. Safe
// mode also excludes configured fallback routes: another provider cannot certify
// this one. Older CLIs/custom routes that cannot run this check fail closed.
// https://hermes-agent.nousresearch.com/docs/reference/cli-commands/
// Bound the remote process group as well as SSH. Only a fixed marker crosses
// SSH; provider errors, diagnostics and credentials are never returned.
function existingModelCheckCommand(existing) {
  const model = parseExistingModel({ code: 0, out: `${existing?.provider || ''}\n${existing?.model || ''}` });
  if (!model) throw new Error('A configured provider and model are required.');
  const args = ['hermes', 'chat', '-Q', '-q', 'Reply OK', '--max-turns', '1', '--safe-mode', '--toolsets', 'search', '--provider', model.provider, '--model', model.model];
  const script = `import os, signal, subprocess, sys
try:
    child = subprocess.Popen(${JSON.stringify(args)}, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, start_new_session=True)
except OSError:
    sys.exit(1)
try:
    out, _ = child.communicate(timeout=10)
except subprocess.TimeoutExpired:
    os.killpg(child.pid, signal.SIGKILL)
    child.communicate()
    sys.exit(124)
if child.returncode != 0 or out.strip() != b'OK':
    sys.exit(1)
print('MODEL_OK')`;
  return `python3 -c ${shellQuote(script)} 2>/dev/null`;
}
function parseExistingModel(result) {
  if (result?.code !== 0) return null;
  const lines = String(result.out || '').trim().split(/\r?\n/);
  if (lines.length !== 2) return null;
  const [provider, model] = lines.map((line) => line.trim());
  // Reject diagnostics, unset values and non-identifiers rather than surfacing
  // arbitrary remote stdout in the wizard. A configured model is not an API test.
  const unset = /^(?:none|null|auto|default|undefined)$/i;
  if (unset.test(provider) || unset.test(model)) return null;
  if (!/^[a-z0-9][a-z0-9._-]{0,79}$/i.test(provider) || !/^[a-z0-9][a-z0-9._:/+-]{0,199}$/i.test(model)) return null;
  if ([provider, model].some((value) => /^sk-/i.test(value) || value.includes('://'))) return null;
  return { provider, model };
}

// Profiles live at ~/.hermes/profiles/<name>/.env; a bare install keeps one
// env file at the home level.
function envPathFor(profile) {
  return profile ? `~/.hermes/profiles/${profile}/.env` : '~/.hermes/.env';
}
function chooseProfile(lsOutput) {
  return String(lsOutput || '').split('\n').map((line) => line.trim()).filter(Boolean).sort()[0] || '';
}

module.exports = { existingModelCommand, existingModelCheckCommand, parseExistingModel, setEnvValue, gatewayProgram, gatewayRestartCommand, authLoginCommand, extractAuthUrl, authLoggedIn, envPathFor, chooseProfile };
