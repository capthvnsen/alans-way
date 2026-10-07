#!/bin/sh
# alans-watchdog-mac.sh — let your VPS route its outbound traffic through this Mac.
#
#   curl -fsSL https://raw.githubusercontent.com/capthvnsen/alans-way/main/scripts/alans-watchdog-mac.sh | sh
#
# It turns on Tailscale's exit-node advertisement on this Mac and prints the
# value the VPS-side installer needs. One human step remains: approving the
# advertised exit-node routes in the Tailscale admin console. With
# --off it stops advertising again. Safe to re-run.
#
# While advertised and approved, your VPS can send all of its egress through
# this Mac — agents on the VPS browse and call APIs from your home address.
# When this Mac sleeps or leaves the tailnet, the VPS watchdog
# (scripts/alans-watchdog-vps.sh) clears the exit node and the VPS returns to its
# own egress. See docs/alans-watchdog.md.
set -eu

say() { printf '%s\n' "$*"; }
die() { printf 'alans-watchdog-mac: %s\n' "$*" >&2; exit 1; }

OFF=0
while [ $# -gt 0 ]; do
  case "$1" in
    --off) OFF=1; shift;;
    -h|--help) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0;;
    *) die "unknown arg: $1";;
  esac
done

[ "$(uname -s)" = Darwin ] || die "run this on your Mac"

TS=/Applications/Tailscale.app/Contents/MacOS/Tailscale
[ -x "$TS" ] || TS="$(command -v tailscale || true)"
[ -n "$TS" ] || die "Tailscale is not installed. Install it from https://tailscale.com/download, sign in with the same account as your VPS, then re-run."

# The daemon socket is root-owned for the brew/tailscaled variant; retry
# non-interactive sudo when the plain call cannot set the preference.
ts_set() {
  if "$TS" set "$@" 2>/dev/null; then return 0; fi
  if sudo -n "$TS" set "$@" 2>/dev/null; then return 0; fi
  return 1
}

"$TS" status >/dev/null 2>&1 || sudo -n "$TS" status >/dev/null 2>&1 \
  || die "Tailscale is not connected on this Mac — open Tailscale and sign in, then re-run."
MAC_IP="$("$TS" ip -4 2>/dev/null | head -1 || sudo -n "$TS" ip -4 2>/dev/null | head -1 || true)"
[ -n "$MAC_IP" ] || die "Tailscale reported no IPv4 address — is it signed in?"

if [ "$OFF" = 1 ]; then
  ts_set --advertise-exit-node=false || die "could not update Tailscale (permission denied). Try: sudo $TS set --advertise-exit-node=false"
  say "alans-watchdog-mac: this Mac no longer advertises itself as an exit node"
  say "alans-watchdog-mac: the VPS watchdog will fall back to direct egress on its next check"
  exit 0
fi

ts_set --advertise-exit-node \
  || die "could not enable exit-node advertisement. Try: sudo $TS set --advertise-exit-node (or in the Tailscale menu: Exit Node → Run Exit Node)"

# Confirm the advertisement actually landed in prefs; do not fail on odd output.
if "$TS" debug prefs 2>/dev/null | grep -q '"0\.0\.0\.0/0"' \
   || sudo -n "$TS" debug prefs 2>/dev/null | grep -q '"0\.0\.0\.0/0"'; then
  say "alans-watchdog-mac: this Mac now advertises itself as an exit node"
else
  say "alans-watchdog-mac: advertisement flag set; could not confirm it in prefs — check 'tailscale debug prefs' if the VPS never sees it"
fi

say ""
say "===== One human step left ====="
say "Approve this Mac as an exit node in the Tailscale admin console:"
say "  https://login.tailscale.com/admin/machines → this Mac → ⋯ → Edit route settings →"
say "  enable 'Use as exit node' (approves routes 0.0.0.0/0 and ::/0)."
say "Without that approval the Mac advertises but the tailnet cannot select it."
say ""
say "Keep the Mac awake when you want it used — a sleeping Mac cannot forward,"
say "and the VPS watchdog will fall back to direct egress until it returns."
say ""
say "===== Give this to your agent (or keep it for the VPS step) ====="
say "MAC_EXIT_NODE=$MAC_IP"
say "===== end ====="
say "On the VPS, run: sh scripts/alans-watchdog-vps.sh --exit-node $MAC_IP"
