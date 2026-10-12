#!/bin/sh
# reboot-smoke.sh — check that the managed-browser services on a Hermes host
# come back on their own. Run it on that host (Linux VPS, macOS guest, or a
# Windows guest from Git Bash) as the account that owns the browser data:
#
#   sh scripts/reboot-smoke.sh            # crash each service, verify it recovers
#   sh scripts/reboot-smoke.sh --check    # only verify health (run after a real reboot)
#
# Crash mode SIGKILLs, one at a time: the managed Chromium, the tab broker, the
# Chromium keeper and (when present) mac-watch. Each must be restarted by its
# service manager (systemd, launchd, Task Scheduler or supervisord) and the
# broker must report the browser connected again. Open VPS tabs close; the
# profile and its logins stay on disk. Exits non-zero on the first failure.
# SMOKE_TIMEOUT (seconds, default 90) bounds each wait: Windows restarts a
# failed task after one minute.
set -eu

CHECK_ONLY=0
case "${1:-}" in
  --check) CHECK_ONLY=1;;
  "") ;;
  -h|--help) awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; exit 0;;
  *) printf 'reboot-smoke: unknown arg: %s\n' "$1" >&2; exit 64;;
esac
TIMEOUT="${SMOKE_TIMEOUT:-90}"
WIN=0; case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) WIN=1;; esac

ok() { printf '  ok    %s\n' "$*"; }
die() { printf '  FAIL  %s\n' "$*" >&2; exit 1; }
command -v node >/dev/null 2>&1 || die "node not found on PATH"

# The broker's own defaults: HERMES_VPS_BROWSER_DATA, else the per-OS data dir.
DATA="$(node -e '
const os = require("os"), path = require("path");
console.log(process.env.HERMES_VPS_BROWSER_DATA || (process.platform === "darwin"
  ? path.join(os.homedir(), "Library", "Application Support", "hermes-alans-way", "browser")
  : path.join(os.homedir(), ".local", "share", "hermes-alans-way", "browser")));')"
[ -f "$DATA/config.json" ] || die "no $DATA/config.json (set HERMES_VPS_BROWSER_DATA)"
# Logins survive a restart only if the profile lives on disk outside a temp dir.
PROFILE="$(node -e '
const a = (require(process.argv[1]).browserArgs || []).find((x) => x.startsWith("--user-data-dir="));
console.log(a ? a.slice(16) : "");' "$DATA/config.json")"
case "$PROFILE" in
  "") die "config.json browserArgs set no --user-data-dir: Chromium would use a throwaway profile";;
  /tmp/*|/var/tmp/*|/private/tmp/*) die "profile $PROFILE is in a temp dir that a reboot clears";;
esac

# pids <pattern>: node or browser processes whose command line contains it.
pids() {
  if [ "$WIN" = 1 ]; then
    # Spaces become wildcards: Windows may quote the script path before its args.
    powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe' or Name='chrome.exe' or Name='msedge.exe' or Name='chromium.exe'\" | Where-Object { \$_.CommandLine -like '*$(printf '%s' "$1" | tr ' ' '*')*' } | ForEach-Object { \$_.ProcessId }" | tr -d '\r'
  else
    # Skip shells whose command line merely mentions the pattern.
    for p in $(pgrep -f -- "$1"); do
      case "$(basename "$(ps -o comm= -p "$p" 2>/dev/null)")" in
        ""|sh|bash|zsh|dash|-*|ssh|sudo) ;;
        *) printf '%s\n' "$p";;
      esac
    done
  fi
}
kill9() {
  for p in $1; do
    if [ "$WIN" = 1 ]; then powershell -NoProfile -Command "Stop-Process -Id $p -Force -ErrorAction SilentlyContinue"
    else kill -9 "$p" 2>/dev/null || true; fi
  done
}
# fresh <pattern> <old pids>: a process matches and none of the old ones survive.
fresh() {
  now="$(pids "$1")"
  [ -n "$now" ] || return 1
  for p in $2; do printf '%s\n' "$now" | grep -qx "$p" && return 1; done
  return 0
}
# healthy: the broker answers /v1/status with Chromium connected.
healthy() {
  node -e '
const c = require(process.argv[1]);
fetch(c.url + "/v1/status", { headers: { Authorization: "Bearer " + c.token }, signal: AbortSignal.timeout(3000) })
  .then((r) => r.json()).then((s) => process.exit(s.browserUp === true ? 0 : 1), () => process.exit(1));
' "$DATA/connection.json" 2>/dev/null
}
wait_for() { # wait_for <what> <command...>
  what="$1"; shift
  start=$(date +%s)
  until "$@"; do
    [ $(($(date +%s) - start)) -lt "$TIMEOUT" ] || die "$what (gave up after ${TIMEOUT}s)"
    sleep 2
  done
  ok "$what ($(($(date +%s) - start))s)"
}

BROWSER="user-data-dir=$PROFILE" BROKER="vps-browser-host.cjs serve" KEEPER="vps-chromium-host.cjs" WATCH="workspace-router.cjs --watch"

printf 'reboot-smoke: data %s\n' "$DATA"
[ -n "$(pids "$KEEPER")" ] || die "Chromium keeper ($KEEPER) is not running"
[ -n "$(pids "$BROKER")" ] || die "tab broker ($BROKER) is not running"
wait_for "broker reports Chromium connected" healthy

if [ "$CHECK_ONLY" = 0 ]; then
  # Every process on the profile dies, as in a reboot (killing only the main
  # one can leave the broker on a half-open CDP socket). The keeper relaunches
  # Chromium, the broker exits on the lost CDP socket and its service manager
  # starts a new one that reconnects.
  old_browser="$(pids "$BROWSER")" old_broker="$(pids "$BROKER")"
  [ -n "$old_browser" ] || die "no Chromium running on profile $PROFILE"
  kill9 "$old_browser"
  wait_for "Chromium relaunched by the keeper" fresh "$BROWSER" "$old_browser"
  wait_for "broker restarted by its service" fresh "$BROKER" "$old_broker"
  wait_for "broker reconnected to Chromium" healthy

  for target in "$BROKER" "$KEEPER" "$WATCH"; do
    old="$(pids "$target")"
    if [ -z "$old" ]; then ok "$target not running here, skipped"; continue; fi
    kill9 "$old"
    wait_for "$target restarted by its service" fresh "$target" "$old"
  done
  wait_for "broker reports Chromium connected" healthy
fi

[ -d "$PROFILE" ] || die "profile $PROFILE does not exist"
ok "persistent profile $PROFILE"
printf 'reboot-smoke: passed\n'
