#!/bin/sh
# mac-vm-setup.sh — provision the golden macOS guest image on this Mac.
#
#   sh scripts/mac-vm-setup.sh [--name hermes-guest] [--non-interactive]
#
# Clones the Cirrus macOS base image with Tart, boots it (a VM window opens on
# this Mac), waits for SSH, then pauses for the one step automation cannot do —
# granting Accessibility and Screen Recording inside the guest — and finishes
# by suspending the VM and cloning it to <name>-golden. Clone the golden image
# for each real guest; the suspension snapshot preserves the granted
# permissions and a warm desktop. Safe to re-run: an existing VM is reused
# instead of recloned, and an existing golden image is kept.
set -eu

IMAGE="ghcr.io/cirruslabs/macos-sequoia-base"
NAME="hermes-guest"
INTERACTIVE=1
TART_PID=""
TART_LOG=""

say() { printf '%s\n' "$*"; }
die() { printf 'mac-vm-setup: %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --name) NAME="${2:-}"; [ -n "$NAME" ] || die "--name needs a value"; shift 2;;
    --non-interactive) INTERACTIVE=0; shift;;
    -h|--help) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0;;
    *) die "unknown arg: $1";;
  esac
done
printf '%s' "$NAME" | grep -Eq '^[A-Za-z0-9._-]+$' || die "bad --name (letters, digits, . _ - only)"

[ "$(uname -s)" = Darwin ] || die "run this on the Mac that will host the VM"
[ "$(uname -m)" = arm64 ] || die "Tart virtualizes macOS only on Apple Silicon"
command -v tart >/dev/null || die "Tart is not installed — run: brew install cirruslabs/cli/tart"

cleanup() {
  trap - EXIT INT TERM
  if [ -n "$TART_PID" ] && kill -0 "$TART_PID" 2>/dev/null; then
    say "mac-vm-setup: stopping the VM"
    tart stop "$NAME" >/dev/null 2>&1 || kill "$TART_PID" 2>/dev/null || true
    wait "$TART_PID" 2>/dev/null || true
  fi
  [ -z "$TART_LOG" ] || rm -f "$TART_LOG"
}
trap 'cleanup' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if tart list --source local --quiet | grep -qxF "$NAME"; then
  say "mac-vm-setup: VM '$NAME' already exists — reusing it"
else
  say "mac-vm-setup: cloning $IMAGE -> $NAME (downloads several GB, once)"
  tart clone "$IMAGE" "$NAME" || die "clone failed — check disk space and network, then re-run"
fi

# 'tart ip' can still resolve a recently-stopped VM's cached lease — only a
# "running" State column means the VM is actually up.
vm_running() {
  tart list --source local | awk 'NR>1 && $2=="'"$NAME"'" {s=$NF} END {exit !(s=="running")}'
}

IP=""
vm_running && IP="$(tart ip "$NAME" 2>/dev/null || true)"
if [ -z "$IP" ]; then
  say "mac-vm-setup: starting $NAME — a VM window opens on this Mac"
  TART_LOG="$(mktemp -t mac-vm-setup)"
  tart run "$NAME" --suspendable >"$TART_LOG" 2>&1 &
  TART_PID=$!
  i=0
  while [ -z "$IP" ] && [ "$i" -lt 180 ]; do
    kill -0 "$TART_PID" 2>/dev/null || die "tart run exited: $(tail -3 "$TART_LOG")"
    sleep 2; i=$((i + 2))
    vm_running || continue
    IP="$(tart ip "$NAME" 2>/dev/null || true)"
  done
  [ -n "$IP" ] || die "the VM never got an IP — check $TART_LOG or run 'tart run $NAME' manually"
else
  say "mac-vm-setup: $NAME is already running"
fi
say "mac-vm-setup: guest IP $IP — SSH as admin@$IP (password: admin)"

say "mac-vm-setup: waiting for Remote Login on $IP:22"
i=0
until nc -z -G 2 "$IP" 22 >/dev/null 2>&1; do
  if [ -n "$TART_PID" ]; then kill -0 "$TART_PID" 2>/dev/null || die "tart run exited: $(tail -3 "$TART_LOG")"; fi
  i=$((i + 2)); [ "$i" -lt 180 ] || die "sshd never answered — the Cirrus base image enables Remote Login; check the VM window"
  sleep 2
done
say "mac-vm-setup: SSH is up"

say ""
say "===== Human step — grant desktop permissions inside the VM ====="
say "Automation cannot do this part: macOS only grants screen permissions"
say "interactively. The '$NAME' window is open on this Mac — inside the VM:"
say ""
say "  1. Log in as admin if asked (password: admin); the image usually"
say "     signs in on its own."
say "  2. Install the guest pieces — in the VM's Terminal, or over SSH from"
say "     another Mac terminal (ssh admin@$IP):"
say "       git clone https://github.com/capthvnsen/alans-way ~/alans-way"
say "       sh ~/alans-way/scripts/mac-guest-services.sh"
say "  3. In the VM window (NOT over SSH), build the desktop helper and run"
say "     it once so macOS can ask for the permissions SSH never sees:"
say "       xcode-select -p >/dev/null 2>&1 || xcode-select --install"
say "       swiftc -O -o ~/alans-way/desktop/scripts/mac-computer \\"
say "         ~/alans-way/desktop/scripts/mac-computer.swift"
say "       ~/alans-way/desktop/scripts/mac-computer apps"
say "  4. Approve Accessibility AND Screen Recording for 'mac-computer'"
say "     (System Settings -> Privacy & Security -> Accessibility, then"
say "     Screen Recording). Approve Terminal too if it asks."
say ""

if [ "$INTERACTIVE" = 1 ]; then
  { printf '%s' "Press Enter when the VM shows both permissions granted... " > /dev/tty && read -r _ < /dev/tty; } \
    || die "no terminal to confirm with — re-run with --non-interactive"
  say ""
else
  say "mac-vm-setup: --non-interactive — NOT waiting for the permission step"
  say "mac-vm-setup: without those grants the guest cannot read or drive its desktop"
fi

say "mac-vm-setup: suspending $NAME"
tart suspend "$NAME" || die "suspend failed — the VM must have been started by this script (tart run --suspendable); stop it and re-run"
if [ -n "$TART_PID" ]; then wait "$TART_PID" 2>/dev/null || true; TART_PID=""; fi

GOLDEN="$NAME-golden"
if tart list --source local --quiet | grep -qxF "$GOLDEN"; then
  say "mac-vm-setup: $GOLDEN already exists — keeping it"
else
  say "mac-vm-setup: cloning $NAME -> $GOLDEN"
  tart clone "$NAME" "$GOLDEN" || die "golden clone failed"
fi

say ""
say "===== Done ====="
say "  $NAME          provisioned guest, suspended — 'tart run $NAME --suspendable' resumes it"
say "  $GOLDEN   golden image — 'tart clone $GOLDEN <copy>' for extra guests"
say "  Guest SSH    ssh admin@\$(tart ip <vm>)   (password: admin)"
say "  Preview      sh scripts/mac-vm-preview.sh --name <vm>"
say "  Full guide   docs/mac-vm-guest.md"
