// Source guards for scripts/install-windows.ps1 everywhere, plus a fully
// stubbed Windows PowerShell 5.1 run on Windows: downloads, the installer and
// launching the app are fixtures, so the test never reaches the network or a
// real installation.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '../../scripts/install-windows.ps1');
const SOURCE = fs.readFileSync(SCRIPT, 'utf8');
const e2e = { skip: process.platform !== 'win32' && 'requires Windows PowerShell 5.1' };
const SYSTEM_ROOT = process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows';
const POWERSHELL = path.join(SYSTEM_ROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const dirs = [];
after(() => { for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true }); });
const mktemp = (prefix) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); dirs.push(dir); return dir; };
const psq = (value) => `'${String(value).replace(/'/g, "''")}'`;

test('install-windows downloads the stable installer and verifies it before running it', () => {
  assert.match(SOURCE, /\$InstallerName = 'OpenAlan-windows-setup\.exe'/);
  assert.match(SOURCE, /Invoke-RestMethod -UseBasicParsing -Uri "\$ApiUrl\/releases\/latest"/);
  assert.match(SOURCE, /\$tag -notmatch '\^v\\d\+\\\.\\d\+\\\.\\d\+\$'/);
  assert.match(SOURCE, /Invoke-WebRequest -UseBasicParsing "\$base\/\$InstallerName" -OutFile \$setup/);
  assert.match(SOURCE, /Invoke-WebRequest -UseBasicParsing "\$base\/latest\.yml" -OutFile \$latestYml/);
  assert.ok(SOURCE.indexOf('if ((Sha512Base64 $setup) -cne $want)') < SOURCE.indexOf('$Setup = DownloadRelease'), 'the checksum is verified before the installer can run');
  assert.match(SOURCE, /SHA512Managed/);
  assert.match(SOURCE, /\[Convert\]::ToBase64String\(\$sha\.ComputeHash\(\$stream\)\)/);
});

