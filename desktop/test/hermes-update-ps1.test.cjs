// Runs scripts/hermes-update.ps1 end to end under Windows PowerShell against
// a fake hermes.cmd: gateway stops, the update, restarts, version and sends
// are all logged. The script only ever runs on Windows guests, so the
// end-to-end cases run on the Windows CI leg and skip everywhere else.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '../scripts/hermes-update.ps1');
const e2e = { skip: process.platform !== 'win32' && 'the script only ever runs on Windows guests' };

const tmpdirs = [];
after(() => { for (const dir of tmpdirs) fs.rmSync(dir, { recursive: true, force: true }); });
const mktemp = (prefix) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); tmpdirs.push(dir); return dir; };

// The fake hermes logs argv to hermes.log, answers status from gateway-status,
// stops/starts into gateways.log, sends into sends.log, and update from
// update-rc/update-out. Every live profile reports a running gateway.
function makeHermes() {
  const dir = mktemp('hermes-update-ps1-');
  const state = path.join(dir, 'state'), bin = path.join(dir, 'bin'), home = path.join(dir, 'home');
  fs.mkdirSync(state); fs.mkdirSync(bin);
  for (const name of ['coder', 'ops', 'writer']) {
    fs.mkdirSync(path.join(home, 'profiles', name), { recursive: true });
    fs.writeFileSync(path.join(home, 'profiles', name, 'config.yaml'), `profile: ${name}\n`);
  }
  fs.writeFileSync(path.join(state, 'gateway-status'), 'gateway is running\n');
  const paths = { log: path.join(state, 'hermes.log'), sends: path.join(state, 'sends.log'), gateways: path.join(state, 'gateways.log') };
  fs.writeFileSync(path.join(bin, 'hermes.cmd'), `@echo off\r
setlocal EnableDelayedExpansion\r
echo hermes %* >> "%FAKE_HERMES_STATE%\\hermes.log"\r
set "cmd=%~1" & set "sub=%~2"\r
if "%cmd%"=="-p" (set "cmd=%~3" & set "sub=%~4")\r
if "%cmd%"=="--version" (echo Hermes Agent v9.9.9 test & exit /b 0)\r
if "%cmd%"=="update" (\r
  type "%FAKE_HERMES_STATE%\\update-out" 2>nul\r
  set rc=0\r
  if exist "%FAKE_HERMES_STATE%\\update-rc" (set /p rc=<"%FAKE_HERMES_STATE%\\update-rc")\r
  exit /b !rc!\r
)\r
if "%cmd%"=="gateway" (\r
  if "%sub%"=="status" (type "%FAKE_HERMES_STATE%\\gateway-status" 2>nul) else (echo %* >> "%FAKE_HERMES_STATE%\\gateways.log")\r
  exit /b 0\r
)\r
if "%cmd%"=="send" (echo %* >> "%FAKE_HERMES_STATE%\\sends.log" & exit /b 0)\r
exit /b 0\r
`);
  return { state, bin, home, ...paths };
}

const runScript = (f, extraEnv = {}) => spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT], {
  encoding: 'utf8', timeout: 150000,
  env: {
    PATH: `${f.bin};${process.env.PATH}`,
    USERPROFILE: mktemp('hermes-update-ps1-fakehome-'),
    LOCALAPPDATA: mktemp('hermes-update-ps1-fakehome-'), HERMES_HOME: f.home, FAKE_HERMES_STATE: f.state,
    // A tight budget with four running gateways is exactly the case where the
    // uncapped restart reserve (4 x gateway timeout) ate the whole budget and
    // skipped the update after the gateways were already stopped.
    ALANS_WAY_HERMES_BUDGET: '100',
    ALANS_WAY_HERMES_STATUS_TIMEOUT: '10', ALANS_WAY_HERMES_UPDATE_TIMEOUT: '20',
    ALANS_WAY_HERMES_VERSION_TIMEOUT: '10', ALANS_WAY_HERMES_SEND_TIMEOUT: '10',
    ...extraEnv,
  },
});
const lastJson = (res) => {
  const lines = res.stdout.trim().split('\n').filter((line) => line.startsWith('{'));
  assert.ok(lines.length, `no JSON result line in:\n${res.stdout}\n${res.stderr}`);
  return JSON.parse(lines.at(-1));
};

test('the Windows update script carries the guarded kill and the capped reserve', () => {
  const src = fs.readFileSync(SCRIPT, 'utf8');
  // A failed taskkill (nonzero exit, no throw) still drops the process.
  assert.match(src, /& taskkill \/PID \$p\.Id \/T \/F[^}]*} catch \{\}\s*if \(-not \$p\.HasExited\) \{ try \{ \$p\.Kill\(\) \}/s);
  // The restart reserve is capped so several stopped gateways cannot starve
  // the update out of the budget.
  assert.match(src, /\$reserveCap = \[Math\]::Max\(\$gwTimeout, \[int\]\(\(EnvInt 'ALANS_WAY_HERMES_BUDGET' 270\) \/ 2\)\)/);
  assert.match(src, /\$reserve = \[Math\]::Min\(\$restart\.Count \* \$gwTimeout, \$reserveCap\)/);
});

test('gateways stop and restart around a successful update that still fits the budget', e2e, () => {
  const f = makeHermes();
  const res = runScript(f);
  const result = lastJson(res);
  assert.equal(res.status, 0, res.stderr + res.stdout);
  assert.equal(result.ok, true);
  assert.equal(result.updated, true);
  assert.equal(result.version, '9.9.9');
  assert.equal(result.gatewayRestarted, true);
  assert.equal(result.messaged, true);
  const calls = fs.readFileSync(f.log, 'utf8');
  assert.match(calls, /^hermes update --yes --keep-stash$/m, 'the update still runs: the capped reserve left it room');
  const gateways = fs.readFileSync(f.gateways, 'utf8');
  assert.match(gateways, /^gateway stop$/m);
  assert.match(gateways, /^-p coder gateway stop$/m);
  assert.match(gateways, /^gateway start$/m);
  assert.match(gateways, /^-p writer gateway start$/m);
  const sends = fs.readFileSync(f.sends, 'utf8').trim().split('\n');
  assert.equal(sends.length, 4, 'default plus three named profiles each message');
  assert.match(sends[0], /update finished.*v9\.9\.9/);
});

test('a failed update reports the error and still restarts the gateways and messages', e2e, () => {
  const f = makeHermes();
  fs.writeFileSync(path.join(f.state, 'update-rc'), '3');
  fs.writeFileSync(path.join(f.state, 'update-out'), 'git pull failed: merge conflict\n');
  const res = runScript(f);
  const result = lastJson(res);
  assert.notEqual(res.status, 0);
  assert.equal(result.ok, false);
  assert.match(result.error, /merge conflict/);
  assert.equal(result.gatewayRestarted, true, 'a failed update must not leave the bots offline');
  assert.equal(result.messaged, true);
  assert.match(fs.readFileSync(f.sends, 'utf8'), /Hermes update failed.*merge conflict/);
});

test('a machine without the hermes CLI fails cleanly', e2e, () => {
  const f = { bin: mktemp('hermes-update-ps1-nobin-'), state: mktemp('hermes-update-ps1-state-'), home: mktemp('hermes-update-ps1-home-') };
  const res = runScript(f);
  const result = lastJson(res);
  assert.notEqual(res.status, 0);
  assert.equal(result.ok, false);
  assert.match(result.error, /no hermes CLI/);
});
