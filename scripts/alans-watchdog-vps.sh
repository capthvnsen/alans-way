#!/bin/sh
# alans-watchdog-vps.sh — route this VPS's egress through the user's computer while
# it is connected. Run it on the VPS as root, from a checkout of this
# repository (the plugin clones it to /opt/hermes-alans-way/browser):
#
#   sudo sh scripts/alans-watchdog-vps.sh --exit-node <mac-tailscale-name-or-ip>
#
# It installs a systemd service running scripts/alans-watchdog.sh, which
# applies `tailscale set --exit-node=<peer>` after the peer proves reachable and
# clears it again once it stops answering — so when the user's computer sleeps,
# shuts or leaves the tailnet, the VPS returns to its own egress. The peer must
# already advertise and be approved as an exit node (scripts/alans-watchdog-mac.sh
# plus the admin-console approval it prints). Safe to re-run.
#
#   --exit-node <name|ip>   Tailscale name or IP of the user's computer (required)
#   --allow-lan             this VPS keeps reaching its own LAN while routed
#   --interval <seconds>    watchdog probe interval, 5-600 (default 15)
#   --no-start              write the unit but do not enable/start it
#   --status                print routing and watchdog state, then exit
#   --uninstall             remove the unit and clear the exit node, then exit
set -eu

say() { printf '%s\n' "$*"; }
die() { printf 'alans-watchdog-vps: %s\n' "$*" >&2; exit 1; }

UNIT=hermes-alans-way-watchdog.service
UNIT_PATH=/etc/systemd/system/$UNIT

PEER="" ALLOW_LAN=0 INTERVAL=15 NO_START=0 STATUS=0 UNINSTALL=0
while [ $# -gt 0 ]; do
  case "$1" in
    --exit-node) PEER="${2:-}"; shift 2;;
    --allow-lan) ALLOW_LAN=1; shift;;
    --interval) INTERVAL="${2:-}"; shift 2;;
    --no-start) NO_START=1; shift;;
    --status) STATUS=1; shift;;
    --uninstall) UNINSTALL=1; shift;;
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0;;
    *) die "unknown arg: $1";;
  esac
done

[ "$(uname -s)" = Linux ] || die "run this on the Linux VPS — the user's computer runs scripts/alans-watchdog-mac.sh instead"
command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ] || die "systemd is required"

if [ "$STATUS" = 1 ]; then
  say "--- watchdog ---"
  systemctl status "$UNIT" --no-pager 2>/dev/null | sed -n '1,4p' || say "$UNIT is not installed"
  say "--- routing ---"
  tailscale status --json 2>/dev/null | python3 -c '
import json, sys
try: s = json.load(sys.stdin)
except Exception: print("tailscale status unavailable"); raise SystemExit
e = s.get("ExitNodeStatus") or {}
print("exit node: " + (e.get("ID") + (" (online)" if e.get("Online") else " (OFFLINE)") if e.get("ID") else "none — direct egress"))' 2>/dev/null || true
  exit 0
fi

[ "$(id -u)" = 0 ] || die "run as root (sudo sh $0 ...) — the watchdog manages system routing"

if [ "$UNINSTALL" = 1 ]; then
  systemctl disable --now "$UNIT" 2>/dev/null || true
  rm -f "$UNIT_PATH"
  systemctl daemon-reload
  APPLIED=""
  command -v python3 >/dev/null 2>&1 \
    && APPLIED="$(tailscale status --json 2>/dev/null | python3 -c 'import json,sys; print((json.load(sys.stdin).get("ExitNodeStatus") or {}).get("ID") or "")' 2>/dev/null || true)"
  if [ -z "$APPLIED" ] && ! command -v python3 >/dev/null 2>&1; then
    say "alans-watchdog-vps: could not inspect the current exit node without python3 — verify with 'tailscale status'"
  fi
  if [ -n "$APPLIED" ]; then
    tailscale set --exit-node= 2>/dev/null \
      && say "alans-watchdog-vps: cleared the applied exit node — direct egress restored" \
      || say "alans-watchdog-vps: WARNING — could not clear the applied exit node; run: tailscale set --exit-node="
  fi
  say "alans-watchdog-vps: removed $UNIT"
  exit 0
fi

