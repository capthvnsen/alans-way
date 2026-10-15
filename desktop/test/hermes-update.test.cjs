// Covers the settings "Update Hermes" button end to end: the cjs half that
// pipes scripts/hermes-update.sh over ssh, and the script itself run against
// a fake hermes binary and fixture profiles. No real hermes or VM is touched.
const { test, after } = require('node:test');
const { posixCommand } = require('../src/remote-shell.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');
const { createVmUpdater, hermesUpdateDetail, updateLocked, HERMES_UPDATE_TIMEOUT_MS } = require('../src/vm-update.cjs');

const SCRIPT = path.join(__dirname, '../scripts/hermes-update.sh');
const WINDOWS_SCRIPT = path.join(__dirname, '../scripts/hermes-update.ps1');
const SCRIPTS = {
  'hermes-update.sh': '# fake hermes-update posix payload\n',
  'hermes-update.ps1': '# fake hermes-update windows payload\n',
};
const readScript = (name) => {
  assert.ok(name in SCRIPTS, `unexpected bundled script ${name}`);
  return SCRIPTS[name];
};
const vm = (over = {}) => ({
  id: 'agent', label: 'VPS', sshHost: 'user@vm.example',
  scriptPath: '/home/user/.local/share/hermes-alans-way/app/desktop/scripts/vps-browser-host.cjs',
  sudo: false, ...over,
});
const okLine = (extra = {}) => `${JSON.stringify({ ok: true, version: '0.21.7', updated: true, error: '', messaged: true,
  messages: [{ profile: 'default', sent: true, error: '' }], ...extra })}\n`;

function fakeRun(respond) {
  const calls = [];
  const run = (bin, args, opts = {}) => {
    calls.push({ bin, args, opts });
    return Promise.resolve(typeof respond === 'function' ? respond({ bin, args, opts }) : respond);
  };
  return { calls, run };
}

test('invalid saved ssh addresses are refused before ssh is spawned', async () => {
  for (const sshHost of ['host;id', 'host$(id)', '-oProxyCommand=x', 'user@host;id', 'a b', 'u@h`id`']) {
    const { calls, run } = fakeRun({ code: 0, out: '', err: '' });
    const updater = createVmUpdater({ run, readScript });
    const result = await updater.hermesUpdateVm(vm({ sshHost }));
    assert.equal(result.ok, false, sshHost);
    assert.equal(calls.length, 0, sshHost);
  }
});

test('the POSIX hermes-update script is piped over ssh stdin under the update timeout', async () => {
  const { calls, run } = fakeRun({ code: 0, out: `hermes-update: telling your bot to message you\n${okLine()}`, err: '' });
  const updater = createVmUpdater({ run, readScript });
  const result = await updater.hermesUpdateVm(vm());
  assert.equal(result.ok, true);
  assert.equal(result.state, 'ok');
  assert.equal(result.version, '0.21.7');
  assert.equal(result.updated, true);
  assert.equal(result.messaged, true);
  assert.deepEqual(result.messages, [{ profile: 'default', sent: true, error: '' }]);
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(call.bin, 'ssh');
  assert.deepEqual(call.args.slice(0, -2), ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'StrictHostKeyChecking=yes']);
  assert.equal(call.args.at(-2), 'user@vm.example');
  assert.match(call.args.at(-1), /timeout \d+ sh -s/, 'a remote-side cap bounds a run whose ssh dies');
  assert.equal(call.opts.input, posixCommand(SCRIPTS['hermes-update.sh']));
  assert.equal(call.opts.timeoutMs, HERMES_UPDATE_TIMEOUT_MS);
});

test('a Windows guest gets the PowerShell twin over cmd', async () => {
  const { calls, run } = fakeRun({ code: 0, out: okLine({ gatewayRestarted: true }), err: '' });
  const updater = createVmUpdater({ run, readScript });
  const result = await updater.hermesUpdateVm(vm({ scriptPath: 'C:\\Users\\a b\\app\\desktop\\scripts\\vps-browser-host.cjs' }));
  assert.equal(result.ok, true);
  assert.equal(result.gatewayRestarted, true, 'the Windows script reports the gateway came back up');
  assert.equal(calls[0].opts.input, SCRIPTS['hermes-update.ps1']);
  assert.match(calls[0].args.at(-1), /powershell/);
  assert.doesNotMatch(calls[0].args.at(-1), /ALANS_WAY_VM_TAG/);
});

