# install-windows.ps1 — install (or upgrade) the Alan's Workspace app on Windows.
#
#   powershell -ExecutionPolicy Bypass -File install-windows.ps1
#
# Downloads the latest stable Windows installer, verifies it against the
# checksum electron-builder publishes in latest.yml, and installs it. The old
# app is moved aside first and restored if the installer does not complete.
# ALANS_WAY_BUILD_FROM_SOURCE=1 instead clones or fast-forwards the repo into
# $env:ALANS_WAY_DIR (default ~\alans-way), or downloads it as a tarball when git
# is missing (Node is fetched into ~\.alans-way\node the same way), and builds
# the app locally. Sign-ins and settings live in %APPDATA% and survive upgrades.
# Safe to re-run.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RepoUrl = 'https://github.com/capthvnsen/alans-way'
$ApiUrl = 'https://api.github.com/repos/capthvnsen/alans-way'
$Dir = if ($env:ALANS_WAY_DIR) { $env:ALANS_WAY_DIR } else { Join-Path $HOME 'alans-way' }
$AppName = 'alans-way-localapp'
$Dest = Join-Path $env:LOCALAPPDATA "Programs\$AppName"
$InstallerName = 'OpenAlan-windows-setup.exe'
$script:InstallTemp = $null

function Say([string]$m) { Write-Host $m }
function CleanupInstallTemp {
  if ($script:InstallTemp -and (Test-Path $script:InstallTemp)) {
    Remove-Item -Recurse -Force $script:InstallTemp -ErrorAction SilentlyContinue
  }
}
function Die([string]$m) {
  CleanupInstallTemp
  Write-Host "install-windows: $m" -ForegroundColor Red
  exit 1
}
trap {
  CleanupInstallTemp
  Write-Host "install-windows: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
function InstallTemp {
  if (-not $script:InstallTemp) {
    $script:InstallTemp = Join-Path ([System.IO.Path]::GetTempPath()) ('alans-way-install-' + [guid]::NewGuid())
    New-Item -ItemType Directory -Path $script:InstallTemp | Out-Null
  }
  return $script:InstallTemp
}
function WantSourceBuild {
  if (-not $env:ALANS_WAY_BUILD_FROM_SOURCE) { return $false }
  return @('1', 'yes', 'true') -contains $env:ALANS_WAY_BUILD_FROM_SOURCE.ToLowerInvariant()
}

if ($env:OS -notmatch 'Windows') { Die 'this installs the Windows app; run it on Windows' }
if ([System.Environment]::Is64BitOperatingSystem -eq $false) { Die '64-bit Windows only' }

function LatestStableTag {
  try {
    $release = Invoke-RestMethod -UseBasicParsing -Uri "$ApiUrl/releases/latest" -Headers @{ Accept = 'application/vnd.github+json' }
  } catch {
    Die 'could not check the latest stable release - check the internet connection and try again'
  }
  $tag = [string]$release.tag_name
  if ($release.draft -eq $true -or $release.prerelease -eq $true -or $tag -notmatch '^v\d+\.\d+\.\d+$') {
    Die 'GitHub did not return a stable release tag - try again later or set ALANS_WAY_BUILD_FROM_SOURCE=1'
  }
  return $tag
}

function InstallerSha512([string]$Yaml) {
  $asset = [regex]::Escape($InstallerName)
  $lines = $Yaml -split "`r?`n"
  for ($i = 0; $i -lt $lines.Length; $i++) {
    if ($lines[$i] -match "^\s*-\s+url:\s*$asset\s*$") {
      for ($j = $i + 1; $j -lt $lines.Length; $j++) {
        if ($lines[$j] -match '^\s*-\s+url:') { break }
        if ($lines[$j] -match '^\s*sha512:\s*(\S+)\s*$') { return $Matches[1] }
      }
    }
  }
  return ''
}

function Sha512Base64([string]$File) {
  $sha = New-Object System.Security.Cryptography.SHA512Managed
  $stream = [System.IO.File]::OpenRead($File)
  try {
    return [Convert]::ToBase64String($sha.ComputeHash($stream))
  } finally {
    $stream.Dispose()
    $sha.Dispose()
  }
}

function DownloadRelease {
  Say 'Downloading the latest stable release'
  $tag = LatestStableTag
  $base = "$RepoUrl/releases/download/$tag"
  $temp = InstallTemp
  $setup = Join-Path $temp $InstallerName
  $latestYml = Join-Path $temp 'latest.yml'
  try {
    Invoke-WebRequest -UseBasicParsing "$base/$InstallerName" -OutFile $setup
  } catch {
    Die "could not download $InstallerName from the latest stable release - nothing was installed"
  }
  try {
    Invoke-WebRequest -UseBasicParsing "$base/latest.yml" -OutFile $latestYml
  } catch {
    Die 'the release did not provide its checksum - the download was not installed'
  }
  $want = InstallerSha512 (Get-Content $latestYml -Raw)
  if (-not $want) { Die 'the release checksum did not name the Windows installer - the download was not installed' }
  if ((Sha512Base64 $setup) -ne $want) { Die 'the downloaded installer did not match its checksum - nothing was installed' }
  return $setup
}

function RunNsisInstaller([string]$Setup, [string]$InstallDir) {
  $start = New-Object System.Diagnostics.ProcessStartInfo
  $start.FileName = $Setup
  # NSIS requires /D last and unquoted; it treats the rest of the command line
  # as the directory, which also permits spaces.
  $start.Arguments = '/S /D=' + $InstallDir
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $process = [System.Diagnostics.Process]::Start($start)
  $process.WaitForExit()
  return $process.ExitCode
}

function InstallRelease([string]$Setup) {
  Say "Installing to $Dest"
  # The NSIS installer must write its final location so its uninstall entry and
  # shortcuts stay valid. Moving the old app aside first still gives the same
  # rollback rule: a failed install never deletes the working copy.
  $Old = "$Dest.old"
  $InProgress = "$Dest.installing"
  # A killed run can leave a half-written destination beside its backup. The
  # marker makes that state unambiguous; without it an interrupted first install
  # has no backup to restore.
  if ((Test-Path $InProgress) -and (Test-Path $Dest)) { Remove-Item -Recurse -Force $Dest -ErrorAction SilentlyContinue }
  if (-not (Test-Path $Dest) -and (Test-Path $Old)) { Move-Item $Old $Dest }
  Remove-Item -Recurse -Force "$Dest.new", $Old -ErrorAction SilentlyContinue
  Remove-Item -Force $InProgress -ErrorAction SilentlyContinue
  $hadOld = Test-Path $Dest
  New-Item -ItemType File -Path $InProgress -Force | Out-Null
  if ($hadOld) {
    try { Move-Item $Dest $Old } catch {
      Remove-Item -Force $InProgress -ErrorAction SilentlyContinue
      Die 'could not move the installed app aside; it was left as it was'
    }
  }
  $code = RunNsisInstaller $Setup $Dest
  if ($code -ne 0 -or -not (Test-Path (Join-Path $Dest "$AppName.exe"))) {
    Remove-Item -Recurse -Force $Dest -ErrorAction SilentlyContinue
    Remove-Item -Force $InProgress -ErrorAction SilentlyContinue
    if ($hadOld) {
      try { Move-Item $Old $Dest } catch {
        Die "the installer failed and the previous app could not be put back; it is still at $Old"
      }
      Die 'the downloaded installer did not complete; the previous app was restored'
    }
    Die 'the downloaded installer did not complete; nothing was installed'
  }
  Remove-Item -Force $InProgress -ErrorAction SilentlyContinue
  Remove-Item -Recurse -Force $Old -ErrorAction SilentlyContinue
}

$Setup = $null
$Built = $null
if (-not (WantSourceBuild)) {
  $Setup = DownloadRelease
} else {
  Say 'Building from source because ALANS_WAY_BUILD_FROM_SOURCE is set'
  # A fresh PC has neither git nor Node. Node is only needed to build, so fetch an
  # official build (checksum-verified) into a private folder rather than asking the
  # user to install a toolchain.
  $NodeDir = Join-Path $HOME '.alans-way\node'
  function NodeOk {
    $node = Get-Command node -ErrorAction SilentlyContinue
    $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if (-not $node -or -not $npm) { return $false }
    try { return [version](node -p 'process.versions.node') -ge [version]'22.12' } catch { return $false }
  }
  if (-not (NodeOk)) {
    if (-not (Test-Path (Join-Path $NodeDir 'node.exe'))) {
      Say "Downloading Node 22 for the build (into $NodeDir)"
      $base = 'https://nodejs.org/dist/latest-v22.x'
      $sums = (Invoke-WebRequest -UseBasicParsing "$base/SHASUMS256.txt").Content
      $line = ($sums -split "`n" | Where-Object { $_ -match ' node-v22\.[0-9.]+-win-x64\.zip$' } | Select-Object -First 1)
      if (-not $line) { Die "no Node 22 build for Windows x64 listed at $base" }
      $hash, $name = ($line.Trim() -split '\s+')
      $tmp = Join-Path (InstallTemp) 'node'
      New-Item -ItemType Directory -Path $tmp | Out-Null
      Invoke-WebRequest -UseBasicParsing "$base/$name" -OutFile (Join-Path $tmp $name)
      if ((Get-FileHash (Join-Path $tmp $name) -Algorithm SHA256).Hash.ToLower() -ne $hash.ToLower()) { Die 'Node download failed its checksum' }
      Remove-Item -Recurse -Force $NodeDir -ErrorAction SilentlyContinue
      Expand-Archive (Join-Path $tmp $name) -DestinationPath $tmp
      New-Item -ItemType Directory -Path $NodeDir -Force | Out-Null
      Copy-Item -Recurse (Join-Path $tmp ($name -replace '\.zip$','\*')) $NodeDir
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
    $tarball = Join-Path (InstallTemp) 'alans-way-main.tar.gz'
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
  npm run package:win --silent -- --dir
  if ($LASTEXITCODE -ne 0) { Die 'npm run package:win failed' }
  $Built = Join-Path $Dir "desktop\dist\win-unpacked"
  if (-not (Test-Path (Join-Path $Built "$AppName.exe"))) { Die "build finished but $Built\$AppName.exe is missing" }
}

$running = Get-Process -Name $AppName -ErrorAction SilentlyContinue
if ($running) {
  Say 'Quitting the running app'
  $running | Stop-Process -Force
  Start-Sleep -Seconds 1
}

New-Item -ItemType Directory -Path (Split-Path $Dest) -Force | Out-Null
if ($Setup) {
  InstallRelease $Setup
} else {
  Say "Installing to $Dest"
  # Swap by rename so the old app is only deleted once the new one is in place.
  # A run killed mid-swap leaves the old app only at $Dest.old; put it back first.
  $Old = "$Dest.old"
  if (-not (Test-Path $Dest) -and (Test-Path $Old)) { Move-Item $Old $Dest }
  Remove-Item -Recurse -Force "$Dest.new", $Old -ErrorAction SilentlyContinue
  Copy-Item -Recurse $Built "$Dest.new"
  if (-not (Test-Path (Join-Path "$Dest.new" "$AppName.exe"))) {
    Remove-Item -Recurse -Force "$Dest.new" -ErrorAction SilentlyContinue
    Die 'the copied app is incomplete; the installed app was left as it was'
  }
  if (Test-Path $Dest) {
    try { Move-Item $Dest $Old } catch {
      Remove-Item -Recurse -Force "$Dest.new" -ErrorAction SilentlyContinue
      Die 'could not move the installed app aside; it was left as it was'
    }
  }
  try { Move-Item "$Dest.new" $Dest } catch {
    if (Test-Path $Old) { Move-Item $Old $Dest }
    Die 'could not put the new app in place; the previous app was restored'
  }
  Remove-Item -Recurse -Force $Old -ErrorAction SilentlyContinue
}
Start-Process (Join-Path $Dest "$AppName.exe")

$conn = Join-Path $env:APPDATA 'Hermes Workspace\connection.json'
for ($i = 0; $i -lt 30; $i++) {
  if (Test-Path $conn) {
    try {
      $c = Get-Content $conn -Raw | ConvertFrom-Json
      $s = Invoke-RestMethod -Uri "$($c.url)/v1/status" -Headers @{ Authorization = "Bearer $($c.token)" } -TimeoutSec 3
      if ($s.version) { Say "install-windows: running - local browser API answers ($($s.host) $($s.version))"; CleanupInstallTemp; exit 0 }
    } catch {}
  }
  Start-Sleep -Seconds 1
}
Die "the app was installed but its local API did not answer within 30s - open $Dest\$AppName.exe and check it starts"