[ -n "$PEER" ] || die "needs --exit-node <name-or-ip> — the alans-watchdog-mac.sh output on the user's computer prints it as MAC_EXIT_NODE"
printf '%s' "$PEER" | grep -Eq '^[A-Za-z0-9._:-]+$' || die "bad --exit-node value: $PEER"
case "$INTERVAL" in ''|*[!0-9]*) die "bad --interval (seconds): $INTERVAL";; esac
[ "$INTERVAL" -ge 5 ] && [ "$INTERVAL" -le 600 ] || die "--interval must be 5-600 seconds"

REPO="$(cd "$(dirname "$0")/.." && pwd)"
WATCHDOG="$REPO/scripts/alans-watchdog.sh"
[ -f "$WATCHDOG" ] || die "missing $WATCHDOG — run from a full checkout of this repository"

command -v tailscale >/dev/null 2>&1 || die "tailscale is not installed on this VPS — it is how the VPS reaches the user's computer (see docs/setup-for-agents.md stage 2)"
tailscale status >/dev/null 2>&1 || die "tailscale is not connected on this VPS"
command -v python3 >/dev/null 2>&1 || die "python3 is required (it is already a Hermes prerequisite)"
tailscale set --help 2>&1 | grep -q -- '--exit-node' || die "this Tailscale is too old for 'tailscale set --exit-node' — upgrade tailscaled first"

# Exit nodes need real TUN routing; a userspace-networking tailscaled cannot use one.
tailscale status --json | python3 -c 'import json,sys; sys.exit(0 if json.load(sys.stdin).get("TUN") else 1)' \
  || die "tailscaled runs with userspace networking (TUN=false) — exit nodes require kernel TUN on the client"

# Warn (don't fail) when the peer cannot currently serve as an exit node —
# approval can land after install; the watchdog applies it once it works.
PEER_INFO="$(tailscale status --json | python3 -c '
import json, sys
want = sys.argv[1].lower().rstrip(".")
for p in (json.load(sys.stdin).get("Peer") or {}).values():
    names = [p.get("DNSName") or "", p.get("HostName") or ""] + list(p.get("TailscaleIPs") or [])
    if any(want == str(n).lower().rstrip(".") for n in names):
        print("\t".join(("1" if p.get("Online") else "0", "1" if p.get("ExitNodeOption") else "0")))
        break
' "$PEER")"
[ -n "$PEER_INFO" ] || die "$PEER is not a tailnet peer of this VPS — check the name/IP from alans-watchdog-mac.sh (MAC_EXIT_NODE)"
[ "$(printf '%s' "$PEER_INFO" | cut -f2)" = 1 ] \
  || say "alans-watchdog-vps: WARNING — $PEER is not an approved exit node yet; approve it in the admin console (Machines → ⋯ → Edit route settings) or the watchdog will never switch over"
[ "$(printf '%s' "$PEER_INFO" | cut -f1)" = 1 ] \
  || say "alans-watchdog-vps: WARNING — $PEER is offline right now; the watchdog will apply routing when it returns"

EXTRA=""
[ "$ALLOW_LAN" = 1 ] && EXTRA="$EXTRA --allow-lan"
[ "$INTERVAL" != 15 ] && EXTRA="$EXTRA --interval $INTERVAL"

cat > "$UNIT_PATH" <<EOF
[Unit]
Description=Hermes Alans way exit-node watchdog (route egress via the user's computer while connected)
Wants=network-online.target tailscaled.service
After=network-online.target tailscaled.service

[Service]
Type=simple
ExecStart=/bin/sh $WATCHDOG --exit-node $PEER$EXTRA
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
chmod 644 "$UNIT_PATH"
say "alans-watchdog-vps: wrote $UNIT_PATH (repo path is baked in — re-run after moving the checkout)"

if [ "$NO_START" = 1 ]; then
  systemctl daemon-reload
  say "alans-watchdog-vps: --no-start given; unit not enabled"
else
  systemctl daemon-reload
  systemctl enable --now "$UNIT" >/dev/null 2>&1 || die "systemd refused $UNIT — check: systemctl status $UNIT"
  say "alans-watchdog-vps: $UNIT enabled and started"
fi

say ""
say "Routing rule from now on: while $PEER answers and traffic flows, this VPS"
say "egresses through the user's computer; when it goes quiet, the watchdog clears"
say "the exit node and this VPS returns to its own egress (~${INTERVAL}s x 3 checks)."
say "Watch it with: journalctl -u $UNIT -f    Status with: sh $0 --status"