test('a guest without a saved scriptPath is probed for its platform once', async () => {
  const { calls, run } = fakeRun(({ args }) => args.at(-1) === 'node -p process.platform'
    ? { code: 0, out: 'win32\n', err: '' }
    : { code: 0, out: okLine(), err: '' });
  const updater = createVmUpdater({ run, readScript });
  await updater.hermesUpdateVm(vm({ scriptPath: '' }));
  assert.equal(calls[0].args.at(-1), 'node -p process.platform');
  assert.equal(calls[1].opts.input, SCRIPTS['hermes-update.ps1']);
});

test('a failed update still reports which profiles messaged the user', async () => {
  const line = JSON.stringify({ ok: false, version: '0.21.6', updated: false, error: 'git pull failed', messaged: true,
    messages: [{ profile: 'default', sent: true, error: '' }] });
  const { run } = fakeRun({ code: 1, out: `hermes-update: hermes update failed: git pull failed\n${line}\n`, err: '' });
  const updater = createVmUpdater({ run, readScript });
  const result = await updater.hermesUpdateVm(vm());
  assert.equal(result.ok, false);
  assert.equal(result.state, 'failed');
  assert.equal(result.error, 'git pull failed');
  assert.equal(result.messaged, true);
  assert.equal(result.version, '0.21.6');
});

test('an unreachable guest reports a failure instead of throwing', async () => {
  const { run } = fakeRun({ code: 255, out: '', err: 'ssh: connect to host vm.example port 22: Connection refused' });
  const updater = createVmUpdater({ run, readScript });
  const result = await updater.hermesUpdateVm(vm());
  assert.equal(result.ok, false);
  assert.match(result.error, /Could not reach the VM over SSH/);
});

// The update lock is one shared predicate all three main.cjs entry points
// consult before starting work on the agent machine: update-now, vm-update-
// retry and hermes-update. Both directions are covered so a one-sided check
// can never regress into two concurrent updates on the same machine.
test('update-now and vm-update-retry are locked out while a hermes update runs', () => {
  assert.equal(updateLocked({ hermesUpdating: true }), true);
  assert.equal(updateLocked({ updateBusy: false, vmRetrying: false, hermesUpdating: true }), true);
  assert.equal(updateLocked({}), false, 'an idle machine is not locked');
});

test('every update path is locked out while "Update everything" runs', () => {
  assert.equal(updateLocked({ updatingAll: true }), true);
  assert.equal(updateLocked({ updateBusy: false, vmRetrying: false, hermesUpdating: false, updatingAll: false }), false);
});

test('hermes-update is locked out while an app or VM update runs', () => {
  assert.equal(updateLocked({ updateBusy: true }), true);
  assert.equal(updateLocked({ vmRetrying: true }), true);
  assert.equal(updateLocked({ updateBusy: false, vmRetrying: false, hermesUpdating: false }), false);
});

// Regression guard for the one-way lock: all three cases in main.cjs must
// gate on updateLocked with hermesUpdating passed in, so a revert to a bare
// `if (update.busy) break` fails here.
test('main.cjs routes every update command through the shared lock', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/main.cjs'), 'utf8');
  for (const cmd of ['update-now', 'vm-update-retry', 'hermes-update', 'update-all', 'update-all-restart']) {
    const guard = new RegExp(`case '${cmd}':\\s*\\{\\s*if \\(updateLocked\\(\\{[^)]*hermesUpdating, updatingAll[^)]*\\}\\)`);
    assert.match(src, guard, `${cmd} must refuse via updateLocked({ ..., hermesUpdating, updatingAll })`);
  }
});

