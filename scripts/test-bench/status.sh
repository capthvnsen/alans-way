#!/bin/sh
# Read-only facts about the test bench. Prints no secret: the API check reads the key inside the bench user's own shell.
#   scripts/test-bench/status.sh [--user <name>] [--prod-home <dir>]
# shellcheck disable=SC2016  # the single-quoted blocks are scripts for the bench user's shell, on purpose
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=common.sh
. "$HERE/common.sh"
PROD_HOME=
while [ $# -gt 0 ]; do
  case $1 in
    --user) BENCH_USER=${2:?}; shift ;;
    --prod-home) PROD_HOME=${2:?}; shift ;;
    *) die "unknown option $1" ;;
  esac
  shift
done
need_not_root
check_bench_user
bench_exists || { say "bench user $BENCH_USER: does not exist (nothing is provisioned)"; exit 0; }
require_bench_marker
say "bench user      $BENCH_USER (groups: $(id -nG "$BENCH_USER"))"
for u in "$UNIT_GATEWAY" "$UNIT_SERVE"; do
  if unit_active "$u"; then say "unit            $u: active"; else say "unit            $u: not running"; fi
done
for p in "$API_PORT" "$SERVE_PORT"; do
  if port_busy "$p"; then say "port            $p: listening"; else say "port            $p: free"; fi
done
as_bench sh -c 'for f in "$HOME/bench-credentials.json" "$HOME/bench-home/.env"; do printf "file            %s: mode %s\n" "$f" "$(stat -c %a "$f" 2>/dev/null || echo missing)"; done'
if [ -n "$PROD_HOME" ]; then
  if as_bench sh -c 'ls "$1" >/dev/null 2>&1' sh "$PROD_HOME"; then say "PROBLEM         $BENCH_USER can read $PROD_HOME"; else say "production      $PROD_HOME is not readable by $BENCH_USER"; fi
fi
# The bench key is read and used inside the bench user's shell; only the HTTP status and a yes/no come back.
as_bench env "API_PORT=$API_PORT" "MODEL_NAME=$MODEL_NAME" sh -c '
umask 077
key=$(sed -n "s/^API_SERVER_KEY=//p" "$HOME/bench-home/.env" 2>/dev/null || true)
[ -n "$key" ] || { echo "api check       no key on file"; exit 0; }
h=$(mktemp); printf "Authorization: Bearer %s\n" "$key" > "$h"
code=$(curl -s -o "$h.body" -w "%{http_code}" -H @"$h" "http://127.0.0.1:$API_PORT/v1/models" || true)
if [ "$code" = 200 ] && grep -q "\"$MODEL_NAME\"" "$h.body"; then echo "api check       200, names itself $MODEL_NAME"; else echo "api check       HTTP $code (not the bench, or not up)"; fi
rm -f "$h" "$h.body"'
