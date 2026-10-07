# connect-windows.ps1 — connect this PC to the machine that runs your Hermes
# gateway. Your setup agent prints this command with the remote address and
# public keys filled in:
#
#   powershell -ExecutionPolicy Bypass -File connect-windows.ps1 `
#     -Vps root@<vps-tailscale-ip> `
#     -VpsHostKey 'ssh-ed25519 AAAA...' `
#     -VpsKey 'ssh-ed25519 AAAA... root@vps'
#
# It installs or upgrades the Alan's Way app, lets that key log in to this PC
# over SSH (only from your Tailscale network), pins the remote host key so
# this PC can reach it without a trust-on-first-use prompt, and prints the
# values the agent needs next. The -Vps address must be a Tailscale name or
# IP. Only public keys are printed. Safe to re-run.
#
# Windows notes vs the Mac version:
#  - OpenSSH Server is an optional Windows capability; installing it needs an
#    elevated PowerShell, so run this script as Administrator the first time.
#  - For administrator accounts, authorized keys live in
#    C:\ProgramData\ssh\administrators_authorized_keys — Windows ignores
#    ~/.ssh/authorized_keys for admins.
#  - sshd sessions default to cmd.exe; this script points them at PowerShell.
[CmdletBinding()]
param(
  [string]$Vps = '',
  [string]$VpsHostKey = '',
  [string]$VpsKey = '',
  [switch]$SkipInstall
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$InstallUrl = 'https://raw.githubusercontent.com/capthvnsen/alans-way/main/scripts/install-windows.ps1'
$InstallScript = Join-Path $PSScriptRoot 'install-windows.ps1'

function Say([string]$m) { Write-Host $m }
function Die([string]$m) { Write-Host "connect-windows: $m" -ForegroundColor Red; exit 1 }

if ($env:OS -notmatch 'Windows') { Die 'run this on your Windows PC' }
if (-not $Vps -or -not $VpsHostKey -or -not $VpsKey) {
  Die 'needs -Vps, -VpsHostKey and -VpsKey; ask your setup agent for the full command'
}

# Strict shapes: these values land in authorized_keys and known_hosts.
if ($Vps -notmatch '^([A-Za-z0-9._-]+@)?[A-Za-z0-9.:-]+$') { Die 'bad -Vps (expected user@host)' }
$keyRe = '^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)) [A-Za-z0-9+/]+=*'
if ($VpsHostKey -notmatch "$keyRe`$") { Die "bad -VpsHostKey (expected 'ssh-ed25519 AAAA...')" }
if ($VpsKey -notmatch "$keyRe( [A-Za-z0-9@._-]+)?`$") { Die "bad -VpsKey (expected 'ssh-ed25519 AAAA... comment')" }
$VpsHost = ($Vps -split '@')[-1]

# Tailscale addresses are 100.64.0.0/10 (100.64.0.0 to 100.127.255.255) and
# fd7a:115c:a1e0::/48. Names are MagicDNS (*.ts.net) or a short single label.
function Test-TailnetIp([string]$h) {
  if ($h -match '^(0|[1-9]\d{0,2})(\.(0|[1-9]\d{0,2})){3}$') {
    $o = @($h -split '\.' | ForEach-Object { [int]$_ })
    return (@($o | Where-Object { $_ -gt 255 }).Count -eq 0) -and $o[0] -eq 100 -and $o[1] -ge 64 -and $o[1] -le 127
  }
  return $h -match '^fd7a:115c:a1e0:'
}
function Test-TailnetHost([string]$h) {
  if (Test-TailnetIp $h) { return $true }
  return ($h -match '^([A-Za-z0-9][A-Za-z0-9-]*\.)+ts\.net$') -or ($h -match '^[A-Za-z0-9][A-Za-z0-9-]*$')
}
if (-not (Test-TailnetHost $VpsHost)) {
  Die "$VpsHost is not a Tailscale address. Alan's Way connects over your Tailscale network only. On the agent machine run 'tailscale ip -4' and use that 100.x.y.z address (or its name ending in .ts.net), then re-run this command."
}

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

# Tailscale gives the two machines a private path to each other.
$ts = 'C:\Program Files\Tailscale\tailscale.exe'
if (-not (Test-Path $ts)) {
  $tscmd = Get-Command tailscale.exe -ErrorAction SilentlyContinue
  if ($tscmd) { $ts = $tscmd.Source }
}
$pcIp = if ($ts) { (& $ts ip -4 2>$null | Select-Object -First 1) } else { '' }
if (-not $pcIp) { Die 'Tailscale is not connected on this PC. Install it from https://tailscale.com/download, sign in with the same account as your agent machine, then re-run this command.' }
if (-not (Test-TailnetIp $VpsHost)) {
  $resolved = $false
  try { & $ts ip -4 $VpsHost 2>$null | Out-Null; $resolved = ($LASTEXITCODE -eq 0) } catch { }
  if (-not $resolved) { Die "$VpsHost is not on your tailnet. Check the name with 'tailscale status', or use the agent machine's 100.x.y.z address, then re-run this command." }
}

# OpenSSH Server. Capability install and service setup require elevation.
$cap = Get-WindowsCapability -Online -Name 'OpenSSH.Server*' -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $cap) {
  $sshd = Get-Service sshd -ErrorAction SilentlyContinue
  if (-not $sshd) { Die 'OpenSSH Server capability not found — this Windows build may be too old. Install OpenSSH Server manually, then re-run.' }
} elseif ($cap.State -ne 'Installed') {
  if (-not $isAdmin) { Die 'OpenSSH Server is not installed. Re-run this script in an elevated PowerShell (right-click → Run as administrator).' }
  Say 'Installing OpenSSH Server'
  Add-WindowsCapability -Online -Name $cap.Name | Out-Null
}
$sshd = Get-Service sshd -ErrorAction SilentlyContinue
if (-not $sshd) { Die 'OpenSSH Server is still missing after install — check Windows Update, then re-run.' }
if ($isAdmin) {
  Set-Service sshd -StartupType Automatic
  if ($sshd.Status -ne 'Running') { Start-Service sshd }
  if (-not (Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -DisplayName 'OpenSSH Server (sshd)' -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 | Out-Null
  }
  # SSH sessions default to cmd.exe; the agent's scripts expect PowerShell.
  New-Item -Path 'HKLM:\SOFTWARE\OpenSSH' -Force | Out-Null
  New-ItemProperty -Path 'HKLM:\SOFTWARE\OpenSSH' -Name DefaultShell -Value "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -PropertyType String -Force | Out-Null
} else {
  if ($sshd.Status -ne 'Running') {
    Die 'OpenSSH Server is installed but not running. Start it once from an elevated PowerShell: Start-Service sshd; Set-Service sshd -StartupType Automatic'
  }
  $sshShellProp = Get-ItemProperty 'HKLM:\SOFTWARE\OpenSSH' -Name DefaultShell -ErrorAction SilentlyContinue
  $sshShell = if ($sshShellProp) { $sshShellProp.DefaultShell } else { '' }
  if ($sshShell -notmatch 'powershell\.exe$') {
    Die 'sshd runs but SSH sessions land in cmd.exe, and the agent scripts need PowerShell. In an elevated PowerShell run: New-ItemProperty -Path "HKLM:\SOFTWARE\OpenSSH" -Name DefaultShell -Value "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -PropertyType String -Force'
  }
}

if (-not (Test-NetConnection -ComputerName 127.0.0.1 -Port 22 -InformationLevel Quiet -WarningAction SilentlyContinue)) {
  Die 'sshd is not answering on port 22 — check Windows Firewall allows inbound TCP 22.'
}

if (-not $SkipInstall) {
  if (Test-Path $InstallScript) {
    & powershell -ExecutionPolicy Bypass -File $InstallScript
  } else {
    # Run as a child process, never Invoke-Expression — the install script
    # calls exit, which under IEX would end this script before keys are wired.
    $tmpScript = Join-Path $env:TEMP ('install-windows-' + [guid]::NewGuid() + '.ps1')
    (New-Object Net.WebClient).DownloadString($InstallUrl) | Set-Content -Encoding UTF8 $tmpScript
    & powershell -ExecutionPolicy Bypass -File $tmpScript
    Remove-Item $tmpScript -Force -ErrorAction SilentlyContinue
  }
  if ($LASTEXITCODE -ne 0 -and $null -ne $LASTEXITCODE) { Die 'installing the app failed (see above)' }
}

# authorized_keys: administrators must use the shared administrators_authorized_keys
# file (Windows OpenSSH ignores ~/.ssh/authorized_keys for admin users); standard
# users use their own file.
$userIsAdmin = $isAdmin
New-Item -ItemType Directory -Path "$HOME\.ssh" -Force | Out-Null
if ($userIsAdmin) {
  $keysFile = 'C:\ProgramData\ssh\administrators_authorized_keys'
  if (-not (Test-Path $keysFile)) { New-Item -ItemType File -Path $keysFile -ErrorAction SilentlyContinue | Out-Null }
  # The file must be owned/locked to Administrators + SYSTEM or sshd ignores it.
  icacls $keysFile /inheritance:r /grant 'Administrators:F' /grant 'SYSTEM:F' | Out-Null
} else {
  $keysFile = "$HOME\.ssh\authorized_keys"
  if (-not (Test-Path $keysFile)) { New-Item -ItemType File -Path $keysFile | Out-Null }
}

# Limit the key to the tailnet. An existing line carrying the same key (for
# example an earlier unrestricted one) is replaced, so re-running tightens an
# old install and never duplicates the line.
$fromTailnet = 'from="100.64.0.0/10,fd7a:115c:a1e0::/48"'
$keyBlob = ($VpsKey -split ' ')[1]
$kept = @(Get-Content $keysFile -ErrorAction SilentlyContinue | Where-Object { $_.Trim() -and (($_ -split '\s+') -notcontains $keyBlob) })
[System.IO.File]::WriteAllLines($keysFile, [string[]]($kept + "$fromTailnet $VpsKey"), (New-Object System.Text.UTF8Encoding($false)))
Say "connect-windows: the agent machine's key can log in to this PC, from your tailnet only ($keysFile)"

$knownHosts = "$HOME\.ssh\known_hosts"
if (-not (Test-Path $knownHosts)) { New-Item -ItemType File -Path $knownHosts | Out-Null }
$pinned = & ssh-keygen -F $VpsHost -f $knownHosts 2>$null | Where-Object { $_ -notmatch '^#' }
if (-not $pinned) {
  Add-Content $knownHosts "$VpsHost $VpsHostKey"
  Say "connect-windows: pinned the agent machine's host key for $VpsHost"
} elseif ($pinned -match [regex]::Escape(($VpsHostKey -split ' ')[1])) {
  Say "connect-windows: the host key for $VpsHost was already pinned"
} else {
  Die "this PC already has a different host key for $VpsHost. If the remote was rebuilt, remove the old one with: ssh-keygen -R $VpsHost - then re-run."
}

if (-not (Test-Path "$HOME\.ssh\id_ed25519")) { & ssh-keygen -q -t ed25519 -N '' -f "$HOME\.ssh\id_ed25519" }
$pcHostKey = ''
foreach ($candidate in 'C:\ProgramData\ssh\ssh_host_ed25519_key.pub', 'C:\ProgramData\ssh\ssh_host_rsa_key.pub') {
  if (Test-Path $candidate) { $pcHostKey = ((Get-Content $candidate) -split ' ')[0..1] -join ' '; break }
}
if (-not $pcHostKey) { Die "could not read this PC's SSH host key" }

# Windows stores time zones by Windows ID; the agent needs the IANA name.
$tzMap = @{
  'UTC'='UTC'; 'GMT Standard Time'='Europe/London'; 'Greenwich Standard Time'='Atlantic/Reykjavik';
  'W. Europe Standard Time'='Europe/Berlin'; 'Central Europe Standard Time'='Europe/Budapest';
  'Romance Standard Time'='Europe/Paris'; 'Central European Standard Time'='Europe/Warsaw';
  'Eastern Europe Standard Time'='Europe/Chisinau'; 'FLE Standard Time'='Europe/Kyiv';
  'GTB Standard Time'='Europe/Bucharest'; 'E. Europe Standard Time'='Europe/Chisinau';
  'Turkey Standard Time'='Europe/Istanbul'; 'Israel Standard Time'='Asia/Jerusalem';
  'Russian Standard Time'='Europe/Moscow'; 'Arab Standard Time'='Asia/Riyadh';
  'Arabian Standard Time'='Asia/Dubai'; 'India Standard Time'='Asia/Kolkata';
  'Sri Lanka Standard Time'='Asia/Colombo'; 'Nepal Standard Time'='Asia/Kathmandu';
  'Bangladesh Standard Time'='Asia/Dhaka'; 'SE Asia Standard Time'='Asia/Bangkok';
  'China Standard Time'='Asia/Shanghai'; 'Singapore Standard Time'='Asia/Singapore';
  'Taipei Standard Time'='Asia/Taipei'; 'Tokyo Standard Time'='Asia/Tokyo';
  'Korea Standard Time'='Asia/Seoul'; 'AUS Eastern Standard Time'='Australia/Sydney';
  'E. Australia Standard Time'='Australia/Brisbane'; 'New Zealand Standard Time'='Pacific/Auckland';
  'Pacific Standard Time'='America/Los_Angeles'; 'US Mountain Standard Time'='America/Phoenix';
  'Mountain Standard Time'='America/Denver'; 'Central Standard Time'='America/Chicago';
  'Eastern Standard Time'='America/New_York'; 'Atlantic Standard Time'='America/Halifax';
  'Newfoundland Standard Time'='America/St_Johns'; 'SA Eastern Standard Time'='America/Cayenne';
  'E. South America Standard Time'='America/Sao_Paulo'; 'Argentina Standard Time'='America/Buenos_Aires';
  'Pacific SA Standard Time'='America/Santiago'; 'Central America Standard Time'='America/Guatemala';
  'Central Standard Time (Mexico)'='America/Mexico_City'; 'Alaskan Standard Time'='America/Anchorage';
  'Hawaiian Standard Time'='Pacific/Honolulu'; 'South Africa Standard Time'='Africa/Johannesburg';
  'Cen. Australia Standard Time'='Australia/Adelaide'; 'W. Australia Standard Time'='Australia/Perth';
  'W. Central Africa Standard Time'='Africa/Lagos'; 'Egypt Standard Time'='Africa/Cairo';
  'Morocco Standard Time'='Africa/Casablanca'; 'Georgian Standard Time'='Asia/Tbilisi';
  'Azerbaijan Standard Time'='Asia/Baku'; 'Pakistan Standard Time'='Asia/Karachi';
  'Almaty Standard Time'='Asia/Almaty'; 'N. Central Asia Standard Time'='Asia/Novosibirsk';
  'North Asia Standard Time'='Asia/Krasnoyarsk'; 'North Asia East Standard Time'='Asia/Irkutsk';
  'Yakutsk Standard Time'='Asia/Yakutsk'; 'Vladivostok Standard Time'='Asia/Vladivostok';
  'Magadan Standard Time'='Asia/Magadan'; 'Kamchatka Standard Time'='Asia/Kamchatka';
  'UTC-11'='Pacific/Pago_Pago'; 'UTC-2'='Atlantic/South_Georgia'; 'UTC+12'='Pacific/Fiji';
  'Aleutian Standard Time'='America/Adak'; 'Marquesas Standard Time'='Pacific/Marquesas';
  'Easter Island Standard Time'='Pacific/Easter'; 'Canada Central Standard Time'='America/Regina';
  'Paraguay Standard Time'='America/Asuncion'; 'Venezuela Standard Time'='America/Caracas';
  'Central Brazilian Standard Time'='America/Cuiaba'; 'SA Western Standard Time'='America/La_Paz';
  'SA Pacific Standard Time'='America/Bogota'; 'US Eastern Standard Time'='America/Indianapolis';
  'Mountain Standard Time (Mexico)'='America/Mazatlan'; 'Pacific Standard Time (Mexico)'='America/Tijuana';
  'Middle East Standard Time'='Asia/Beirut'; 'Jordan Standard Time'='Asia/Amman';
  'Syria Standard Time'='Asia/Damascus'; 'West Asia Standard Time'='Asia/Tashkent';
  'Afghanistan Standard Time'='Asia/Kabul'; 'Ekaterinburg Standard Time'='Asia/Yekaterinburg';
  'Myanmar Standard Time'='Asia/Yangon'; 'North Korea Standard Time'='Asia/Pyongyang';
  'West Pacific Standard Time'='Pacific/Port_Moresby'; 'Tasmania Standard Time'='Australia/Hobart';
  'Lord Howe Standard Time'='Australia/Lord_Howe'; 'Chatham Islands Standard Time'='Pacific/Chatham';
  'Samoa Standard Time'='Pacific/Apia'; 'Tonga Standard Time'='Pacific/Nukualofa';
  'Mauritius Standard Time'='Indian/Mauritius';
  'Namibia Standard Time'='Africa/Windhoek'; 'Sudan Standard Time'='Africa/Khartoum';
  'South Sudan Standard Time'='Africa/Juba'; 'Iran Standard Time'='Asia/Tehran';
  'Caucasus Standard Time'='Asia/Yerevan'; 'Qyzylorda Standard Time'='Asia/Qyzylorda';
  'Omsk Standard Time'='Asia/Omsk'; 'Barnaul Standard Time'='Asia/Barnaul';
  'Altai Standard Time'='Asia/Barnaul'; 'Tomsk Standard Time'='Asia/Tomsk';
  'Saratov Standard Time'='Europe/Saratov'; 'Volgograd Standard Time'='Europe/Volgograd';
  'Astrakhan Standard Time'='Europe/Astrakhan'; 'Kaliningrad Standard Time'='Europe/Kaliningrad';
}
$tz = $tzMap[[System.TimeZoneInfo]::Local.Id]
if (-not $tz) { $tz = [System.TimeZoneInfo]::Local.Id; Say "connect-windows: WARNING — '$tz' has no IANA mapping in this script; pass the IANA name to your agent manually." }

Say ''
Say '===== Copy everything between these lines and send it to your agent ====='
Say "MAC_SSH=$env:USERNAME@$pcIp"
Say "MAC_TZ=$tz"
Say "MAC_HOST_KEY=$pcHostKey"
Say "MAC_KEY=$(((Get-Content "$HOME\.ssh\id_ed25519.pub") -split ' ')[0..1] -join ' ') $env:USERNAME@pc"
Say '===== end ====='
Say '(The names say MAC_* for connector compatibility — the values describe this PC.)'