// Source guards for the rules a stubbed Electron run cannot reach: every
// update path waits out an in-flight version probe once it holds the lock;
// a restart over a working bot asks first; quitting mid-run never installs
// the staged app.
const caseBody = (src, cmd) => src.slice(src.indexOf(`case '${cmd}': {`), src.indexOf('\n      case ', src.indexOf(`case '${cmd}': {`) + 10));
test('every update path waits for an in-flight version check before touching the machine', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/main.cjs'), 'utf8');
  for (const cmd of ['update-now', 'vm-update-retry', 'hermes-update', 'update-all']) {
    const body = caseBody(src, cmd);
    assert.match(body, /await waitForVersionCheck\(\)/, `${cmd} must wait for the probe`);
    assert.ok(body.indexOf('updateLocked') < body.indexOf('waitForVersionCheck'), `${cmd} takes the lock before waiting`);
  }
});
test('Restart to finish asks before interrupting a working bot, and a run holds the app install', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/main.cjs'), 'utf8');
  const restart = caseBody(src, 'update-all-restart');
  assert.ok(restart.indexOf('restartWarning(') > 0 && restart.indexOf('restartWarning(') < restart.indexOf('restartIntoUpdate('), 'warns before restarting');
  assert.match(restart, /computeBotWork\(\)/);
  const run = caseBody(src, 'update-all');
  assert.match(run, /holdAppInstall\(true\)/);
  assert.match(run, /finally \{[^}]*holdAppInstall\(false\)/, 'the hold always lifts');
  assert.match(src, /autoInstallOnAppQuit = !hold/);
});

test('hermesUpdateDetail always reports whether the bot messaged', () => {
  const base = { before: '0.21.6', version: '0.21.7', updated: true };
  assert.equal(hermesUpdateDetail({ ok: true, messaged: true, messages: [{ profile: 'default', sent: true, error: '' }], ...base }, 'VPS'),
    'Hermes updated to v0.21.7 on the VPS; your bot messaged you on Telegram.');
  assert.equal(hermesUpdateDetail({ ok: true, updated: false, current: true, messaged: true, messages: [], version: '0.21.7' }, 'VPS'),
    'Hermes is already up to date on the VPS; your bot messaged you on Telegram.');
  assert.equal(hermesUpdateDetail({ ok: true, messaged: false, messages: [{ profile: 'default', sent: false, error: 'no telegram' }], ...base }, 'VPS'),
    'Hermes updated to v0.21.7 on the VPS, but the bot could not message you: no telegram');
  assert.equal(hermesUpdateDetail({ ok: true, messaged: false, messages: [], ...base }, 'VPS'),
    'Hermes updated to v0.21.7 on the VPS, but the bot could not message you (no Hermes profile answered)');
  assert.equal(hermesUpdateDetail({ ok: false, error: 'git pull failed', messaged: true, messages: [] }, 'VPS'),
    'git pull failed Your bot still messaged you.');
  assert.equal(hermesUpdateDetail({ ok: false, error: 'git pull failed', messaged: false, messages: [] }, 'VPS'),
    'git pull failed');
});

// --- the guest script against a fake hermes --------------------------------

const tmpdirs = [];
const mktemp = (prefix) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); tmpdirs.push(dir); return dir; };
after(() => { for (const dir of tmpdirs) fs.rmSync(dir, { recursive: true, force: true }); });

