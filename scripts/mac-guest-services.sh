#!/bin/sh
# mac-guest-services.sh — install the managed-browser services inside a macOS
# guest VM. Run it on the guest (its Terminal, or over SSH as the console user)
# from a checkout of this repository:
#
#   sh scripts/mac-guest-services.sh [--node /opt/homebrew/bin/node] [--cdp-port PORT] [--no-load]
#
# It writes the two LaunchAgents that replace the Linux systemd units from
# desktop/docs/vps-browser.md — com.alans-way.chromium keeps the configured
# Chromium reachable on its loopback CDP port, and com.alans-way.browser runs
# the tab broker — plus a default config.json when none exists. The CDP port
# defaults to 9223, honors --cdp-port or $ALANS_WAY_CDP_PORT, and otherwise
# picks the first free loopback port from 9223 up; an existing config.json
# keeps whatever port it already chose. There is no
# DISPLAY on macOS: agents bootstrapped into gui/<uid> join the console
# session. The checkout path is baked into the plists; re-run after moving it.
# Safe to re-run: existing agents are booted out and loaded again.
set -eu

say() { printf '%s\n' "$*"; }
die() { printf 'mac-guest-services: %s\n' "$*" >&2; exit 1; }

NODE="" NO_LOAD=0 CDP_PORT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --node) NODE="${2:-}"; [ -n "$NODE" ] || die "--node needs a path"; shift 2;;
    --cdp-port) CDP_PORT="${2:-}"; [ -n "$CDP_PORT" ] || die "--cdp-port needs a port"; shift 2;;
    --no-load) NO_LOAD=1; shift;;
    -h|--help) sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit 0;;
    *) die "unknown arg: $1";;
  esac
done

[ "$(uname -s)" = Darwin ] || die "run this inside the macOS guest VM, not on the host"

REPO="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPTS="$REPO/desktop/scripts"
for f in vps-chromium-host.cjs vps-browser-host.cjs; do
  [ -f "$SCRIPTS/$f" ] || die "missing $SCRIPTS/$f — run from a full checkout of this repository"
done

# Node is not on the sshd/launchd PATH under Homebrew; take an explicit
# absolute path, then the usual install locations, then PATH.
if [ -z "$NODE" ]; then
  for cand in /opt/homebrew/bin/node /usr/local/bin/node; do
    if [ -x "$cand" ]; then NODE="$cand"; break; fi
  done
  [ -n "$NODE" ] || NODE="$(command -v node 2>/dev/null || true)"
