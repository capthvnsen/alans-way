# vm-update.ps1 - Windows guest twin of vm-update.sh. The desktop app pipes
# this file over ssh stdin (via cmd so any sshd shell works) with the release
# tag in ALANS_WAY_VM_TAG, or ALANS_WAY_VM_CHECK=1 for a read-only check.
#
# It only ever touches the checkout setup.sh created, that checkout's
# node_modules, and the setup.sh Scheduled Task AlansWay_Browser. Hermes, the
# alans-way-agents plugin and the user's other files are never touched.
# The last stdout line is one JSON result:
# {"ok":bool,"version":"x.y.z","restarted":bool,"error":"..."}.
# Written for Windows PowerShell 5.1 (no ?? or ?:).
$ErrorActionPreference = 'Stop'
$script:Version = ''
$script:Restarted = $false

function Write-Result([bool]$Ok, [string]$Err) {
    @{ ok = $Ok; version = $script:Version; restarted = $script:Restarted; error = $Err } |
        ConvertTo-Json -Compress | Write-Output
}
function Fail([string]$Err) { Write-Result $false $Err; exit 1 }
function EnvInt([string]$Name, [int]$Default) {
    $v = [Environment]::GetEnvironmentVariable($Name); if ($v) { return [int]$v } return $Default
}

# Checkout discovery matches setup.sh: the app lives under the user's
# .local\share\hermes-alans-way\app (BROWSER_HOME on Windows is %USERPROFILE%).
$Checkout = $env:ALANS_WAY_DESKTOP_DIR
if (-not $Checkout) {
    foreach ($d in @("$env:USERPROFILE\.local\share\hermes-alans-way\app",
                     "$HOME\.local\share\hermes-alans-way\app")) {
        if ((Test-Path "$d\desktop\package.json") -and (Test-Path "$d\.git")) { $Checkout = $d; break }
    }
}
if (-not $Checkout -or -not (Test-Path "$Checkout\desktop\package.json") -or -not (Test-Path "$Checkout\.git")) {
    Fail 'no browser host checkout found (expected %USERPROFILE%\.local\share\hermes-alans-way\app)'
}
$script:Version = [string](Get-Content "$Checkout\desktop\package.json" -Raw | ConvertFrom-Json).version

# The broker's loopback status port and bearer token come from its data dir.
function Get-Status {
    $data = $env:ALANS_WAY_VM_DATA
    if (-not $data) { $data = $env:HERMES_VPS_BROWSER_DATA }
    if (-not $data -or -not (Test-Path "$data\config.json")) {
        $data = "$env:USERPROFILE\.local\share\hermes-alans-way\browser"
        if (-not (Test-Path "$data\config.json")) { return $null }
    }
    $port = [int](Get-Content "$data\config.json" -Raw | ConvertFrom-Json).port; if (-not $port) { $port = 9465 }
    $token = $null
    foreach ($tf in @("$data\app-token.json", "$data\connection.json")) {
        if (Test-Path $tf) { $token = [string](Get-Content $tf -Raw | ConvertFrom-Json).token; if ($token) { break } }
    }
    if (-not $token) { return $null }
    try { return Invoke-RestMethod -Uri "http://127.0.0.1:$port/v1/status" -Headers @{ Authorization = "Bearer $token" } -TimeoutSec 4 }
    catch { return $null }
}

if ($env:ALANS_WAY_VM_CHECK -eq '1') {
    $s = Get-Status
    $hostVersion = ''; $busy = $false
    if ($s) { $hostVersion = [string]$s.version; $busy = [bool]$s.busy }
    @{ ok = $true; version = $script:Version; hostVersion = $hostVersion; busy = $busy; error = '' } |
        ConvertTo-Json -Compress | Write-Output
    exit 0
}

$Tag = $env:ALANS_WAY_VM_TAG
if ($Tag -notmatch '^v\d+\.\d+\.\d+$') { Fail "refusing non-release tag '$Tag' (need vX.Y.Z)" }
Write-Output "vm-update: updating $Checkout to $Tag"

# Never swap code under a live agent action; wait briefly, then leave this VM.
$deadline = (Get-Date).AddSeconds((EnvInt 'ALANS_WAY_VM_BUSY_WAIT' 60))
$busyNow = $false
while ($true) {
    $s = Get-Status
    $busyNow = ($s -and $s.busy -eq $true)
    if (-not $busyNow) { break }
    if ((Get-Date) -gt $deadline) { Fail 'busy' }
    Start-Sleep -Seconds (EnvInt 'ALANS_WAY_VM_BUSY_POLL' 5)
}

Push-Location $Checkout
try {
    git fetch --tags origin 2>&1 | Out-Null
    $want = (git rev-parse --verify -q "$Tag^{commit}" 2>$null)
    if (-not $want) { Fail "tag $Tag is not in the checkout and could not be fetched" }
    git -c advice.detachedHead=false checkout -q $Tag 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { Fail "could not check out $Tag" }
    $head = (git rev-parse HEAD 2>$null)
    if ($head -ne $want) { Fail "checkout did not land on $Tag; refusing to run it" }
    Write-Output "vm-update: checkout pinned at $Tag"

    Push-Location "$Checkout\desktop"
    try { npm.cmd ci --omit=dev --ignore-scripts 2>&1 | Out-Null; if ($LASTEXITCODE -ne 0) { Fail 'npm ci failed' } }
    finally { Pop-Location }
    Write-Output 'vm-update: dependencies installed'

    $hook = "$Checkout\desktop\scripts\vm-post-update.ps1"
    if (Test-Path $hook) {
        & powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $hook $Tag 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) { Fail 'the post-update hook failed' }
    }
}
finally { Pop-Location }

# Restart the broker exactly the way setup.sh supervises it: the Scheduled
# Task. Chromium is left running so open tabs and sign-ins survive.
try {
    $null = Get-ScheduledTask -TaskName 'AlansWay_Browser' -ErrorAction Stop
    Stop-ScheduledTask -TaskName 'AlansWay_Browser' -ErrorAction SilentlyContinue
    Start-ScheduledTask -TaskName 'AlansWay_Browser' -ErrorAction Stop
    $script:Restarted = $true
    Write-Output 'vm-update: browser host restarted'
} catch {
    Write-Output 'vm-update: could not restart the broker; run: Start-ScheduledTask -TaskName AlansWay_Browser'
}

$deadline = (Get-Date).AddSeconds((EnvInt 'ALANS_WAY_VM_HEALTH_WAIT' 45))
$healthy = $false
$wanted = $Tag -replace '^v', ''
while ((Get-Date) -lt $deadline) {
    $s = Get-Status
    if ($s -and [string]$s.version -eq $wanted) { $healthy = $true; break }
    Start-Sleep -Seconds 2
}
if (-not $healthy) {
    if ($script:Restarted) { Fail "the browser host did not come back on $Tag" }
    Fail "updated but the broker did not report v$wanted; restart it with: Start-ScheduledTask -TaskName AlansWay_Browser"
}
Write-Result $true ''
