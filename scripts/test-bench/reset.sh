#!/bin/sh
# Reset the test bench to clean: stop it, delete everything it has stored (conversations, memory, logs, state), keep its
# config, its secrets and its credentials file, and optionally start it again.
#   scripts/test-bench/reset.sh [--start] [--user <name>] [--apply]
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=common.sh
. "$HERE/common.sh"
START=0
while [ $# -gt 0 ]; do
  case $1 in --apply) ;; --start) START=1 ;; --user) BENCH_USER=${2:?}; shift ;; *) die "unknown option $1" ;; esac
  shift
done
parse_apply "$@"; need_not_root; check_bench_user
bench_exists || die "no bench user $BENCH_USER"
require_bench_marker
home=$(bench_home)
warm_sudo
stop_bench
if [ "$APPLY" = 1 ]; then
  say "+ delete everything in $home/bench-home except .env, config.yaml and the marker; empty bench-logs and bench-state (as $BENCH_USER)"
  as_bench sh -s -- "$home" <<'WIPE'
set -eu
h=$1
bh=$h/bench-home
[ -f "$h/.hermes-test-bench" ] || { echo "refused: no bench marker" >&2; exit 2; }
[ "$(cd "$bh" && pwd -P)" = "$bh" ] || { echo "refused: $bh is not where it should be" >&2; exit 2; }
find "$bh" -mindepth 1 -maxdepth 1 ! -name .env ! -name config.yaml -exec rm -rf -- {} +
find "$h/bench-logs" "$h/bench-state" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
mkdir -p "$h/bench-state/locks"; chmod 700 "$h/bench-state/locks"
WIPE
else
  say "DRY-RUN: delete everything in $home/bench-home except .env and config.yaml; empty bench-logs and bench-state (as $BENCH_USER, after checking the bench marker and that the path is what it should be)"
fi
if [ "$START" = 1 ]; then run_ctl start "$UNIT_GATEWAY" "$UNIT_SERVE"; fi