// A fake hermes: logs every argv line, then answers `update`/`--version`/`send`
// from control files under $FAKE_HERMES_STATE (update-rc, update-out, version,
// send-rc, send-fail with one profile name per line).
function makeHermes() {
  const dir = mktemp('hermes-update-bin-');
  const state = mktemp('hermes-update-state-');
  const log = path.join(state, 'hermes.log');
  fs.writeFileSync(path.join(dir, 'hermes'), `#!/bin/sh
echo "hermes $*" >> "${log}"
prof="default"
cmd="$1"
[ "$cmd" = "-p" ] && { prof="$2"; shift 2; cmd="$1"; }
case "$cmd" in
  update) if [ "\${2:-}" = --check ]; then cat "${state}/check-out" 2>/dev/null; exit 0; fi
          if ! grep -Eiq "already up.to.date|nothing to update|no update available" "${state}/update-out" 2>/dev/null; then touch "${state}/updated"; fi
          cat "${state}/update-out" 2>/dev/null
          rc="$(cat "${state}/update-rc" 2>/dev/null)"; exit "\${rc:-0}";;
  --version) echo "Hermes Agent v$(cat "${state}/version" 2>/dev/null || { [ -f "${state}/updated" ] && echo 9.9.9 || echo 9.9.8; }) (test) · stable"; exit 0;;
  send) for last in "$@"; do :; done
        echo "send $prof: $last" >> "${state}/sends.log"
        grep -qxF "$prof" "${state}/send-fail" 2>/dev/null && { echo "no telegram target"; exit 1; }
        rc="$(cat "${state}/send-rc" 2>/dev/null)"; exit "\${rc:-0}";;
esac
exit 0
`, { mode: 0o755 });
  return { bin: dir, state, log, sendLog: path.join(state, 'sends.log') };
}
// The profile layout list_profiles counts: default home, one named profile
// with an identity marker, one tombstoned profile that must be skipped.
function makeHermesHome() {
  const home = mktemp('hermes-update-home-');
  fs.mkdirSync(path.join(home, 'profiles', 'coder'), { recursive: true });
  fs.writeFileSync(path.join(home, 'profiles', 'coder', 'config.yaml'), 'profile: coder\n');
  fs.mkdirSync(path.join(home, 'profiles', '.deleted'), { recursive: true });
  fs.mkdirSync(path.join(home, 'profiles', 'ghost'), { recursive: true });
  fs.writeFileSync(path.join(home, 'profiles', 'ghost', 'config.yaml'), 'profile: ghost\n');
  fs.writeFileSync(path.join(home, 'profiles', '.deleted', 'ghost'), '');
  return home;
}
const runScript = (env) => new Promise((resolve, reject) => {
  const child = spawn('sh', [SCRIPT], { env: { ...process.env, ...env } });
  let stdout = '', stderr = '';
  const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`script timed out\n${stdout}\n${stderr}`)); }, 30000);
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('error', reject);
  child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
});
const lastJson = (res) => {
  const lines = res.stdout.trim().split('\n').filter((line) => line.startsWith('{'));
  assert.ok(lines.length, `no JSON result line in:\n${res.stdout}\n${res.stderr}`);
  return JSON.parse(lines.at(-1));
};
const envFor = (bin, state, extra = {}) => ({
  // A closed PATH and HOME so the script can never reach the real hermes CLI
  // or the ~/.hermes of the machine running the test.
  PATH: `${bin}:/usr/bin:/bin`,
  HOME: mktemp('hermes-update-fakehome-'),
  HERMES_HOME: extra.HERMES_HOME || '',
  FAKE_HERMES_STATE: state,
  ALANS_WAY_HERMES_BUDGET: '120',
  ALANS_WAY_HERMES_UPDATE_TIMEOUT: '20',
  ALANS_WAY_HERMES_SEND_TIMEOUT: '10',
  ...extra,
});

