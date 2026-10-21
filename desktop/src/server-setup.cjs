'use strict';
const { spawn } = require('node:child_process');
const { isSshTarget } = require('./core.cjs');
const { shellQuote } = require('./cloud-migrate.cjs');
const { posixCommand } = require('./remote-shell.cjs');
const { redactReport } = require('./setup-check.cjs');

const SHA = /^[a-f0-9]{40}$/;
// This is a setup plan, not a shell command. Only setup's public, user-chosen
// inputs travel through it. The app supplies the pins and lifecycle flags.
const VALUES = {
  '--bot-id': /^\d+$/, '--bot-name': /^[^\x00-\x1f]{1,100}$/,
  '--mac-ssh': /^[^\x00-\x20]{1,253}$/, '--host-os': /^(mac|windows|linux)$/,
  '--timezone': /^[A-Za-z0-9_+-]+(?:\/[A-Za-z0-9_+-]+)*$/, '--proactive': /^(yes|no)$/,
  '--tone': /^(texting|default)$/, '--profile': /^[a-z0-9][a-z0-9_-]{0,63}$/,
  '--mac-key': /^ssh-(?:ed25519|rsa) [A-Za-z0-9+/=]+(?: [^\r\n]+)?$/,
  '--mac-host-key': /^ssh-(?:ed25519|rsa) [A-Za-z0-9+/=]+(?: [^\r\n]+)?$/,
};
const FLAGS = new Set(['--bind', '--allow-desktop-actions', '--keep-browser', '--keep-computer-use']);
function parseSetupPlan(text) {
  if (typeof text !== 'string' || text.length > 16000) throw new Error('Paste the setup plan from your bot.');
  let plan;
  try { plan = JSON.parse(text); } catch { throw new Error('The setup plan must be JSON from your bot.'); }
  if (!plan || Object.keys(plan).sort().join(',') !== 'args,desktopRef,repoRef' ||
      typeof plan.repoRef !== 'string' || typeof plan.desktopRef !== 'string' ||
      !SHA.test(plan.repoRef) || !SHA.test(plan.desktopRef) || !Array.isArray(plan.args) || plan.args.length > 40)
    throw new Error('The setup plan needs exact reviewed commit pins and setup arguments.');
  const seen = new Set();
  for (let i = 0; i < plan.args.length; i++) {
    const name = plan.args[i];
    if (seen.has(name)) throw new Error('The setup plan repeats an option.');
    seen.add(name);
    if (FLAGS.has(name)) continue;
    const pattern = VALUES[name], value = plan.args[++i];
    // Match the entire value: $ alone also matches before a trailing newline.
    if (!pattern || typeof value !== 'string' || value.length > 4096 || pattern.exec(value)?.[0] !== value)
      throw new Error('The setup plan contains an unsupported option or value. Ask your bot to correct it.');
  }
  for (const key of ['--bot-id', '--mac-ssh', '--host-os', '--timezone', '--proactive'])
    if (!seen.has(key)) throw new Error(`The setup plan is missing ${key}.`);
  return plan;
}
function setupCommand(plan) {
  const args = ['--skip-plugin', '--repo-ref', plan.repoRef, '--desktop-ref', plan.desktopRef,
    ...plan.args, '--non-interactive', '--restart'];
  return posixCommand(`set -eu
cd "$HOME/alans-way-agents"
[ "$(git rev-parse HEAD)" = ${shellQuote(plan.repoRef)} ] || { echo 'Setup checkout does not match the reviewed pin.' >&2; exit 1; }
git diff --quiet HEAD -- || { echo 'Setup checkout has local changes; ask your bot to review them.' >&2; exit 1; }
exec sh ./setup.sh ${args.map(shellQuote).join(' ')}
`);
}
function runSsh(bin, args, { input, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { timeout: timeoutMs });
    let out = '', err = '';
    child.stdout.on('data', (chunk) => { out = (out + chunk).slice(-200000); });
    child.stderr.on('data', (chunk) => { err = (err + chunk).slice(-20000); });
    child.on('error', (error) => resolve({ code: -1, out, err: error.message }));
    child.on('close', (code) => resolve({ code, out, err }));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
function createServerSetup({ run = runSsh } = {}) {
  return async (host, text) => {
    try {
      if (!isSshTarget(String(host || '').trim())) throw new Error('Save the agent machine SSH address first.');
      const plan = parseSetupPlan(text);
      // POSIX gateway hosts only; this command also works in Git Bash when
      // it is the SSH login shell. Do not guess a Windows sshd shell.
      const remote = "if command -v timeout >/dev/null 2>&1; then exec timeout 880 sh -s; elif command -v perl >/dev/null 2>&1; then exec perl -e 'alarm 880; exec @ARGV' sh -s; else echo 'Setup needs timeout or perl on the server.' >&2; exit 1; fi";
      const result = await run('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'StrictHostKeyChecking=yes', host.trim(), remote],
        { input: setupCommand(plan), timeoutMs: 900000 });
      const output = redactReport([result.out, result.err].filter(Boolean).join('\n')).trim();
      return { ok: result.code === 0 && Boolean(output), detail: output || 'The SSH setup did not return a report. Check the connection and retry.',
        ...(result.code === 0 && output ? { note: 'Setup finished. A restart may be scheduled; wait about a minute, message your bot, and ask for the post-restart audit.' } : {}) };
    } catch (error) { return { ok: false, detail: redactReport(error.message) }; }
  };
}
module.exports = { parseSetupPlan, setupCommand, createServerSetup };
