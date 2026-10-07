# vm-update.ps1 - Windows guest twin of vm-update.sh. The desktop app pipes
# this file over ssh stdin (via cmd so any sshd shell works) with the release
# tag in ALANS_WAY_VM_TAG, or ALANS_WAY_VM_CHECK=1 for a read-only check.
#
# It only ever touches the checkout setup.sh created, that checkout's
# node_modules, the setup.sh Scheduled Task AlansWay_Browser, and the Hermes
# plugins it updates through `hermes -p <profile> plugins update <name>`.
# Consent gates are never answered: hermes gets an empty stdin and those
# plugins come back as needs_approval. Installs recorded with a file://
# source re-clone it, so the alans-way-agents clone is first advanced to its
# newest release tag - forward only, never a branch tip, never over local
# changes.
# The last stdout line is one JSON result:
# {"ok":bool,"version":"x.y.z","restarted":bool,"error":"...",
#  "plugins":[...],"gatewayRestarted":bool}.
# Written for Windows PowerShell 5.1 (no ?? or ?:).
$ErrorActionPreference = 'Stop'
$script:Version = ''
$script:Restarted = $false
$script:Plugins = @()
$script:GatewayRestarted = $false
$script:StartTime = Get-Date
$script:HermesBin = ''

function Write-Result([bool]$Ok, [string]$Err) {
    @{ ok = $Ok; version = $script:Version; restarted = $script:Restarted; error = $Err;
       plugins = @($script:Plugins); gatewayRestarted = $script:GatewayRestarted } |
        ConvertTo-Json -Compress -Depth 4 | Write-Output
}
function Fail([string]$Err) { Write-Result $false $Err; exit 1 }
function EnvInt([string]$Name, [int]$Default) {
    $v = [Environment]::GetEnvironmentVariable($Name); if ($v) { return [int]$v } return $Default
}
function BudgetLeft {
    return [int]((EnvInt 'ALANS_WAY_VM_BUDGET' 270) - ((Get-Date) - $script:StartTime).TotalSeconds)
}

# --- Hermes plugins ---------------------------------------------------------
# Mirrors the POSIX twin: every profile's alans-way / alans-way-computer
# plugin updates through `hermes -p <profile> plugins update <name>` only.
function Find-Hermes {
    foreach ($n in @('hermes.exe', 'hermes.cmd', 'hermes.bat', 'hermes')) {
        $h = Get-Command $n -ErrorAction SilentlyContinue
        if ($h -and $h.CommandType -eq 'Application' -and $h.Source) { return $h.Source }
    }
    foreach ($c in @("$env:USERPROFILE\.local\bin\hermes.exe",
                     "$env:LOCALAPPDATA\Programs\hermes\hermes.exe")) {
        if (Test-Path $c) { return $c }
    }
    return $null
}