test('the shipped hermes-update scripts parse cleanly', () => {
  const res = spawnSync('sh', ['-n', SCRIPT], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  assert.ok(fs.existsSync(WINDOWS_SCRIPT), 'the Windows guest twin ships alongside');
  assert.match(fs.readFileSync(SCRIPT, 'utf8'), /timeout -k 5 "\$_secs"/, 'a timed-out hermes call is killed, not left running');
});

test('hermes update runs, then every live profile messages the user', async () => {
  const { bin, state, log, sendLog } = makeHermes();
  const res = await runScript(envFor(bin, state, { HERMES_HOME: makeHermesHome() }));
  const result = lastJson(res);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(result.ok, true);
  assert.equal(result.version, '9.9.9');
  assert.equal(result.updated, true);
  assert.equal(result.messaged, true);
  assert.deepEqual(result.messages.map((m) => [m.profile, m.sent]), [['default', true], ['coder', true]]);
  const calls = fs.readFileSync(log, 'utf8');
  assert.match(calls, /^hermes update --yes --keep-stash$/m, 'local edits stay parked in git stash');
  const sends = fs.readFileSync(sendLog, 'utf8');
  assert.match(sends, /^send default: Hermes update finished on .+\. Now on v9\.9\.9\.$/m);
  assert.match(sends, /^send coder: Hermes update finished on .+\. Now on v9\.9\.9\.$/m);
  assert.doesNotMatch(sends, /send ghost:/);
});

test('an already-current install reports updated:false but still messages', async () => {
  const { bin, state } = makeHermes();
  fs.writeFileSync(path.join(state, 'update-out'), 'Already up to date.\n');
  fs.writeFileSync(path.join(state, 'check-out'), 'Up to date with the latest release.\n');
  const res = await runScript(envFor(bin, state, { HERMES_HOME: makeHermesHome() }));
  const result = lastJson(res);
  assert.equal(result.ok, true);
  assert.equal(result.updated, false);
  assert.match(fs.readFileSync(path.join(state, 'sends.log'), 'utf8'), /already up to date/);
});

test('a failed update is reported and the bot still messages the failure', async () => {
  const { bin, state, sendLog } = makeHermes();
  fs.writeFileSync(path.join(state, 'update-rc'), '3');
  fs.writeFileSync(path.join(state, 'update-out'), 'git pull failed: merge conflict\n');
  const res = await runScript(envFor(bin, state, { HERMES_HOME: makeHermesHome() }));
  const result = lastJson(res);
  assert.notEqual(res.status, 0);
  assert.equal(result.ok, false);
  assert.match(result.error, /merge conflict/);
  assert.equal(result.messaged, true);
  assert.match(fs.readFileSync(sendLog, 'utf8'), /Hermes update failed on .+: git pull failed: merge conflict/);
});

test('a profile whose send fails is recorded without losing the update result', async () => {
  const { bin, state } = makeHermes();
  fs.writeFileSync(path.join(state, 'send-fail'), 'coder\n');
  const res = await runScript(envFor(bin, state, { HERMES_HOME: makeHermesHome() }));
  const result = lastJson(res);
  assert.equal(result.ok, true);
  assert.equal(result.messaged, true);
  assert.deepEqual(result.messages.map((m) => [m.profile, m.sent]), [['default', true], ['coder', false]]);
});

test('quiet mode updates without messaging; the message waits for the end of "Update everything"', async () => {
  const { bin, state, log, sendLog } = makeHermes();
  const res = await runScript(envFor(bin, state, { HERMES_HOME: makeHermesHome(), ALANS_WAY_HERMES_QUIET: '1' }));
  const result = lastJson(res);
  assert.equal(result.ok, true);
  assert.equal(result.updated, true);
  assert.deepEqual([result.messaged, result.messages], [false, []]);
  assert.match(fs.readFileSync(log, 'utf8'), /^hermes update --yes --keep-stash$/m);
  assert.equal(fs.existsSync(sendLog), false, 'no bot was asked to send anything');
});

test('report mode skips the update and every profile sends the given text, prelude and all', () => {
  const { bin, state, log, sendLog } = makeHermes();
  const env = envFor(bin, state, { HERMES_HOME: makeHermesHome() });
  // The app prepends the assignment to the piped script (vm-update.cjs).
  const input = `ALANS_WAY_HERMES_REPORT='Update everything finished. Now on Hermes 0.21.7.'\n${fs.readFileSync(SCRIPT, 'utf8')}`;
  const res = spawnSync('sh', ['-s'], { input, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 30000 });
  const result = lastJson({ stdout: res.stdout, stderr: res.stderr });
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual([result.ok, result.updated, result.messaged], [true, false, true]);
  assert.doesNotMatch(fs.readFileSync(log, 'utf8'), /hermes update/, 'no second update');
  const sends = fs.readFileSync(sendLog, 'utf8');
  assert.match(sends, /^send default: Update everything finished\. Now on Hermes 0\.21\.7\.$/m);
  assert.match(sends, /^send coder: Update everything finished\. Now on Hermes 0\.21\.7\.$/m);
});

test('the Windows twin carries the same quiet and report switches', () => {
  const ps1 = fs.readFileSync(WINDOWS_SCRIPT, 'utf8');
  assert.match(ps1, /\$quiet = \$env:ALANS_WAY_HERMES_QUIET/);
  assert.match(ps1, /\$report = \$env:ALANS_WAY_HERMES_REPORT/);
  assert.match(ps1, /if \(\$report\) \{ break \}/, 'report mode never stops a gateway');
  assert.match(ps1, /if \(\$report\) \{ \$r = @\{ code = 0; out = '' \} \} else \{/, 'report mode never runs hermes update');
  assert.match(ps1, /if \(\$quiet\) \{\s+Say 'the message waits/, 'quiet mode sends nothing');
});

test('a machine without the hermes CLI fails cleanly', async () => {
  const state = mktemp('hermes-update-state-');
  const res = await runScript(envFor(mktemp('hermes-update-empty-'), state, { HERMES_HOME: makeHermesHome() }));
  const result = lastJson(res);
  assert.notEqual(res.status, 0);
  assert.equal(result.ok, false);
  assert.match(result.error, /no hermes CLI/);
});


test('a successful Hermes no-op cannot claim updated or independently current', async () => {
  const { bin, state } = makeHermes();
  fs.writeFileSync(path.join(state, 'version'), '0.21.6');
  fs.writeFileSync(path.join(state, 'update-out'), 'Update completed.\n');
  const res = await runScript(envFor(bin, state, { HERMES_HOME: makeHermesHome() }));
  const result = lastJson(res);
  assert.equal(result.updated, false);
  assert.equal(result.current, false);
  assert.match(result.error, /unchanged|unverified/);
  assert.match(fs.readFileSync(path.join(state, 'sends.log'), 'utf8'), /warning/);
  assert.doesNotMatch(fs.readFileSync(path.join(state, 'sends.log'), 'utf8'), /already up to date|update finished/);
});


test('the standalone Hermes settings detail warns for unchanged unverified results', () => {
  const text = hermesUpdateDetail({ ok: true, before: '0.21.6', version: '0.21.6', updated: false, current: false, error: 'version unchanged or unverified', messaged: true }, 'VPS');
  assert.match(text, /warning.*unchanged or unverified/);
  assert.doesNotMatch(text, /already up to date|Hermes updated/);
});

test('malformed version movement and false current claims warn in guest, settings and bot', async () => {
  for (const check of ['', 'Already up to date.']) {
    const { bin, state, sendLog } = makeHermes();
    fs.writeFileSync(path.join(bin, 'hermes'), `#!/bin/sh
case "$1" in
  --version) if [ -f "$FAKE_HERMES_STATE/applied" ]; then echo 'Hermes Agent vbad-new'; else echo 'Hermes Agent vbad-old'; fi;;
  update) if [ "\${2:-}" = --check ]; then cat "$FAKE_HERMES_STATE/check-out"; else touch "$FAKE_HERMES_STATE/applied"; echo 'Update completed.'; fi;;
  send) printf '%s\\n' "$*" >> "$FAKE_HERMES_STATE/sends.log";;
esac
`, { mode: 0o755 });
    fs.writeFileSync(path.join(state, 'check-out'), check);
    const res = await runScript(envFor(bin, state, { HERMES_HOME: mktemp('hermes-update-home-') }));
    const result = lastJson(res);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(result.updated, false);
    assert.equal(result.current, false);
    assert.equal(result.version, '');
    assert.match(result.error, /unverified/);
    assert.match(hermesUpdateDetail(result, 'fixture'), /warning/);
    assert.match(fs.readFileSync(sendLog, 'utf8'), /warning/);
    assert.doesNotMatch(res.stdout + fs.readFileSync(sendLog, 'utf8'), /hermes update finished|Hermes update finished/);
  }
});
