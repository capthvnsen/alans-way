// Give historical acceptance harnesses current source paths and temporary evidence.
// Keep live suites sequential so they never compete with each other for focus.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const desktop = path.resolve(__dirname, '..');
const live = ['approval-proxy', 'browser-reliability', 'browser-reload',
  'hermes-conversation-native', 'hermes-session-wire-native', 'keyboard-navigation', 'shortcut-reference'];
const stable = ['browser-continuation', 'browser-recovery', 'connections-drafts', 'connections-journey',
  'hermes-conversation-electron', 'hermes-session-wire-electron', 'home-first-action',
  'plugin-approval-binding-headless', 'plugin-target-binding-headless', 'settings-async',
  'settings-navigation', 'settings-pending-recovery', 'settings-persistence', 'shortcut-query',
  'shortcut-round2', 'state-ordering'];
const requested = process.argv.slice(2);
const names = requested[0] === '--live' ? live : requested;
if (!names.length || names.some(name => ![...stable, ...live].includes(name))) {
  console.error('Pass a workspace suite name or --live.'); process.exit(2);
}
let failed = false;
for (const name of names) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), `workspace-${name}-`));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  for (const key of ['HERMES_APPROVAL_EVIDENCE', 'HERMES_BINDING_EVIDENCE', 'HERMES_APPROVAL_PROXY_EVIDENCE',
    'HERMES_RELIABILITY_EVIDENCE', 'BROWSER_RECOVERY_OUT', 'CONNECTIONS_OUT', 'SETTINGS_EVIDENCE_DIR',
    'SETTINGS_RECOVERY_OUT', 'SETTINGS_PERSISTENCE_OUT', 'SHORTCUT_QUERY_OUT', 'SHORTCUT_EVIDENCE_DIR',
    'KEYBOARD_EVIDENCE_DIR', 'STATE_ORDERING_EVIDENCE_DIR']) env[key] ||= out;
  for (const key of ['SETTINGS_RECOVERY_TARGET', 'SETTINGS_PERSISTENCE_TARGET']) env[key] ||= desktop;
  env.SETTINGS_RECOVERY_PHASE ||= 'green';
  env.BROWSER_RELOAD_OUT ||= path.join(out, 'reload'); // Harness requires a new directory.
  let args;
  if (name.endsWith('-native')) {
    args = [path.join(__dirname, `${name}.cjs`), '--out', path.join(out, 'native'), '--module',
      path.join(desktop, 'src', name.replace('-native', '.cjs'))];
    if (name === 'hermes-conversation-native') args.push('--wire', path.join(desktop, 'src/hermes-session-wire.cjs'));
  } else if (name.startsWith('plugin-') || ['browser-recovery', 'browser-reload'].includes(name)) {
    args = [path.join(__dirname, `${name}${name.startsWith('browser-') ? '-electron' : ''}.cjs`)];
  } else if (['hermes-conversation-electron', 'hermes-session-wire-electron'].includes(name)) {
    env.ELECTRON_RUN_AS_NODE = '1';
    args = [path.join(__dirname, `${name}.cjs`)];
  } else {
    args = [path.join(__dirname, 'run-electron.cjs'), path.join(__dirname, `${name}-electron.cjs`)];
  }
  console.log(`Running ${name}; evidence: ${out}`);
  const executable = env.ELECTRON_RUN_AS_NODE === '1' ? require('electron') : process.execPath;
  const result = spawnSync(executable, args, { cwd: desktop, env, stdio: 'inherit', timeout: 300000 });
  if (result.error) console.error(result.error.message);
  const ok = result.status === 0 && !result.signal && !result.error;
  console.log(`${ok ? 'PASS' : 'FAIL'} suite: ${name}`);
  failed ||= !ok;
}
process.exitCode = failed ? 1 : 0;