# One bounded hermes call: stdin is an empty file so a consent prompt can only
# ever read EOF ("no"), and the timeout keeps the call inside the run's
# remaining budget so the JSON result line is always reached.
function Invoke-Hermes([int]$Secs, [string[]]$HermesArgs) {
    $left = (BudgetLeft) - 8
    if ($left -le 0) { return @{ code = 124; out = '' } }
    if ($Secs -gt $left) { $Secs = $left }
    $out = [IO.Path]::GetTempFileName()
    $err = [IO.Path]::GetTempFileName()
    $inp = [IO.Path]::GetTempFileName()
    try {
        $exe = $script:HermesBin
        $argLine = $HermesArgs -join ' '
        if ($exe -match '\.(cmd|bat)$') { $argLine = "/d /c `"$exe`" $argLine"; $exe = if ($env:ComSpec) { $env:ComSpec } else { 'cmd.exe' } }
        $p = Start-Process -FilePath $exe -ArgumentList $argLine -NoNewWindow -PassThru `
            -RedirectStandardOutput $out -RedirectStandardError $err -RedirectStandardInput $inp
        if ($p.WaitForExit($Secs * 1000)) { $code = $p.ExitCode }
        else { try { $p.Kill() } catch {}; $code = 124 }
        $text = [string](Get-Content $out -Raw -ErrorAction SilentlyContinue) + "`n" +
                [string](Get-Content $err -Raw -ErrorAction SilentlyContinue)
        return @{ code = $code; out = $text }
    } catch {
        return @{ code = 1; out = "$_" }
    } finally {
        Remove-Item $out, $err, $inp -Force -ErrorAction SilentlyContinue
    }
}

# The profiles hermes counts: the default home plus every profile dir with the
# canonical name grammar, an identity marker and no .deleted tombstone.
function Get-Profiles([string]$Hhome) {
    $list = @()
    if (Test-Path $Hhome) { $list += @{ name = 'default'; home = $Hhome } }
    $pdir = Join-Path $Hhome 'profiles'
    if (Test-Path $pdir) {
        foreach ($d in (Get-ChildItem $pdir -Directory -ErrorAction SilentlyContinue)) {
            $n = $d.Name
            if ($n -notmatch '^[a-z0-9][a-z0-9_-]{0,63}$') { continue }
            if (Test-Path (Join-Path $pdir ".deleted\$n")) { continue }
            $found = $false
            foreach ($m in @('config.yaml', '.env', 'SOUL.md', 'profile.yaml', 'auth.json', 'state.db')) {
                if (Test-Path (Join-Path $d.FullName $m)) { $found = $true; break }
            }
            if ($found) { $list += @{ name = $n; home = $d.FullName } }
        }
    }
    return ,$list
}

function Get-PluginVersion([string]$Dir) {
    $f = Join-Path $Dir 'plugin.yaml'
    if (-not (Test-Path $f)) { return '' }
    $m = Get-Content $f -ErrorAction SilentlyContinue |
        Select-String -Pattern '^version:\s*"?([^"]+?)"?\s*$' | Select-Object -First 1
    if ($m) { return $m.Matches[0].Groups[1].Value }
    return ''
}

function Get-PluginMeta([string]$Pdir, [string]$Name) {
    $f = Join-Path $Pdir '.install-metadata.json'
    if (-not (Test-Path $f)) { return $null }
    try { $meta = Get-Content $f -Raw -ErrorAction Stop | ConvertFrom-Json } catch { return $null }
    if ($meta.PSObject.Properties.Name -contains $Name) { return $meta.$Name }
    return $null
}

# Advances an alans-way-agents clone to its newest release tag, forward only -
# the tag resolves as refs/tags/<tag>^{commit} so a branch can never stand in
# for it. Returns "moved|<ref>", "ahead|<ref>", "skipped|<reason>" or "none|".
function Update-Clone([string]$Dir) {
    if (-not (Test-Path "$Dir\.git")) { return 'none|' }
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) { return 'skipped|git is not available' }
    $url = ''
    try { $url = [string](git -C $Dir remote get-url origin 2>$null) } catch {}
    if ($url -notmatch 'alans-way-agents') { return 'none|' }
    git -C $Dir fetch --tags origin 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { git -C $Dir fetch --unshallow --tags origin 2>&1 | Out-Null }
    if ($LASTEXITCODE -ne 0) { Write-Output "vm-update: plugin clone fetch reported a problem; using the refs already in $Dir" }
    $tag = git -C $Dir tag -l 'v*' 2>$null |
        Where-Object { $_ -match '^v\d+\.\d+\.\d+$' } |
        Sort-Object { [version]($_ -replace '^v', '') } | Select-Object -Last 1
    if (-not $tag) { return 'none|' }
    $want = [string](git -C $Dir rev-parse --verify -q "refs/tags/${tag}^{commit}" 2>$null)
    $head = [string](git -C $Dir rev-parse HEAD 2>$null)
    if (-not $want -or -not $head) { return 'none|' }
    git -C $Dir merge-base --is-ancestor $want $head 2>$null
    if ($LASTEXITCODE -eq 0) {
        $desc = [string](git -C $Dir describe --tags --always 2>$null)
        if (-not $desc) { $desc = $head.Substring(0, 12) }
        return "ahead|$desc"
    }
    if (git -C $Dir status --porcelain 2>$null | Select-Object -First 1) { return 'skipped|local changes' }
    git -C $Dir merge-base --is-ancestor $head $want 2>$null
    if ($LASTEXITCODE -ne 0) { return "skipped|not an ancestor of $tag" }
    git -C $Dir -c advice.detachedHead=false checkout -q "refs/tags/$tag" 2>$null
    if ($LASTEXITCODE -eq 0 -and [string](git -C $Dir rev-parse HEAD 2>$null) -eq $want) { return "moved|$tag" }
    return "skipped|could not check out $tag"
}

