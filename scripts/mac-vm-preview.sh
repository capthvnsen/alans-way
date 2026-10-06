#!/bin/sh
# mac-vm-preview.sh — put a Tart guest's screen in the app's desktop viewer.
#
#   sh scripts/mac-vm-preview.sh [--name hermes-guest] [--port 6080]
#
# Starts the VM headless with the Virtualization.Framework VNC server
# (loopback-only, generated password), bridges it to a WebSocket with
# websockify and prints the URL and password to paste into Settings -> VPS
# desktop connection. The VNC server lives inside this 'tart run' process, so
# the VM must not already be running — this script always starts it itself
# (a suspended VM resumes). Ctrl+C stops the bridge and asks the VM to shut
# down gracefully.
set -eu

NAME="hermes-guest"
WSPORT="6080"

say() { printf '%s\n' "$*"; }
die() { printf 'mac-vm-preview: %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --name) NAME="${2:-}"; [ -n "$NAME" ] || die "--name needs a value"; shift 2;;
    --port) WSPORT="${2:-}"; [ -n "$WSPORT" ] || die "--port needs a value"; shift 2;;
    -h|--help) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0;;
    *) die "unknown arg: $1";;
  esac
done
printf '%s' "$NAME" | grep -Eq '^[A-Za-z0-9._-]+$' || die "bad --name (letters, digits, . _ - only)"
printf '%s' "$WSPORT" | grep -Eq '^[0-9]+$' && [ "$WSPORT" -ge 1024 ] && [ "$WSPORT" -le 65535 ] \
  || die "bad --port (1024-65535)"

[ "$(uname -s)" = Darwin ] || die "run this on the Mac that hosts the VM"
command -v tart >/dev/null || die "Tart is not installed — run: brew install cirruslabs/cli/tart"
command -v websockify >/dev/null \
  || die "websockify is not installed — run: brew install websockify (or: pipx install websockify)"
tart list --source local --quiet | grep -qxF "$NAME" \
  || die "no local VM named '$NAME' — provision one with scripts/mac-vm-setup.sh, or pass --name"
# 'tart ip' still resolves a recently-stopped VM's cached lease — read the
# State column instead. A running VM's VNC server belongs to that 'tart run'.
if tart list --source local | awk 'NR>1 && $2=="'"$NAME"'" {s=$NF} END {exit !(s=="running")}'; then
  die "$NAME is already running — its VNC server belongs to that 'tart run' process. Stop it first: tart stop $NAME"
fi

LOG="$(mktemp -t mac-vm-preview)"
WSLOG="$(mktemp -t mac-vm-preview-ws)"
TART_PID="" WS_PID=""

cleanup() {
  trap - EXIT INT TERM
  [ -z "$WS_PID" ] || kill "$WS_PID" 2>/dev/null
  if [ -n "$TART_PID" ] && kill -0 "$TART_PID" 2>/dev/null; then
    say "mac-vm-preview: asking the VM to shut down"
    tart stop "$NAME" >/dev/null 2>&1 || kill "$TART_PID" 2>/dev/null || true
    wait "$TART_PID" 2>/dev/null || true
  fi
  rm -f "$LOG" "$WSLOG"
}
trap 'cleanup' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

say "mac-vm-preview: starting $NAME headless"
tart run "$NAME" --no-graphics --vnc-experimental --suspendable >"$LOG" 2>&1 &
TART_PID=$!

# tart prints 'VNC server is running at vnc://:<password>@127.0.0.1:<port>'.
VNC_LINE="" i=0
while [ -z "$VNC_LINE" ] && [ "$i" -lt 90 ]; do
  kill -0 "$TART_PID" 2>/dev/null || die "tart run exited: $(tail -3 "$LOG")"
  VNC_LINE="$(grep -o 'vnc://[^ ]*' "$LOG" 2>/dev/null | head -1 || true)"
  [ -n "$VNC_LINE" ] || { sleep 1; i=$((i + 1)); }
done
[ -n "$VNC_LINE" ] || die "tart printed no VNC address — last output: $(tail -3 "$LOG")"

VNC_PASS="${VNC_LINE#vnc://:}"; VNC_PASS="${VNC_PASS%@*}"
VNC_ADDR="${VNC_LINE##*@}"
[ -n "$VNC_PASS" ] && [ -n "$VNC_ADDR" ] || die "could not parse '$VNC_LINE'"

websockify "127.0.0.1:$WSPORT" "$VNC_ADDR" >"$WSLOG" 2>&1 &
WS_PID=$!
sleep 1
kill -0 "$WS_PID" 2>/dev/null || die "websockify exited: $(tail -3 "$WSLOG")"

say ""
say "===== Guest preview ready ====="
say "  URL (paste in Settings -> VPS desktop connection): ws://127.0.0.1:$WSPORT"
say "  VNC password (the app asks once per launch):       $VNC_PASS"
say "  Guest VNC endpoint: $VNC_ADDR"
say ""
say "Watching this preview does not require the VM's TCC grants — those gate"
say "the agent's own screen reads. Press Ctrl+C to stop and shut the VM down."
rc=0; wait "$TART_PID" 2>/dev/null || rc=$?
[ "$rc" = 0 ] || [ "$rc" = 130 ] || [ "$rc" = 143 ] \
  || { say "mac-vm-preview: tart exited with status $rc — last output:"; tail -5 "$LOG" >&2; }
