# Shared by the test bench scripts (docs/test-bench.md). Sourced, never run. POSIX sh.
# shellcheck disable=SC2034  # the ports and names are read by the scripts that source this file
# Everything here names the bench's own user, directories, ports and units. Nothing selects a process by name.

BENCH_USER=${BENCH_USER:-hermes-bench}
API_PORT=28642      # the bench's Hermes API server: loopback only, reached from the Mac through an SSH tunnel
SERVE_PORT=29119    # the bench's `hermes serve` (WebSocket gateway + sign-in): the tailnet address only
UNIT_GATEWAY=hermes-bench-gateway.service
UNIT_SERVE=hermes-bench-serve.service
MARKER_TEXT="alans-way-test-bench v1"
MODEL_NAME=alans-way-test-bench   # what the bench API server calls itself on /v1/models; the runner insists on it
APPLY=0

say() { printf '%s\n' "$*"; }
die() { printf 'refused: %s\n' "$*" >&2; exit 2; }

# A dry run prints each action; --apply prints it and does it. Arguments only: a secret never goes through here.
run() {
  if [ "$APPLY" = 1 ]; then say "+ $*"; "$@"; else say "DRY-RUN: $*"; fi
}

need_not_root() { [ "$(id -u)" -ne 0 ] || die "do not run this as root. Run it as your normal user; it calls sudo itself, only for the steps it names."; }

# hermes-bench, or hermes-bench-<something>. Never root, never an existing human or production account by accident.
check_bench_user() {
  case "$BENCH_USER" in
    hermes-bench|hermes-bench-[a-z0-9]*) ;;
    *) die "the bench user must be named hermes-bench or hermes-bench-<suffix> (got '$BENCH_USER')." ;;
  esac
  case "$BENCH_USER" in *[!a-z0-9-]*) die "the bench user name may only hold a-z, 0-9 and '-'." ;; esac
}

bench_exists() { id -u "$BENCH_USER" >/dev/null 2>&1; }
bench_uid() { id -u "$BENCH_USER"; }
bench_home() {
  h=$(getent passwd "$BENCH_USER" 2>/dev/null | cut -d: -f6 || true)
  [ -n "$h" ] || h=/home/$BENCH_USER
  printf '%s\n' "$h"
}

# Run something as the bench user. The bench user is an ordinary unprivileged account: whatever runs here cannot signal,
# read or write the production user's processes or files.
as_bench() { sudo -n -u "$BENCH_USER" -H "$@"; }
as_ctl() {
  uid=$(bench_uid)
  sudo -n -u "$BENCH_USER" -H env "XDG_RUNTIME_DIR=/run/user/$uid" "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$uid/bus" systemctl --user "$@"
}

# 0 = the bench marker is there, 1 = it is not, 2 = could not look (no sudo yet, or no such user).
marker_state() {
  bench_exists || return 2
  home=$(bench_home)
  sudo -n -u "$BENCH_USER" true 2>/dev/null || return 2
  if as_bench grep -qx "$MARKER_TEXT" "$home/.hermes-test-bench" 2>/dev/null; then return 0; fi
  return 1
}

require_bench_marker() {
  marker_state && return 0
  case $? in
    1) die "user '$BENCH_USER' exists but is not a test bench account (no $MARKER_TEXT marker in its home). Not touching it." ;;
    *) die "cannot look inside '$BENCH_USER' (no passwordless sudo to it). Run 'sudo -v' first." ;;
  esac
}

# A port is fine when nothing listens on it, or when the bench's own units are the ones running.
port_busy() { ss -ltnH "sport = :$1" 2>/dev/null | grep -q .; }

unit_active() { as_ctl is-active --quiet "$1" 2>/dev/null; }

# Stop the bench units by name, then make sure the processes they started are gone. If one is not, it is ended only
# after proving it is the bench's: its HERMES_HOME and working directory are the bench's. See docs/test-bench.md.
stop_bench() {
  home=$(bench_home)
  run_ctl_stop "$UNIT_SERVE"
  run_ctl_stop "$UNIT_GATEWAY"
  for name in serve gateway; do
    if [ "$APPLY" = 1 ]; then
      as_bench sh -s -- "$home/bench-state/$name.pid" "$home/bench-home" "$home/bench-state" <<'KILL'
pf=$1; hh=$2; wd=$3
[ -f "$pf" ] || exit 0
pid=$(cat "$pf"); case $pid in ''|*[!0-9]*) exit 0 ;; esac
[ -d "/proc/$pid" ] || { rm -f "$pf"; exit 0; }
proved() { tr '\0' '\n' < "/proc/$pid/environ" 2>/dev/null | grep -qx "HERMES_HOME=$hh" && [ "$(readlink "/proc/$pid/cwd" 2>/dev/null)" = "$wd" ]; }
proved || { echo "pid $pid in $pf is not the bench's own process: leaving it alone" >&2; exit 3; }
kill -TERM "$pid"
i=0; while [ -d "/proc/$pid" ] && [ "$i" -lt 30 ]; do sleep 0.5; i=$((i + 1)); done
if [ -d "/proc/$pid" ]; then proved && kill -KILL "$pid"; fi
rm -f "$pf"
KILL
    else
      say "DRY-RUN: as $BENCH_USER: end pid in $home/bench-state/$name.pid only if its HERMES_HOME is $home/bench-home and its cwd is $home/bench-state"
    fi
  done
}
run_ctl() {
  if [ "$APPLY" = 1 ]; then say "+ systemctl --user $* (as $BENCH_USER)"; as_ctl "$@"; else say "DRY-RUN: systemctl --user $* (as $BENCH_USER)"; fi
}
run_ctl_stop() {
  if [ "$APPLY" = 1 ]; then say "+ systemctl --user stop $1 (as $BENCH_USER)"; as_ctl stop "$1" || true
  else say "DRY-RUN: systemctl --user stop $1 (as $BENCH_USER)"; fi
}

parse_apply() {
  for a in "$@"; do if [ "$a" = "--apply" ]; then APPLY=1; fi; done
  if [ "$APPLY" = 1 ]; then say "mode: APPLY"; else say "mode: dry run (nothing is changed; pass --apply to do it)"; fi
}

# After a dry run's header and before an apply: one sudo password prompt now, with the human watching.
warm_sudo() { if [ "$APPLY" = 1 ]; then sudo -v; fi; }
