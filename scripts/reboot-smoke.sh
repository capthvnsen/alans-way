#!/bin/sh
# reboot-smoke.sh — check that the managed-browser services on a Hermes host
# come back on their own. Run it on that host (Linux VPS, macOS guest, or a
# Windows guest from Git Bash) as the account that owns the browser data:
#
#   sh scripts/reboot-smoke.sh                # verify health only (same as --check; run after a real reboot)
#   sh scripts/reboot-smoke.sh --crash        # crash each service, verify it recovers (asks first)
#   sh scripts/reboot-smoke.sh --crash --yes  # the same without asking, for scripts
#
# Crash mode SIGKILLs, one at a time: the managed Chromium, the tab broker, the
# Chromium keeper and (when present) mac-watch. --crash asks on the terminal
# before killing; without a terminal it needs --yes. Only node and Chrome,
# Chromium or Edge processes are matched. Each service must be restarted by its
# manager (systemd, launchd, Task Scheduler or supervisord), and the broker must
# report the browser connected again. Open VPS tabs close; the profile and its
# logins stay on disk. Exits non-zero on the first failure. SMOKE_TIMEOUT
# (seconds, default 90) bounds each wait: Windows restarts a failed task after
# one minute.
set -eu

ok() { printf '  ok    %s\n' "$*"; }
die() { printf '  FAIL  %s\n' "$*" >&2; exit 1; }

MODE="" YES=0
for arg; do
  case "$arg" in
    --check|--crash)
      [ -z "$MODE" ] || [ "$MODE" = "${arg#--}" ] || {
        printf 'reboot-smoke: use --check or --crash, not both\n' >&2
        exit 64
      }
      MODE="${arg#--}"
      ;;
    -y|--yes) YES=1;;
    -h|--help) awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; exit 0;;
    *) printf 'reboot-smoke: unknown arg: %s\n' "$arg" >&2; exit 64;;
  esac
done
[ "$YES" = 0 ] || [ "$MODE" = crash ] || {
  printf 'reboot-smoke: --yes only applies to --crash\n' >&2
  exit 64
}
MODE="${MODE:-check}"
# --crash kills services: fail fast when nobody can confirm.
[ "$MODE" = check ] || [ "$YES" = 1 ] || [ -t 0 ] || die "--crash kills the browser services; run it from a terminal to confirm, or pass --yes"

TIMEOUT="${SMOKE_TIMEOUT:-90}"
WIN=0; case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) WIN=1;; esac
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

# is_target <comm>: node or a Chrome-family browser, the same set as on Windows.
is_target() {
  case "$1" in
    # Linux comm is cut to 15 chars.
    node|nodejs|chrome|chromium|chromium-browse*|msedge) return 0;;
    "Google Chrome"|"Google Chrome Helper"*|Chromium|"Chromium Helper"*|"Microsoft Edge"|"Microsoft Edge Helper"*) return 0;;
  esac
  return 1
}

# pids <pattern>: allowlisted service processes whose command line contains it.
pids() {
  if [ "$WIN" = 1 ]; then
    # Spaces become wildcards: Windows may quote the script path before its args.
    powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe' or Name='chrome.exe' or Name='msedge.exe' or Name='chromium.exe'\" | Where-Object { \$_.CommandLine -like '*$(printf '%s' "$1" | tr ' ' '*')*' } | ForEach-Object { \$_.ProcessId }" | tr -d '\r'
  else
    for p in $(pgrep -f -- "$1"); do
      comm="$(ps -o comm= -p "$p" 2>/dev/null || true)"
      [ -n "$comm" ] || continue
      comm="$(basename "$comm")"
      if is_target "$comm"; then printf '%s\n' "$p"; fi
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
confirm() {
  [ "$YES" = 1 ] && return 0
  printf 'reboot-smoke: SIGKILL the managed Chromium on %s, the tab broker, the keeper and mac-watch? Open VPS tabs close. [y/N] ' "$PROFILE" >&2
  read -r answer || answer=""
  case "$answer" in
    y|Y|yes|Yes|YES) ;;
    *) printf 'reboot-smoke: not confirmed, nothing killed\n' >&2; exit 1;;
  esac
}

BROWSER="user-data-dir=$PROFILE" BROKER="vps-browser-host.cjs serve" KEEPER="vps-chromium-host.cjs" WATCH="workspace-router.cjs --watch"

printf 'reboot-smoke: data %s\n' "$DATA"
[ -n "$(pids "$KEEPER")" ] || die "Chromium keeper ($KEEPER) is not running"
[ -n "$(pids "$BROKER")" ] || die "tab broker ($BROKER) is not running"
wait_for "broker reports Chromium connected" healthy

if [ "$MODE" = crash ]; then
  confirm
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
