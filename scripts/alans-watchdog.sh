#!/bin/sh
# alans-watchdog.sh — keep this host's egress pointed at the user's
# computer only while that computer is actually reachable. Runs on the VPS as
# a long-lived service (installed by scripts/alans-watchdog-vps.sh):
#
#   sh scripts/alans-watchdog.sh --exit-node <mac-tailscale-name-or-ip> \
#       [--allow-lan] [--interval 15] [--once]
#
# Each interval it resolves the peer in `tailscale status` and checks the
# peer's Online bit; while the exit node is applied it additionally probes real
# egress (curl/wget to an IP echo). After UP_THRESHOLD consecutive healthy
# checks it applies `tailscale set --exit-node`; after DOWN_THRESHOLD
# consecutive unhealthy checks it clears it, returning the host to direct
# egress. An exit node the watchdog did not set is left alone unless ours
# becomes healthy again. Logs only state changes; the journal collects them.
set -u

PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
UP_THRESHOLD=2
DOWN_THRESHOLD=3

say() { printf '%s\n' "$*"; }
die() { printf 'alans-watchdog: %s\n' "$*" >&2; exit 1; }
log() { printf '%s alans-watchdog: %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"; }

PEER="" ALLOW_LAN=0 INTERVAL=15 ONCE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --exit-node) PEER="${2:-}"; shift 2;;
    --allow-lan) ALLOW_LAN=1; shift;;
    --interval) INTERVAL="${2:-}"; shift 2;;
    --once) ONCE=1; shift;;
    -h|--help) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0;;
    *) die "unknown arg: $1";;
  esac
done

[ -n "$PEER" ] || die "needs --exit-node <name-or-ip> of the computer to route through"
printf '%s' "$PEER" | grep -Eq '^[A-Za-z0-9._:-]+$' || die "bad --exit-node value: $PEER"
case "$INTERVAL" in ''|*[!0-9]*) die "bad --interval (seconds): $INTERVAL";; esac
[ "$INTERVAL" -ge 5 ] && [ "$INTERVAL" -le 600 ] || die "--interval must be 5-600 seconds"

# TAILSCALE_BIN/EGRESS_URL exist for testing the loop against a stub daemon;
# production installs never set them.
TS_BIN="${TAILSCALE_BIN:-tailscale}"
command -v "$TS_BIN" >/dev/null 2>&1 || die "tailscale is not installed on this host"
command -v python3 >/dev/null 2>&1 || die "python3 is required (it is already a Hermes prerequisite)"

# One localAPI call per cycle: emit tab-separated
# "<applied_exit_id>  <our_peer_id>  <applied_is_known_peer>  <our_peer_online>".
status_fields() {
  "$TS_BIN" status --json 2>/dev/null | python3 -c '
import json, sys
want = sys.argv[1].lower().rstrip(".")
try:
    s = json.load(sys.stdin)
except Exception:
    sys.exit(2)
peers = list((s.get("Peer") or {}).values())
pid, online, known = "", "", set()
for p in peers:
    known.add(p.get("ID") or "")
    names = [p.get("DNSName") or "", p.get("HostName") or ""] + list(p.get("TailscaleIPs") or [])
    if any(want == str(n).lower().rstrip(".") for n in names):
        pid = p.get("ID") or ""
        online = "1" if p.get("Online") else "0"
eid = (s.get("ExitNodeStatus") or {}).get("ID") or ""
print("\t".join((eid, pid, "1" if eid in known else "0", online)))
' "$PEER"
}

EGRESS_URL="${EGRESS_URL:-https://checkip.amazonaws.com}"
PROBE=none
if command -v curl >/dev/null 2>&1; then PROBE=curl; elif command -v wget >/dev/null 2>&1; then PROBE=wget; fi
egress_ok() {
  case "$PROBE" in
    curl) curl -fsS -m 8 -o /dev/null "$EGRESS_URL" >/dev/null 2>&1;;
    wget) wget -q -T 8 -O /dev/null "$EGRESS_URL" >/dev/null 2>&1;;
    *) return 0;;
  esac
}
egress_ip() {
  case "$PROBE" in
    curl) curl -fsS -m 8 "$EGRESS_URL" 2>/dev/null;;
    wget) wget -q -T 8 -O - "$EGRESS_URL" 2>/dev/null;;
  esac
}