function New-PluginEntry($profile, $name, $before, $after, $status, $err, $repoRef) {
    $e = [ordered]@{ profile = $profile; name = $name; before = $before; after = $after; status = $status }
    if ($err) { $e['error'] = $err }
    if ($repoRef) { $e['repoRef'] = $repoRef }
    return $e
}

function Update-HermesPlugins {
    $script:HermesBin = Find-Hermes
    if (-not $script:HermesBin) { Write-Output 'vm-update: no hermes CLI on this VM; skipping plugin updates'; return }
    $hhome = $env:HERMES_HOME
    if (-not $hhome) { $hhome = "$env:LOCALAPPDATA\hermes" }
    Write-Output 'vm-update: updating Hermes plugins'
    $clones = @{}
    $changed = $false
    $outOfTime = $false
    foreach ($prof in (Get-Profiles $hhome)) {
        if ($outOfTime) { break }
        $pdir = Join-Path $prof.home 'plugins'
        foreach ($name in @('alans-way', 'alans-way-computer')) {
            $pp = Join-Path $pdir $name
            if (-not (Test-Path $pp)) { continue }
            $meta = Get-PluginMeta $pdir $name
            $before = Get-PluginVersion $pp
            if (-not $before) { $before = [string]$meta.revision }
            $repoRef = ''
            $src = ''
            # Catalog installs carry a "catalog" block (and a marker file):
            # their reviewed pin is moved by `plugins update`, never here.
            if ($meta -and -not $meta.catalog -and -not (Test-Path (Join-Path $pp '.hermes-catalog.json'))) {
                $src = [string]$meta.source
            }
            if ($src -like 'file://*') {
                $clone = ($src -replace '^file://', '') -split '#' | Select-Object -First 1
                if (-not $clones.ContainsKey($clone)) { $clones[$clone] = Update-Clone $clone }
                $oc = $clones[$clone] -split '\|', 2
                if ($oc[0] -eq 'moved' -or $oc[0] -eq 'ahead') { $repoRef = $oc[1] }
                elseif ($oc[0] -eq 'skipped') {
                    Write-Output "vm-update: plugin $name ($($prof.name)): clone left alone: $($oc[1])"
                    $script:Plugins += New-PluginEntry $prof.name $name $before $before 'skipped' $oc[1] ''
                    continue
                }
            }
            if ((BudgetLeft) -le 15) {
                Write-Output 'vm-update: plugin phase ran out of the time budget; remaining plugins will retry next update'
                $outOfTime = $true; break
            }
            if ($prof.name -eq 'default') { $updArgs = @('plugins', 'update', $name) }
            else { $updArgs = @('-p', $prof.name, 'plugins', 'update', $name) }
            $r = Invoke-Hermes (EnvInt 'ALANS_WAY_VM_PLUGIN_TIMEOUT' 90) $updArgs
            $after = Get-PluginVersion $pp
            if (-not $after) { $after = [string](Get-PluginMeta $pdir $name).revision }
            $st = ''; $err = ''
            if ($r.code -eq 124) { $st = 'failed'; $err = 'the hermes update timed out' }
            elseif ($r.out -match '(?i)not applied|declined|confirm to continue|fail.?closed|not granted|new capabilities') { $st = 'needs_approval' }
            elseif ($r.code -ne 0) {
                $st = 'failed'
                $err = (($r.out -split "`n" | Where-Object { $_.Trim() } | Select-Object -Last 2) -join ' ')
            }
            elseif ($r.out -match '(?i)already (up to date|at catalog pin)') { $st = 'current' }
            else { $st = 'updated' }
            if ($st -eq 'updated') { $changed = $true }
            elseif ($st -eq 'needs_approval' -and $r.out -match 'updated|Re-installed') {
                # The code moved but new capabilities stay ungranted until reviewed.
                $changed = $true
            }
            Write-Output "vm-update: plugin $name ($($prof.name)): $st"
            $script:Plugins += New-PluginEntry $prof.name $name $before $after $st $err $repoRef
        }
    }
    # The gateway loads plugin code at start, so one drain-restart when
    # anything actually changed.
    if ($changed) {
        Write-Output 'vm-update: restarting the agent gateway'
        $r = Invoke-Hermes (EnvInt 'ALANS_WAY_VM_GATEWAY_TIMEOUT' 180) @('gateway', 'restart')
        if ($r.code -eq 0) { $script:GatewayRestarted = $true; Write-Output 'vm-update: agent gateway restarted' }
        else { Write-Output 'vm-update: gateway restart did not finish; on the VM run: hermes gateway restart' }
    }
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

# The broker's loopback status url and bearer token come from its data dir.
# connection.json is authoritative: the broker writes its own url and token
# there, so a relocated port or token file still resolves.
function Get-Status {
    $data = $env:ALANS_WAY_VM_DATA
    if (-not $data) { $data = $env:HERMES_VPS_BROWSER_DATA }
    if (-not $data -or -not (Test-Path "$data\config.json")) {
        $data = "$env:USERPROFILE\.local\share\hermes-alans-way\browser"
        if (-not (Test-Path "$data\config.json")) { return $null }
    }
    $url = ''; $token = ''
    try { $conn = Get-Content "$data\connection.json" -Raw | ConvertFrom-Json
          $url = [string]$conn.url; $token = [string]$conn.token } catch {}
    if (-not $token) {
        $tf = "$data\app-token.json"
        if (-not (Test-Path $tf)) {
            try { $moved = [string](Get-Content "$data\config.json" -Raw | ConvertFrom-Json).appTokenFile } catch { $moved = '' }
            if ($moved) { $tf = $moved }
        }
        try { $token = [string](Get-Content $tf -Raw | ConvertFrom-Json).token } catch {}
    }
    if (-not $token) { return $null }
    if ($url -notmatch '^http://(127\.0\.0\.1|localhost|\[::1\]):') {
        $port = 0
        try { $port = [int](Get-Content "$data\config.json" -Raw | ConvertFrom-Json).port } catch {}
        if (-not $port) { $port = 9465 }
        $url = "http://127.0.0.1:$port"
    }
    try { return Invoke-RestMethod -Uri "$url/v1/status" -Headers @{ Authorization = "Bearer $token" } -TimeoutSec 4 }
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
    if ($LASTEXITCODE -ne 0) { git fetch --unshallow --tags origin 2>&1 | Out-Null }
    if ($LASTEXITCODE -ne 0) { git fetch --depth=1000000 --tags origin 2>&1 | Out-Null }
    if ($LASTEXITCODE -ne 0) { Write-Output 'vm-update: git fetch reported a problem; trying the objects already in the checkout' }
    # Only a real tag may satisfy the pin: resolve refs/tags/$Tag fully so a
    # same-named branch or lightweight ref can never stand in for it.
    $want = (git rev-parse --verify -q "refs/tags/${Tag}^{commit}" 2>$null)
    if (-not $want) { Fail "tag $Tag is not in the checkout and could not be fetched" }
    git -c advice.detachedHead=false checkout -q "refs/tags/$Tag" 2>&1 | Out-Null
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

# The app tools are already updated; a plugin error must stay a warning, never lose the result line.
try { Update-HermesPlugins } catch { Write-Output "vm-update: plugin update stopped: $($_.Exception.Message)" }
Write-Result $true ''