test('install-windows keeps rollback around the installer and never runs a failed download', () => {
  assert.match(SOURCE, /\$InProgress = "\$Dest\.installing"/);
  assert.match(SOURCE, /Move-Item \$Dest \$Old/);
  assert.match(SOURCE, /\$code = RunNsisInstaller \$Setup \$Dest/);
  assert.match(SOURCE, /Remove-Item -Recurse -Force \$Dest -ErrorAction SilentlyContinue\s+Remove-Item -Force \$InProgress -ErrorAction SilentlyContinue\s+if \(\$hadOld\) \{\s+try \{ Move-Item \$Old \$Dest \}/s);
  assert.match(SOURCE, /the downloaded installer did not complete; the previous app was restored/);
  assert.match(SOURCE, /the downloaded installer did not match its checksum - nothing was installed/);
  assert.match(SOURCE, /function Die\(\[string\]\$m\) \{\s+CleanupInstallTemp/s);
  assert.match(SOURCE, /trap \{\s+CleanupInstallTemp/s);
  assert.match(SOURCE, /CleanupInstallTemp; exit 0/);
});

test('install-windows keeps source builds behind the same explicit switch as the Mac installer', () => {
  assert.match(SOURCE, /ALANS_WAY_BUILD_FROM_SOURCE/);
  assert.match(SOURCE, /if \(-not \(WantSourceBuild\)\) \{\s+\$Setup = DownloadRelease\s+\} else \{\s+Say 'Building from source because ALANS_WAY_BUILD_FROM_SOURCE is set'/s);
  assert.match(SOURCE, /npm run package:win --silent -- --dir/);
  assert.doesNotMatch(SOURCE, /\?\?/);
});

function compileFakeInstaller(dir) {
  const source = path.join(dir, 'FakeInstaller.cs');
  const exe = path.join(dir, 'OpenAlan-windows-setup.exe');
  fs.writeFileSync(source, String.raw`
using System;
using System.IO;
public class FakeInstaller {
  public static int Main(string[] args) {
    string log = Environment.GetEnvironmentVariable("FAKE_INSTALLER_LOG");
    if (!String.IsNullOrEmpty(log)) File.AppendAllText(log, String.Join("|", args) + "\n");
    string all = String.Join(" ", args);
    int at = all.IndexOf("/D=", StringComparison.OrdinalIgnoreCase);
    if (at < 0) return 2;
    string dir = all.Substring(at + 3);
    if (Environment.GetEnvironmentVariable("FAKE_INSTALLER_FAIL") == "1") return 3;
    Directory.CreateDirectory(dir);
    File.WriteAllText(Path.Combine(dir, "alans-way-localapp.exe"), "new");
    return 0;
  }
}
`);
  const compile = path.join(dir, 'compile.ps1');
  fs.writeFileSync(compile, 'Add-Type -TypeDefinition (Get-Content $args[0] -Raw) -OutputAssembly $args[1] -OutputType ConsoleApplication\n');
  const build = spawnSync(POWERSHELL, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', compile, source, exe], { encoding: 'utf8', timeout: 30000 });
  assert.equal(build.status, 0, build.stderr + build.stdout);
  return exe;
}

function fixture(dir, { badChecksum = false } = {}) {
  const installer = compileFakeInstaller(dir);
  let sha512 = crypto.createHash('sha512').update(fs.readFileSync(installer)).digest('base64');
  // Base64 is case-sensitive and PowerShell's -ne is not: a case-only difference must still fail.
  if (badChecksum) sha512 = sha512.replace(/[a-z]/i, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()));
  const yml = path.join(dir, 'latest.yml');
  fs.writeFileSync(yml, `version: 9.9.9\nfiles:\n  - url: OpenAlan-windows-setup.exe\n    sha512: ${sha512}\n    size: ${fs.statSync(installer).size}\npath: OpenAlan-windows-setup.exe\nsha512: ${sha512}\n`);
  return { installer, yml };
}

function writeHarness(file, f) {
  fs.writeFileSync(file, `
function Invoke-WebRequest {
  param([Parameter(Position=0)][string]$Uri, [Parameter(Position=1)][string]$OutFile, [switch]$UseBasicParsing)
  Add-Content -Path $env:FAKE_WEB_LOG -Value $Uri
  if ($Uri -like '*/latest.yml') { Copy-Item ${psq(f.yml)} $OutFile; return }
  if ($Uri -like '*/OpenAlan-windows-setup.exe') { Copy-Item ${psq(f.installer)} $OutFile; return }
  throw "unexpected web request: $Uri"
}
function Invoke-RestMethod {
  param([string]$Uri, $Headers, [int]$TimeoutSec, [switch]$UseBasicParsing)
  if ($Uri -like '*/releases/latest') { return [pscustomobject]@{ tag_name = 'v9.9.9'; draft = $false; prerelease = $false } }
  return [pscustomobject]@{ version = '1.0.0'; host = 'fixture' }
}
function Start-Process {
  param([Parameter(Position=0)][string]$FilePath)
  Add-Content -Path $env:FAKE_START_LOG -Value $FilePath
}
# exit in a dot-sourced script only returns here, so pass its code on.
$global:LASTEXITCODE = 0
. ${psq(SCRIPT)}
exit $LASTEXITCODE
`);
}

function runInstaller({ badChecksum = false, failInstaller = false } = {}) {
  const dir = mktemp('install-windows-ps1-');
  const f = fixture(dir, { badChecksum });
  const harness = path.join(dir, 'harness.ps1');
  writeHarness(harness, f);
  const local = path.join(dir, 'local appdata'), roaming = path.join(dir, 'roaming appdata');
  const dest = path.join(local, 'Programs', 'alans-way-localapp');
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(dest, 'alans-way-localapp.exe'), 'old');
  fs.mkdirSync(path.join(roaming, 'Hermes Workspace'), { recursive: true });
  fs.writeFileSync(path.join(roaming, 'Hermes Workspace', 'connection.json'), JSON.stringify({ url: 'http://fixture.invalid', token: 'fixture' }));
  const logs = {
    installer: path.join(dir, 'installer.log'), web: path.join(dir, 'web.log'), start: path.join(dir, 'start.log'),
  };
  const env = {
    ...process.env,
    LOCALAPPDATA: local, APPDATA: roaming,
    FAKE_INSTALLER_LOG: logs.installer, FAKE_WEB_LOG: logs.web, FAKE_START_LOG: logs.start,
    FAKE_INSTALLER_FAIL: failInstaller ? '1' : '',
  };
  const result = spawnSync(POWERSHELL, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', harness], { encoding: 'utf8', timeout: 60000, env });
  const text = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
  return { result, dest, logs, text };
}

test('the Windows installer downloads, verifies and installs the release by default', e2e, () => {
  const run = runInstaller();
  assert.equal(run.result.status, 0, run.result.stdout + run.result.stderr);
  assert.equal(fs.readFileSync(path.join(run.dest, 'alans-way-localapp.exe'), 'utf8'), 'new');
  assert.match(run.text(run.logs.web), /releases\/download\/v9\.9\.9\/OpenAlan-windows-setup\.exe/);
  assert.match(run.text(run.logs.web), /latest\.yml/);
  assert.match(run.text(run.logs.installer), /\/D=/);
  assert.ok(!fs.existsSync(`${run.dest}.old`));
});

test('the Windows installer aborts a checksum mismatch without touching the installed app', e2e, () => {
  const run = runInstaller({ badChecksum: true });
  assert.notEqual(run.result.status, 0, run.result.stdout + run.result.stderr);
  assert.match(run.result.stderr + run.result.stdout, /did not match its checksum/);
  assert.equal(fs.readFileSync(path.join(run.dest, 'alans-way-localapp.exe'), 'utf8'), 'old');
  assert.equal(run.text(run.logs.installer), '');
  assert.ok(!fs.existsSync(`${run.dest}.old`) && !fs.existsSync(`${run.dest}.new`));
});

test('the Windows installer restores the old app when the installer fails', e2e, () => {
  const run = runInstaller({ failInstaller: true });
  assert.notEqual(run.result.status, 0, run.result.stdout + run.result.stderr);
  assert.match(run.result.stderr + run.result.stdout, /previous app was restored/);
  assert.equal(fs.readFileSync(path.join(run.dest, 'alans-way-localapp.exe'), 'utf8'), 'old');
  assert.ok(!fs.existsSync(`${run.dest}.old`));
});
