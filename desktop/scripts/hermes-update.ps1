# hermes-update.ps1 - Windows guest twin of hermes-update.sh. The desktop app
# pipes this file over ssh stdin (via cmd so any sshd shell works). It stops
# every running hermes gateway (`hermes update` refuses while one is up on
# Windows), runs `hermes update --yes --keep-stash` once, starts the gateways
# it stopped - success or failure - then `hermes --version` for the report and
# `hermes [-p <profile>] send -t telegram <text>` for every profile so each
# bot reports the result in its usual chat.
# The last stdout line is one JSON result:
# {"ok":bool,"version":"x.y.z","updated":bool,"error":"...","messaged":bool,
#  "gatewayRestarted":bool,"messages":[{"profile":"...","sent":bool,"error":"..."}]}
# Written for Windows PowerShell 5.1 (no ?? or ?:).
$ErrorActionPreference = 'Stop'
$script:Version = ''
$script:Updated = $false
$script:Messaged = $false
$script:GatewayRestarted = $false
$script:Messages = @()
$script:StartTime = Get-Date
$script:HermesBin = ''

function Write-Result([bool]$Ok, [string]$Err) {
    @{ ok = $Ok; version = $script:Version; updated = $script:Updated; error = $Err;
       messaged = $script:Messaged; gatewayRestarted = $script:GatewayRestarted;
       messages = @($script:Messages) } |
        ConvertTo-Json -Compress -Depth 4 | Write-Output
}
function Say([string]$Text) { Write-Output "hermes-update: $Text" }
function EnvInt([string]$Name, [int]$Default) {
    $v = [Environment]::GetEnvironmentVariable($Name); if ($v) { return [int]$v } return $Default
}
function BudgetLeft {
    return [int]((EnvInt 'ALANS_WAY_HERMES_BUDGET' 270) - ((Get-Date) - $script:StartTime).TotalSeconds)
}
function Tail-Text([string]$Text, [int]$Max) {
    $t = (($Text -split "`n" | Where-Object { $_.Trim() }) -join ' ') -replace '\s+', ' '
    if ($t.Length -gt $Max) { return $t.Substring($t.Length - $Max) }
    return $t
}

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

