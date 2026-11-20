#!/bin/sh
# Start or stop the test bench. Only the bench's own two units are named; nothing is matched by name.
#   scripts/test-bench/control.sh start|stop [--user <name>] [--apply]
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=common.sh
. "$HERE/common.sh"
ACTION=${1:-}; [ $# -gt 0 ] && shift
while [ $# -gt 0 ]; do
  case $1 in --apply) ;; --user) BENCH_USER=${2:?}; shift ;; *) die "unknown option $1" ;; esac
  shift
done
parse_apply "$@"; need_not_root; check_bench_user
bench_exists || die "no bench user $BENCH_USER"
require_bench_marker
warm_sudo
case $ACTION in
  start) run_ctl start "$UNIT_GATEWAY" "$UNIT_SERVE" ;;
  stop) stop_bench ;;
  *) die "usage: control.sh start|stop [--apply]" ;;
esac
