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
after(() => {
  for (const dir of tmpdirs) {
    const childPid = path.join(dir, 'state', 'child.pid');
    if (process.platform === 'win32' && fs.existsSync(childPid)) {
      const pid = fs.readFileSync(childPid, 'utf8').trim();
      if (/^\d+$/.test(pid)) spawnSync('taskkill', ['/PID', pid, '/T', '/F'], { timeout: 10000 });
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
const mktemp = (prefix) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); tmpdirs.push(dir); return dir; };

// The fake hermes logs argv to hermes.log, answers status from gateway-status,
// stops/starts into gateways.log, sends into sends.log, and update from
// update-rc/update-out. Every live profile reports a running gateway.
function makeHermes(shim = 'cmd') {
  const dir = mktemp('hermes-update-ps1-');
  const state = path.join(dir, 'state'), bin = path.join(dir, 'bin with spaces'), home = path.join(dir, 'home');
  fs.mkdirSync(state); fs.mkdirSync(bin);
  for (const name of ['coder', 'ops', 'writer']) {
    fs.mkdirSync(path.join(home, 'profiles', name), { recursive: true });
    fs.writeFileSync(path.join(home, 'profiles', name, 'config.yaml'), `profile: ${name}\n`);
  }
  fs.writeFileSync(path.join(state, 'gateway-status'), 'gateway is running\n');
  const paths = { log: path.join(state, 'hermes.log'), sends: path.join(state, 'sends.log'), gateways: path.join(state, 'gateways.log') };
  fs.writeFileSync(path.join(bin, `hermes.${shim}`), `@echo off\r
setlocal\r
>> "%FAKE_HERMES_STATE%\\hermes.log" echo hermes %*\r
set "cmd=%~1" & set "sub=%~2"\r
if "%cmd%"=="-p" (set "cmd=%~3" & set "sub=%~4")\r
if "%cmd%"=="--version" goto version\r
if "%cmd%"=="update" goto update\r
if "%cmd%"=="gateway" goto gateway\r
if "%cmd%"=="send" goto send\r
exit /b 0\r
:version\r
echo Hermes Agent v9.9.9 test\r
exit /b 0\r
:update\r
if exist "%FAKE_HERMES_STATE%\\hang.ps1" goto hang\r
type "%FAKE_HERMES_STATE%\\update-out" 2>nul\r
set rc=0\r
if exist "%FAKE_HERMES_STATE%\\update-rc" set /p rc=<"%FAKE_HERMES_STATE%\\update-rc"\r
exit /b %rc%\r
:hang\r
powershell -NoProfile -ExecutionPolicy Bypass -File "%FAKE_HERMES_STATE%\\hang.ps1"\r
exit /b %errorlevel%\r
:gateway\r
if "%sub%"=="status" goto status\r
>> "%FAKE_HERMES_STATE%\\gateways.log" echo %*\r
if not "%sub%"=="start" exit /b 0\r
if not exist "%FAKE_HERMES_STATE%\\gateway-start-rc" exit /b 0\r
set /p rc=<"%FAKE_HERMES_STATE%\\gateway-start-rc"\r
exit /b %rc%\r
:status\r
type "%FAKE_HERMES_STATE%\\gateway-status" 2>nul\r
exit /b 0\r
:send\r
>> "%FAKE_HERMES_STATE%\\sends.log" echo %*\r
exit /b 0\r
`);
  return { state, bin, home, ...paths };
}

// A real executable keeps the direct-Process path covered independently of
// cmd.exe. Compile with Windows PowerShell's built-in C# compiler (C# 5).
function makeExeHermes() {
  const f = makeHermes();
  fs.rmSync(path.join(f.bin, 'hermes.cmd'));
  const source = path.join(f.state, 'FakeHermes.cs');
  fs.writeFileSync(source, `
using System;
using System.IO;
public class FakeHermes {
  public static int Main(string[] args) {
    string state = Environment.GetEnvironmentVariable("FAKE_HERMES_STATE");
    File.AppendAllText(Path.Combine(state, "hermes.log"), "hermes " + String.Join(" ", args) + "\\n");
    int offset = args[0] == "-p" ? 2 : 0;
    string command = args[offset];
    if (command == "--version") Console.WriteLine("Hermes Agent v9.9.9 test");
    if (command == "gateway") {
      if (args[offset + 1] == "status") Console.WriteLine("gateway is running");
      else File.AppendAllText(Path.Combine(state, "gateways.log"), String.Join(" ", args) + "\\n");
    }
    if (command == "send") File.AppendAllText(Path.Combine(state, "sends.log"), String.Join("|", args) + "\\n");
    if (command == "update" && File.Exists(Path.Combine(state, "update-rc")))
      return Int32.Parse(File.ReadAllText(Path.Combine(state, "update-rc")));
    return 0;
  }
}
`);
  const build = spawnSync('powershell', ['-NoProfile', '-Command',
    'Add-Type -Path $env:FAKE_HERMES_SOURCE -OutputAssembly $env:FAKE_HERMES_EXE -OutputType ConsoleApplication'], {
    encoding: 'utf8', timeout: 30000,
    env: { ...process.env, FAKE_HERMES_SOURCE: source, FAKE_HERMES_EXE: path.join(f.bin, 'hermes.exe') },
  });
  assert.equal(build.status, 0, build.stderr + build.stdout);
  return f;
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
  assert.match(sends[0], /^send -q -t telegram "Hermes update finished.*Now on v9\.9\.9\."\r?$/);
  assert.deepEqual(result.messages.map((m) => [m.profile, m.sent, m.error]), [
    ['default', true, ''], ['coder', true, ''], ['ops', true, ''], ['writer', true, ''],
  ]);
});

test('a bat shim in a path with spaces receives the complete quoted notification', e2e, () => {
  const f = makeHermes('bat');
  const res = runScript(f);
  const result = lastJson(res);
  assert.equal(res.status, 0, res.stderr + res.stdout);
  assert.equal(result.ok, true);
  assert.equal(result.messaged, true);
  const sends = fs.readFileSync(f.sends, 'utf8').trim().split('\n');
  assert.equal(sends.length, 4);
  assert.match(sends[3], /^-p writer send -q -t telegram "Hermes update finished.*Now on v9\.9\.9\."\r?$/);
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

test('nonzero update and restart exits are preserved even without error output', e2e, () => {
  const f = makeHermes();
  fs.writeFileSync(path.join(f.state, 'update-rc'), '7');
  fs.writeFileSync(path.join(f.state, 'gateway-start-rc'), '9');
  const start = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', `""${path.join(f.bin, 'hermes.cmd')}" gateway start"`], {
    encoding: 'utf8', timeout: 10000, env: { ...process.env, FAKE_HERMES_STATE: f.state },
  });
  assert.equal(start.status, 9, 'the fake CLI must actually fail a gateway start: ' + start.stderr + start.stdout);
  const res = runScript(f);
  const result = lastJson(res);
  assert.equal(res.status, 1, res.stderr + res.stdout);
  assert.equal(result.ok, false);
  assert.equal(result.updated, false);
  assert.equal(result.error, 'hermes update exited 7');
  assert.equal(result.gatewayRestarted, false, 'failed starts must never be reported as successful: ' + res.stdout);
  assert.match(fs.readFileSync(f.gateways, 'utf8'), /^-p writer gateway start$/m, 'all stopped gateways still get a restart attempt');
});

test('a timed-out shim kills its child and still restarts the stopped gateways', e2e, () => {
  const f = makeHermes();
  fs.writeFileSync(path.join(f.state, 'hang.ps1'), `
[IO.File]::WriteAllText((Join-Path $env:FAKE_HERMES_STATE 'child.pid'), [string]$PID)
Start-Sleep -Seconds 120
`);
  const res = runScript(f, { ALANS_WAY_HERMES_UPDATE_TIMEOUT: '8' });
  const result = lastJson(res);
  assert.equal(res.error, undefined, 'the updater must finish within the harness timeout');
  assert.equal(res.status, 1, res.stderr + res.stdout);
  assert.equal(result.ok, false);
  assert.equal(result.updated, false);
  assert.equal(result.error, 'the hermes update timed out');
  assert.equal(result.gatewayRestarted, true);
  assert.equal(result.messaged, true);
  const pid = fs.readFileSync(path.join(f.state, 'child.pid'), 'utf8').trim();
  assert.match(pid, /^\d+$/);
  const probe = spawnSync('powershell', ['-NoProfile', '-Command', `if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { exit 1 }`], { encoding: 'utf8', timeout: 30000 });
  assert.equal(probe.status, 0, 'taskkill /T must stop the child, not just the shim');
  assert.match(fs.readFileSync(f.gateways, 'utf8'), /^-p writer gateway start$/m);
});

test('an exe receives one notification argument and propagates zero and nonzero exits', e2e, () => {
  const f = makeExeHermes();
  const success = runScript(f);
  const result = lastJson(success);
  assert.equal(success.status, 0, success.stderr + success.stdout);
  assert.equal(result.ok, true);
  assert.equal(result.gatewayRestarted, true);
  assert.equal(result.messaged, true);
  const sends = fs.readFileSync(f.sends, 'utf8').trim().split('\n');
  assert.equal(sends.length, 4);
  assert.match(sends[0], /^send\|-q\|-t\|telegram\|Hermes update finished[^|]*Now on v9\.9\.9\.$/);
  fs.writeFileSync(path.join(f.state, 'update-rc'), '7');
  const failure = runScript(f);
  const failed = lastJson(failure);
  assert.equal(failure.status, 1, failure.stderr + failure.stdout);
  assert.equal(failed.ok, false);
  assert.equal(failed.error, 'hermes update exited 7');
  assert.equal(failed.gatewayRestarted, true);
});

test('a machine without the hermes CLI fails cleanly', e2e, () => {
  const f = { bin: mktemp('hermes-update-ps1-nobin-'), state: mktemp('hermes-update-ps1-state-'), home: mktemp('hermes-update-ps1-home-') };
  const res = runScript(f);
  const result = lastJson(res);
  assert.notEqual(res.status, 0);
  assert.equal(result.ok, false);
  assert.match(result.error, /no hermes CLI/);
});