fi
[ -n "$NODE" ] || die "node not found — install it (brew install node) or pass --node /absolute/path/node"
case "$NODE" in /*) ;; *) NODE="$(cd "$(dirname "$NODE")" && pwd)/$(basename "$NODE")";; esac
[ -x "$NODE" ] || die "--node $NODE is not executable"

# nc and lsof flag names differ across systems; node is already a hard
# requirement, so probe the loopback port with a short connect.
port_in_use() {
  "$NODE" -e 'const s=require("net").connect(Number(process.argv[1]),"127.0.0.1");const done=c=>{s.destroy();process.exit(c)};s.once("connect",()=>done(0));s.once("error",()=>done(1));s.setTimeout(800,()=>done(1));' "$1"
}

pick_cdp_port() {
  case "$CDP_PORT" in
    '') ;;
    *[!0-9]*) die "--cdp-port must be a number";;
    *)
      [ "$CDP_PORT" -ge 1024 ] && [ "$CDP_PORT" -le 65535 ] || die "--cdp-port out of range: $CDP_PORT"
      port_in_use "$CDP_PORT" && say "mac-guest-services: warning: 127.0.0.1:$CDP_PORT is already listening"
      return 0;;
  esac
  CDP_PORT=9223
  while port_in_use "$CDP_PORT"; do
    CDP_PORT=$((CDP_PORT + 1))
    [ "$CDP_PORT" -le 9254 ] || die "no free loopback port for the managed browser CDP endpoint (tried 9223-9254); pass --cdp-port"
  done
}

DATA="${HERMES_VPS_BROWSER_DATA:-$HOME/Library/Application Support/hermes-alans-way/browser}"
case "$DATA" in *'"'*|*'\\'*) die "data dir path must not contain quotes or backslashes: $DATA";; esac
mkdir -p "$DATA"
chmod 700 "$DATA"

if [ ! -f "$DATA/config.json" ]; then
  CDP_PORT="${CDP_PORT:-${ALANS_WAY_CDP_PORT:-}}"
  pick_cdp_port
  CHROME=""
  for cand in \
    "${CHROMIUM:-}" \
    "/Applications/Chromium.app/Contents/MacOS/Chromium" \
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    "$HOME/Applications/Chromium.app/Contents/MacOS/Chromium" \
    "$HOME/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"; do
    if [ -n "$cand" ] && [ -x "$cand" ]; then CHROME="$cand"; break; fi
  done
  [ -n "$CHROME" ] || die "no Chromium found — install Chromium or Google Chrome, fetch a Chrome for Testing build (https://googlechromelabs.github.io/chrome-for-testing/), or set \$CHROMIUM to the browser binary, then re-run"
  case "$CHROME" in *'"'*|*'\\'*) die "browser path must not contain quotes or backslashes: $CHROME";; esac
  cat > "$DATA/config.json" <<EOF
{
  "port": 9465,
  "cdpUrl": "http://127.0.0.1:$CDP_PORT",
  "browserCommand": "$CHROME",
  "browserArgs": [
    "--user-data-dir=$DATA/chromium",
    "--remote-debugging-port=$CDP_PORT",
    "--remote-debugging-address=127.0.0.1",
    "--no-first-run",
    "--start-maximized",
    "about:blank"
  ]
}
EOF
  chmod 600 "$DATA/config.json"
  say "mac-guest-services: wrote $DATA/config.json (browserCommand: $CHROME, cdp: 127.0.0.1:$CDP_PORT)"
else
  say "mac-guest-services: kept existing $DATA/config.json"
fi

xml() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }

AGENTS="$HOME/Library/LaunchAgents"
mkdir -p "$AGENTS"

write_agent() {
  label="$1" log="$2"; shift 2
  plist="$AGENTS/$label.plist"
  {
    cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>$label</string>
	<key>ProgramArguments</key>
	<array>
EOF
    for arg in "$@"; do printf '\t\t<string>%s</string>\n' "$(xml "$arg")"; done
    cat <<EOF
	</array>
	<key>WorkingDirectory</key>
	<string>$(xml "$DATA")</string>
	<key>EnvironmentVariables</key>
	<dict>
		<key>HERMES_VPS_BROWSER_DATA</key>
		<string>$(xml "$DATA")</string>
		<key>PATH</key>
		<string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
	</dict>
	<key>KeepAlive</key>
	<true/>
	<key>RunAtLoad</key>
	<true/>
	<key>StandardOutPath</key>
	<string>$(xml "$DATA")/$log.log</string>
	<key>StandardErrorPath</key>
	<string>$(xml "$DATA")/$log.log</string>
</dict>
</plist>
EOF
  } > "$plist"
  chmod 644 "$plist"
  say "mac-guest-services: wrote $plist"
}

write_agent com.alans-way.chromium chromium "$NODE" "$SCRIPTS/vps-chromium-host.cjs"
write_agent com.alans-way.browser browser "$NODE" "$SCRIPTS/vps-browser-host.cjs" "serve"

if [ "$NO_LOAD" = 1 ]; then
  say "mac-guest-services: --no-load given; agents not loaded"
else
  DOMAIN="gui/$(id -u)"
  for label in com.alans-way.chromium com.alans-way.browser; do
    launchctl bootout "$DOMAIN/$label" 2>/dev/null || true
    launchctl bootstrap "$DOMAIN" "$AGENTS/$label.plist" 2>/dev/null \
      || launchctl load -w "$AGENTS/$label.plist" \
      || die "launchd refused $label — log in to the VM's GUI session and re-run"
    launchctl print "$DOMAIN/$label" >/dev/null 2>&1 \
      || die "launchd did not keep $label — check $DATA/*.log and re-run inside the GUI session"
    say "mac-guest-services: $label loaded into $DOMAIN"
  done
  say "mac-guest-services: done — the broker listens on 127.0.0.1:9465 and writes connection.json in $DATA"
fi
