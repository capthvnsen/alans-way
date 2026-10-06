# install-windows.ps1 — build and install (or upgrade) the Alan's Way app on Windows.
#
#   powershell -ExecutionPolicy Bypass -File install-windows.ps1
#
# Mirrors install-mac.sh: clones or fast-forwards the repo into $env:ALANS_WAY_DIR
# (default ~\alans-way), or downloads it as a tarball when git is missing (Node is
# fetched into ~\.alans-way\node the same way), builds the app locally so
# SmartScreen does not flag a downloaded binary, replaces
# %LOCALAPPDATA%\Programs\alans-way-localapp and starts it. Sign-ins and settings
# live in %APPDATA% and survive upgrades. Safe to re-run.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RepoUrl = 'https://github.com/capthvnsen/alans-way'
$Dir = if ($env:ALANS_WAY_DIR) { $env:ALANS_WAY_DIR } else { Join-Path $HOME 'alans-way' }
$AppName = 'alans-way-localapp'
$Dest = Join-Path $env:LOCALAPPDATA "Programs\$AppName"

function Say([string]$m) { Write-Host $m }
function Die([string]$m) { Write-Host "install-windows: $m" -ForegroundColor Red; exit 1 }

if ($env:OS -notmatch 'Windows') { Die 'this installs the Windows app; run it on Windows' }
if ([System.Environment]::Is64BitOperatingSystem -eq $false) { Die '64-bit Windows only' }

# A fresh PC has neither git nor Node. Node is only needed to build, so fetch an
# official build (checksum-verified) into a private folder rather than asking the
# user to install a toolchain.
$NodeDir = Join-Path $HOME '.alans-way\node'
function NodeOk {
  $node = Get-Command node -ErrorAction SilentlyContinue
  $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
  if (-not $node -or -not $npm) { return $false }
  try { return [int](node -p 'process.versions.node.split(".")[0]') -ge 20 } catch { return $false }
}
if (-not (NodeOk)) {
  if (-not (Test-Path (Join-Path $NodeDir 'node.exe'))) {
    Say "Downloading Node 22 for the build (into $NodeDir)"
    $base = 'https://nodejs.org/dist/latest-v22.x'
    $sums = (Invoke-WebRequest -UseBasicParsing "$base/SHASUMS256.txt").Content
    $line = ($sums -split "`n" | Where-Object { $_ -match ' node-v22\.[0-9.]+-win-x64\.zip$' } | Select-Object -First 1)
    if (-not $line) { Die "no Node 22 build for Windows x64 listed at $base" }
    $hash, $name = ($line.Trim() -split '\s+')
    $tmp = Join-Path $env:TEMP ("node-" + [guid]::NewGuid())
    New-Item -ItemType Directory -Path $tmp | Out-Null
    Invoke-WebRequest -UseBasicParsing "$base/$name" -OutFile (Join-Path $tmp $name)
    if ((Get-FileHash (Join-Path $tmp $name) -Algorithm SHA256).Hash.ToLower() -ne $hash.ToLower()) { Die 'Node download failed its checksum' }
    Remove-Item -Recurse -Force $NodeDir -ErrorAction SilentlyContinue
    Expand-Archive (Join-Path $tmp $name) -DestinationPath $tmp
    New-Item -ItemType Directory -Path $NodeDir -Force | Out-Null
    Copy-Item -Recurse (Join-Path $tmp ($name -replace '\.zip$','\*')) $NodeDir
    Remove-Item -Recurse -Force $tmp
  }
  $env:PATH = "$NodeDir;$env:PATH"
}

if ((Test-Path (Join-Path $Dir '.git')) -and (Get-Command git -ErrorAction SilentlyContinue)) {
  Say "Updating $Dir"
  git -C $Dir pull --ff-only -q
  if ($LASTEXITCODE -ne 0) { Die "could not fast-forward $Dir (local changes?)" }
  Say "Version $(git -C $Dir rev-parse --short HEAD)"
} elseif (-not (Test-Path $Dir) -and (Get-Command git -ErrorAction SilentlyContinue)) {
  Say "Cloning into $Dir"
  git clone -q $RepoUrl $Dir
  Say "Version $(git -C $Dir rev-parse --short HEAD)"
} else {
  # No usable git: take the source as a tarball, which every PC can unpack.
  if ((Test-Path $Dir) -and -not (Test-Path (Join-Path $Dir '.alans-way-tarball'))) {
    Die "$Dir exists but is not a checkout this script made - move it or set ALANS_WAY_DIR"
  }
  Say "Downloading the source into $Dir"
  $tmpDir = "$Dir.new"
  Remove-Item -Recurse -Force $tmpDir -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Path $tmpDir | Out-Null
  $tarball = Join-Path $env:TEMP 'alans-way-main.tar.gz'
  Invoke-WebRequest -UseBasicParsing "$RepoUrl/archive/refs/heads/main.tar.gz" -OutFile $tarball
  tar -xzf $tarball -C $tmpDir --strip-components 1
  if ($LASTEXITCODE -ne 0) { Die 'could not unpack the source' }
  New-Item -ItemType File -Path (Join-Path $tmpDir '.alans-way-tarball') -Force | Out-Null
  Remove-Item -Recurse -Force $Dir -ErrorAction SilentlyContinue
  Move-Item $tmpDir $Dir
}

Set-Location (Join-Path $Dir 'desktop')
Say 'Installing dependencies'
npm ci --no-audit --no-fund --loglevel=error
if ($LASTEXITCODE -ne 0) { Die 'npm ci failed' }
Say 'Building the app'
npm run package:win --silent
if ($LASTEXITCODE -ne 0) { Die 'npm run package:win failed' }
$Built = Join-Path $Dir "desktop\dist\$AppName-win32-x64"
if (-not (Test-Path (Join-Path $Built "$AppName.exe"))) { Die "build finished but $Built\$AppName.exe is missing" }

$running = Get-Process -Name $AppName -ErrorAction SilentlyContinue
if ($running) {
  Say 'Quitting the running app'
  $running | Stop-Process -Force
  Start-Sleep -Seconds 1
}

Say "Installing to $Dest"
Remove-Item -Recurse -Force "$Dest.new" -ErrorAction SilentlyContinue
Copy-Item -Recurse $Built "$Dest.new"
Remove-Item -Recurse -Force $Dest -ErrorAction SilentlyContinue
Move-Item "$Dest.new" $Dest
Start-Process (Join-Path $Dest "$AppName.exe")

$conn = Join-Path $env:APPDATA 'Hermes Workspace\connection.json'
for ($i = 0; $i -lt 30; $i++) {
  if (Test-Path $conn) {
    try {
      $c = Get-Content $conn -Raw | ConvertFrom-Json
      $s = Invoke-RestMethod -Uri "$($c.url)/v1/status" -Headers @{ Authorization = "Bearer $($c.token)" } -TimeoutSec 3
      if ($s.version) { Say "install-windows: running - local browser API answers ($($s.host) $($s.version))"; exit 0 }
    } catch {}
  }
  Start-Sleep -Seconds 1
}
Die "the app was installed but its local API did not answer within 30s - open $Dest\$AppName.exe and check it starts"