# One bounded hermes call: stdin is an empty file so a prompt can only ever
# read EOF ("no"), and the timeout keeps the call inside the run's remaining
# budget so the JSON result line is always reached. -Unbudgeted skips the
# budget clamp: a gateway restart must be attempted even when nothing is left.
function Invoke-Hermes([int]$Secs, [string[]]$HermesArgs, [switch]$Unbudgeted) {
    if (-not $Unbudgeted) {
        $left = (BudgetLeft) - 8
        if ($left -le 0) { return @{ code = 124; out = '' } }
        if ($Secs -gt $left) { $Secs = $left }
    }
    if ($Secs -le 0) { return @{ code = 124; out = '' } }
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
        else {
            # Kill the whole tree, not only the launcher: a .cmd/.bat shim
            # leaves the real hermes process running after $p.Kill(). taskkill
            # can fail without throwing, so the .NET kill runs whenever the
            # process is still up afterward.
            try { & taskkill /PID $p.Id /T /F 2>$null | Out-Null } catch {}
            if (-not $p.HasExited) { try { $p.Kill() } catch {} }
            $code = 124
        }
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

# gateway subcommand args for one profile: `gateway <x>` for the default,
# `-p <name> gateway <x>` for named ones.
function Gw-Args([string]$Name, [string]$Sub) {
    if ($Name -eq 'default') { return @('gateway', $Sub) }
    return @('-p', $Name, 'gateway', $Sub)
}

$script:HermesBin = Find-Hermes
if (-not $script:HermesBin) { Write-Result $false 'no hermes CLI on this machine'; exit 1 }
$hhome = $env:HERMES_HOME
if (-not $hhome) { $hhome = "$env:LOCALAPPDATA\hermes" }

# `hermes update` refuses while a gateway holds the install on Windows, so
# every profile reporting a live gateway is stopped first and - success or
# failure - started again afterward. A named profile the default-profile
# multiplexer serves reports "running via the default-profile multiplexer";
# stopping the default takes the mux down and starting it re-serves them, so
# those are skipped here.
$gwTimeout = EnvInt 'ALANS_WAY_HERMES_GATEWAY_TIMEOUT' 60
$restart = @()
foreach ($prof in (Get-Profiles $hhome)) {
    if ((BudgetLeft) -le 30) { Say 'ran out of the time budget; remaining gateways were not stopped'; break }
    $st = Invoke-Hermes (EnvInt 'ALANS_WAY_HERMES_STATUS_TIMEOUT' 20) (Gw-Args $prof.name 'status')
    if ($st.out -notmatch '(?i)gateway is running') { continue }
    if ($st.out -match '(?i)multiplexer') { continue }
    $restart += $prof.name
    Say "stopping the $($prof.name) gateway for the update"
    $sp = Invoke-Hermes $gwTimeout (Gw-Args $prof.name 'stop')
    if ($sp.code -ne 0) { Say "gateway $($prof.name): stop did not finish: $(Tail-Text $sp.out 160)" }
}

Say 'running hermes update'
# The update may not eat the restart reserve: it gets at most the remaining
# budget minus one gateway timeout per stopped gateway, so starting them back
# always fits. The reserve itself is capped at half the run budget: past that,
# several stopped gateways would leave the update no time at all and skip it
# after they were already stopped. Restarts run unbudgeted, so a capped
# reserve only sizes the update's share. A cap at zero never spawns -
# Invoke-Hermes returns 124 first.
$upSecs = EnvInt 'ALANS_WAY_HERMES_UPDATE_TIMEOUT' 200
$reserveCap = [Math]::Max($gwTimeout, [int]((EnvInt 'ALANS_WAY_HERMES_BUDGET' 270) / 2))
$reserve = [Math]::Min($restart.Count * $gwTimeout, $reserveCap)
$upCap = (BudgetLeft) - $reserve - 8
if ($upCap -lt $upSecs) { $upSecs = $upCap }
$r = Invoke-Hermes $upSecs @('update', '--yes', '--keep-stash')
$ok = ($r.code -eq 0)
$err = ''
if ($r.code -eq 124) { $err = 'the hermes update timed out' }
elseif (-not $ok) {
    $err = Tail-Text $r.out 300
    if (-not $err) { $err = "hermes update exited $($r.code)" }
}
$script:Updated = $ok -and ($r.out -notmatch '(?i)already up.to.date|nothing to update|no update available')

# Start back exactly the gateways this run stopped - a failed update must not
# leave the fleet's bots offline. Unbudgeted: the attempt happens even if the
# update or a slow stop already spent the reserve.
foreach ($name in $restart) {
    $up = Invoke-Hermes $gwTimeout (Gw-Args $name 'start') -Unbudgeted
    if ($up.code -eq 0) { $script:GatewayRestarted = $true; Say "gateway $($name): started" }
    else { Say "gateway $($name): start failed: $(Tail-Text $up.out 160)" }
}

# The version read follows the update so an install that moved reports the new
# one; a failed update still reports whatever version is on the machine now.
$v = Invoke-Hermes (EnvInt 'ALANS_WAY_HERMES_VERSION_TIMEOUT' 20) @('--version')
$vm = [regex]::Match([string]$v.out, 'Hermes Agent v([0-9][0-9.]*)')
if ($vm.Success) { $script:Version = $vm.Groups[1].Value }
if ($ok) { Say 'hermes update finished' } else { Say "hermes update failed: $err" }

# The message each profile's bot sends home: outcome, host and version so a
# user with several machines can tell them apart. Characters cmd would read
# as syntax (when hermes resolves to a .cmd shim) never reach the message.
$where = ''
if ($env:COMPUTERNAME) { $where = " on $env:COMPUTERNAME" }
if ($ok) {
    if ($script:Updated) { $msg = "Hermes update finished$where." } else { $msg = "Hermes is already up to date$where." }
    if ($script:Version) { $msg = "$msg Now on v$($script:Version)." }
} else {
    $short = $err; if ($short.Length -gt 200) { $short = $short.Substring(0, 200) }
    $msg = "Hermes update failed${where}: $short"
}
$msg = ($msg -replace '[&|<>^%"]', ' ')

if ((BudgetLeft) -gt 15) {
    Say 'telling your bot to message you'
    foreach ($prof in (Get-Profiles $hhome)) {
        if ((BudgetLeft) -le 12) { Say 'ran out of the time budget; remaining profiles were not messaged'; break }
        $quoted = '"' + $msg + '"'
        if ($prof.name -eq 'default') { $sendArgs = @('send', '-q', '-t', 'telegram', $quoted) }
        else { $sendArgs = @('-p', $prof.name, 'send', '-q', '-t', 'telegram', $quoted) }
        $s = Invoke-Hermes (EnvInt 'ALANS_WAY_HERMES_SEND_TIMEOUT' 30) $sendArgs
        $e = @{ profile = $prof.name; sent = ($s.code -eq 0); error = '' }
        if ($s.code -eq 0) { $script:Messaged = $true }
        else {
            $e['error'] = Tail-Text $s.out 200
            if (-not $e['error']) { $e['error'] = "send exited $($s.code)" }
        }
        if ($s.code -eq 0) { Say "message $($prof.name): sent" } else { Say "message $($prof.name): failed" }
        $script:Messages += $e
    }
} else {
    Say 'no time left to message you'
}
if ((-not $script:Messaged) -and $ok) { Say 'no profile could message you; the result is only in this report' }

Write-Result $ok $err
if ($ok) { exit 0 } else { exit 1 }
