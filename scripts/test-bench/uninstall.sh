#!/bin/sh
# Remove the test bench: stop and disable its units, delete its files; with --remove-user, delete the bench account too.
#   scripts/test-bench/uninstall.sh [--remove-user] [--user <name>] [--apply]
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=common.sh
. "$HERE/common.sh"
REMOVE_USER=0
while [ $# -gt 0 ]; do
  case $1 in --apply) ;; --remove-user) REMOVE_USER=1 ;; --user) BENCH_USER=${2:?}; shift ;; *) die "unknown option $1" ;; esac
  shift
done
parse_apply "$@"; need_not_root; check_bench_user
bench_exists || { say "no bench user $BENCH_USER: nothing to remove"; exit 0; }
require_bench_marker
home=$(bench_home)
warm_sudo
stop_bench
run_ctl disable "$UNIT_GATEWAY" "$UNIT_SERVE"
if [ "$APPLY" = 1 ]; then
  say "+ delete the bench's files under $home (as $BENCH_USER)"
  as_bench sh -s -- "$home" <<'REMOVE'
set -eu
h=$1
[ -f "$h/.hermes-test-bench" ] || { echo "refused: no bench marker" >&2; exit 2; }
rm -rf -- "$h/bench-home" "$h/bench-state" "$h/bench-logs" "$h/bench-bin" "$h/bench-credentials.json" \
  "$h/.config/systemd/user/hermes-bench-gateway.service" "$h/.config/systemd/user/hermes-bench-serve.service"
REMOVE
  as_ctl daemon-reload || true
else
  say "DRY-RUN: delete bench-home, bench-state, bench-logs, bench-bin, bench-credentials.json and the two unit files under $home (as $BENCH_USER)"
fi
if [ "$REMOVE_USER" = 1 ]; then
  run sudo loginctl disable-linger "$BENCH_USER"
  run sudo loginctl terminate-user "$BENCH_USER"
  run sudo userdel --remove "$BENCH_USER"
else
  say "the account $BENCH_USER is kept (pass --remove-user to delete it)"
fi
