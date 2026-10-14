// Windows PowerShell 5.1 parity: actual Git clones and installed manifests;
// Hermes and gateways are fixture-only. No guest or local installation is used.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const SCRIPT = path.join(__dirname, '../scripts/vm-update.ps1');
const dirs = [];
after(() => { for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true }); });
const e2e = { skip: process.platform !== 'win32' && 'requires Windows PowerShell 5.1' };
const root = process.env.SystemRoot || 'C:\\Windows';
const powershell = path.join(root, 'System32/WindowsPowerShell/v1.0/powershell.exe');
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
let gitBin, realGit;
before(() => {
  if (process.platform !== 'win32') return;
  realGit = execFileSync('where.exe', ['git.exe'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0];
  gitBin = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-plugin-git-')); dirs.push(gitBin);
  // Substitute fetch transport only; config and get-url remain real Git
  // operations. Start-Process needs an executable rather than a .cmd file.
  const source = path.join(gitBin, 'fixture.cs');
  fs.writeFileSync(source, String.raw`
using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
class FixtureGit {
  static int Main(string[] args) {
    if (args.Contains("fetch")) {
      File.AppendAllText(Environment.GetEnvironmentVariable("FAKE_GIT_LOG"), "fetch\n");
      int i = Array.LastIndexOf(args, "origin");
      if (i < 0) return 1;
      args[i] = Environment.GetEnvironmentVariable("FAKE_GIT_REMOTE");
    }
    var start = new ProcessStartInfo(Environment.GetEnvironmentVariable("FAKE_GIT_EXE"));
    start.UseShellExecute = false;
    start.Arguments = String.Join(" ", args.Select(a => "\"" +
      Regex.Replace(Regex.Replace(a, @"(\\*)""", "$1$1\\\""), @"(\\+)$", "$1$1") + "\""));
    var p = Process.Start(start); p.WaitForExit(); return p.ExitCode;
  }
}`);
  const compile = path.join(gitBin, 'compile.ps1');
  fs.writeFileSync(compile, 'Add-Type -TypeDefinition (Get-Content $args[0] -Raw) -OutputAssembly $args[1] -OutputType ConsoleApplication\n');
  execFileSync(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', compile, source, path.join(gitBin, 'git.exe')], { timeout: 30000 });
});

for (const mode of ['multi-origin', 'multi-origin-reversed', 'duplicate-origin', 'empty-extra-origin', 'no-origin', 'rewritten-origin', 'push-only', 'clean', 'dirty', 'diverged', 'other-origin', 'dirty-at-tag', 'ahead', 'catalog']) {
  test(`Windows file source browser pin: ${mode}`, e2e, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-plugin-ps1-')); dirs.push(dir);
    const clone = path.join(dir, 'source clone'), remote = path.join(dir, 'remote.git');
    const bin = path.join(dir, 'bin'), home = path.join(dir, 'home'), state = path.join(dir, 'state');
    for (const d of [clone, bin, home, state]) fs.mkdirSync(d);
    execFileSync('git', ['init', '-q', '-b', 'main', clone]);
    git(clone, 'config', 'user.email', 'fixture@example.com'); git(clone, 'config', 'user.name', 'fixture');
    for (const version of ['0.3.1', '0.3.2', '0.3.3']) {
      for (const name of ['alans-way', 'alans-way-computer']) {
        fs.mkdirSync(path.join(clone, name), { recursive: true });
        fs.writeFileSync(path.join(clone, name, 'plugin.yaml'), `name: ${name}\nversion: "${version}"\n`);
      }
      git(clone, 'add', '.'); git(clone, 'commit', '-qm', version); git(clone, 'tag', `v${version}`);
    }
    execFileSync('git', ['clone', '-q', '--bare', clone, remote]);
    const origin = `https://github.com/${mode === 'other-origin' ? 'other' : 'capthvnsen'}/alans-way-agents.git`;
    git(clone, 'remote', 'add', 'origin', origin);
    const official = 'https://github.com/capthvnsen/alans-way-agents.git';
    const foreign = 'https://github.com/lookalike/alans-way-agents.git';
    if (mode === 'multi-origin') {
      git(clone, 'remote', 'set-url', 'origin', foreign);
      git(clone, 'config', '--add', 'remote.origin.url', official);
    }
    if (mode === 'multi-origin-reversed') git(clone, 'config', '--add', 'remote.origin.url', foreign);
    if (mode === 'duplicate-origin') git(clone, 'config', '--add', 'remote.origin.url', official);
    if (mode === 'empty-extra-origin') git(clone, 'config', '--add', 'remote.origin.url', '');
    if (mode === 'no-origin') git(clone, 'config', '--unset-all', 'remote.origin.url');
    if (mode === 'rewritten-origin') git(clone, 'config', `url.${foreign}.insteadOf`, official);
    if (mode === 'push-only') {
      git(clone, 'config', 'remote.origin.pushurl', foreign);
      git(clone, 'config', `url.${foreign}.pushInsteadOf`, official);
    }
    git(clone, 'checkout', '-q', mode === 'dirty-at-tag' ? 'v0.3.2' : mode === 'ahead' ? 'v0.3.3' : 'v0.3.1');
    if (mode.startsWith('dirty') || mode === 'diverged' || mode === 'catalog') fs.writeFileSync(path.join(clone, 'local.txt'), 'keep this');
    if (mode === 'diverged') { git(clone, 'add', '.'); git(clone, 'commit', '-qm', 'local commit'); }
    const head = git(clone, 'rev-parse', 'HEAD');
    if (mode === 'clean') git(clone, 'tag', '-d', 'v0.3.2'); // must fetch the target
    const profiles = [['default', 'alans-way'], ['work', 'alans-way-computer']];
    for (const [profile, name] of profiles) {
      const ph = profile === 'default' ? home : path.join(home, 'profiles', profile);
      fs.mkdirSync(path.join(ph, 'plugins', name), { recursive: true });
      fs.writeFileSync(path.join(ph, 'config.yaml'), 'fixture: true\n');
      fs.writeFileSync(path.join(ph, 'plugins', name, 'plugin.yaml'), `name: ${name}\nversion: "0.3.1"\n`);
      const meta = { source: `file://${clone.replace(/\\/g, '/')}#${name}`, revision: 'metadata-is-not-version', pinned: false };
      if (mode === 'catalog') meta.catalog = { pin: 'fixture-pin' };
      fs.writeFileSync(path.join(ph, 'plugins', '.install-metadata.json'), JSON.stringify({ [name]: meta }));
    }
    // The clean case is refused first, then re-copied after the existing drain.
    if (mode === 'clean') {
      fs.writeFileSync(path.join(state, 'running'), 'fixture');
      fs.writeFileSync(path.join(home, 'profiles/work/gateway.pid'), String(process.pid));
    }
    fs.writeFileSync(path.join(bin, 'hermes.cmd'), '@echo off\r\n"%FAKE_POWERSHELL%" -NoProfile -ExecutionPolicy Bypass -File "%FAKE_HERMES_SCRIPT%" %*\r\nexit /b %errorlevel%\r\n');
    const fake = path.join(bin, 'fake-hermes.ps1');
    fs.writeFileSync(fake, `
$a = @($args); $profile = 'default'
if ($a[0] -eq '-p') { $profile = $a[1]; $a = @($a | Select-Object -Skip 2) }
Add-Content "$env:FAKE_HERMES_STATE/log" "$profile $($a -join ' ')"
if ($a[0] -eq 'gateway') {
  if ($a[1] -eq 'stop' -and $a -contains '--help') { Write-Output '--all'; exit 0 }
  if ($a[1] -eq 'stop') { Remove-Item "$env:FAKE_HERMES_STATE/running" -ErrorAction SilentlyContinue }
  exit 0
}
if ($a[0] -eq 'plugins' -and $a[1] -eq 'update') {
  if (Test-Path "$env:FAKE_HERMES_STATE/running") { Write-Output 'Cannot update plugin files while the messaging gateway is running'; exit 1 }
  $ph = $env:HERMES_HOME
  if ($profile -ne 'default') { $ph = Join-Path $ph "profiles/$profile" }
  $name = $a[2]; $pd = Join-Path $ph 'plugins'
  $meta = (Get-Content "$pd/.install-metadata.json" -Raw | ConvertFrom-Json).$name
  if ($meta.catalog) { Write-Output 'already at catalog pin fixture-pin'; exit 0 }
  $source = ($meta.source -replace '^file://', '') -split '#'
  $tmp = Join-Path $env:FAKE_HERMES_STATE "$profile-$name"
  & git clone -q --no-local --depth 1 $source[0] $tmp
  if ($LASTEXITCODE -ne 0) { exit 1 }
  Copy-Item (Join-Path $tmp "$($source[1])/plugin.yaml") "$pd/$name/plugin.yaml" -Force
  Remove-Item $tmp -Recurse -Force
  Write-Output "Plugin $name updated."; exit 0
}
exit 2
`);
    const result = spawnSync(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT], {
      encoding: 'utf8', timeout: 120000,
      env: { ...process.env, PATH: `${bin};${gitBin};${process.env.PATH || process.env.Path}`, USERPROFILE: home, LOCALAPPDATA: home,
        FAKE_GIT_EXE: realGit, FAKE_GIT_REMOTE: remote, FAKE_GIT_LOG: path.join(state, 'git.log'),
        HERMES_HOME: home, FAKE_HERMES_STATE: state, FAKE_POWERSHELL: powershell, FAKE_HERMES_SCRIPT: fake,
        ALANS_WAY_DESKTOP_DIR: path.join(dir, 'missing'), ALANS_WAY_VM_DATA: path.join(dir, 'missing'),
        ALANS_WAY_VM_PLUGINS: '1', ALANS_WAY_VM_TAG: 'v0.3.2', ALANS_WAY_VM_BUDGET: '110' },
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const report = JSON.parse(result.stdout.trim().split(/\r?\n/).filter((line) => line.startsWith('{')).at(-1));
    assert.equal(report.plugins.length, 2);
    if (['clean', 'push-only'].includes(mode)) {
      assert.equal(git(clone, 'rev-parse', 'HEAD'), git(clone, 'rev-parse', 'v0.3.2^{commit}'));
      for (const p of report.plugins) { assert.equal(p.status, 'updated'); assert.equal(p.after, '0.3.2'); assert.equal(p.repoRef, 'v0.3.2'); }
      assert.equal(report.gatewayRestarted, true);
      const log = fs.readFileSync(path.join(state, 'log'), 'utf8');
      if (mode === 'clean') { assert.match(log, /gateway stop --all/); assert.match(log, /work gateway start/); }
      for (const [profile, name] of profiles) {
        const ph = profile === 'default' ? home : path.join(home, 'profiles', profile);
        assert.match(fs.readFileSync(path.join(ph, 'plugins', name, 'plugin.yaml'), 'utf8'), /version: "0.3.2"/);
      }
    } else {
      assert.equal(git(clone, 'rev-parse', 'HEAD'), head);
      for (const p of report.plugins) {
        assert.equal(p.status, mode === 'catalog' ? 'current' : 'skipped'); assert.equal(p.after, '0.3.1');
        assert.match(p.error, mode === 'catalog' ? /catalog pin/ : mode.startsWith('dirty') ? /local changes/ : ['multi-origin', 'multi-origin-reversed', 'duplicate-origin', 'empty-extra-origin', 'no-origin'].includes(mode) ? /ambiguous origin/ : ['other-origin', 'rewritten-origin'].includes(mode) ? /origin/ : /not an ancestor/);
      }
      if (mode !== 'catalog') assert.ok(!fs.existsSync(path.join(state, 'log')), 'no Hermes mutation on refused source');
      if (mode.includes('origin')) assert.ok(!fs.existsSync(path.join(state, 'git.log')), 'no fetch on refused origin');
    }
  });
}