apply_exit_node() {
  if [ "$ALLOW_LAN" = 1 ]; then
    "$TS_BIN" set --exit-node="$PEER" --exit-node-allow-lan-access=true
  else
    "$TS_BIN" set --exit-node="$PEER" --exit-node-allow-lan-access=false
  fi
}

# After a clear caused by a dead egress path (peer alive but not forwarding),
# wait BAN_CYCLES before trusting reachability alone again — approval lag or a
# broken forwarder would otherwise flap the routing every couple of minutes.
BAN_CYCLES=40

log "watching $PEER (interval ${INTERVAL}s; set after $UP_THRESHOLD healthy checks, clear after $DOWN_THRESHOLD unhealthy)"
[ "$PROBE" = none ] && log "no curl or wget found — egress probe disabled, relying on the peer's Online bit only"
[ "$ALLOW_LAN" = 1 ] && log "--allow-lan: this host keeps reaching its own LAN while routed"

good=0 bad=0 ban=0 status_was_down=0
while :; do
  fields="$(status_fields)"
  if [ $? -ne 0 ] || [ -z "$fields" ]; then
    [ "$status_was_down" = 0 ] && log "tailscale status unavailable — keeping current routing until tailscaled answers"
    status_was_down=1
    [ "$ONCE" = 1 ] && exit 0
    sleep "$INTERVAL"; continue
  fi
  if [ "$status_was_down" = 1 ]; then log "tailscaled is answering again"; fi
  status_was_down=0

  applied_id="$(printf '%s' "$fields" | cut -f1)"
  pid="$(printf '%s' "$fields" | cut -f2)"
  applied_known="$(printf '%s' "$fields" | cut -f3)"
  online="$(printf '%s' "$fields" | cut -f4)"

  ours=0 foreign=0 stale=0
  if [ -n "$applied_id" ]; then
    if [ -n "$pid" ] && [ "$applied_id" = "$pid" ]; then ours=1
    elif [ "$applied_known" = 1 ]; then foreign=1
    else stale=1; fi
  fi

  if [ "$online" = 1 ]; then alive=1; else alive=0; fi

  if [ "$ours" = 1 ]; then
    if [ "$alive" = 1 ] && egress_ok; then
      bad=0
    else
      bad=$((bad + 1))
      if [ "$bad" -ge "$DOWN_THRESHOLD" ]; then
        if "$TS_BIN" set --exit-node= 2>/dev/null; then
          log "cleared the exit node — $PEER unreachable or egress probe failing; direct egress restored"
          # Peer reachable but not forwarding: ban re-applying for a while.
          [ "$alive" = 1 ] && ban=$BAN_CYCLES && log "egress probe failed while the peer still shows Online — pausing retries for $BAN_CYCLES checks"
        else
          log "wanted to clear the exit node but 'tailscale set' failed"
        fi
        bad=0
      fi
    fi
  elif [ "$stale" = 1 ]; then
    bad=$((bad + 1))
    if [ "$bad" -ge "$DOWN_THRESHOLD" ]; then
      "$TS_BIN" set --exit-node= 2>/dev/null \
        && log "cleared a stale exit node (id $applied_id no longer in the tailnet); direct egress restored" \
        || log "wanted to clear a stale exit node but 'tailscale set' failed"
      bad=0
    fi
  elif [ "$alive" = 1 ] && [ "$ban" -gt 0 ]; then
    ban=$((ban - 1))
  elif [ "$alive" = 1 ]; then
    good=$((good + 1)); bad=0
    if [ "$good" -ge "$UP_THRESHOLD" ]; then
      [ "$foreign" = 1 ] && log "taking over --exit-node from another node (id $applied_id) — this watchdog owns the setting"
      if apply_exit_node; then
        ip="$(egress_ip || true)"
        log "exit node set to $PEER${ip:+ — egress now leaves as $ip}"
      else
        log "'tailscale set --exit-node=$PEER' failed — is the node approved as an exit node in the admin console?"
      fi
      good=0
    fi
  else
    # A foreign exit node that still resolves is left running — the watchdog
    # only clears state it set or stale state, never another admin's choice.
    good=0
  fi

  [ "$ONCE" = 1 ] && exit 0
  sleep "$INTERVAL"
done
