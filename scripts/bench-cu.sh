#!/bin/sh
# bench-cu.sh — the computer-use benchmark in one command. Runs each arm of
# desktop/eval/run.cjs over a fixed task suite, then writes results.json and
# results.md with desktop/eval/report.cjs. Method and published numbers:
# docs/benchmarks/computer-use.md.
#
#   sh scripts/bench-cu.sh                                   # oracle + null arms, fixture tasks, 3 repeats, no network, no model
#   BENCH_TASKS=fixture,public sh scripts/bench-cu.sh        # add the 8 public-site tasks (needs network)
#   BENCH_ARMS=hermes sh scripts/bench-cu.sh --model M --provider P --plugin-dir DIR
#   BENCH_ARMS=codex sh scripts/bench-cu.sh                  # Codex baseline (`codex exec` per task)
#   sh scripts/bench-cu.sh --connection /path/connection.json  # drive another host, e.g. the Mac app from a VPS over Tailscale
#
# Extra arguments go to every arm's run.cjs (see its header). BENCH_ARMS is a
# space-separated list of run.cjs modes (oracle null hermes codex manual).
# BENCH_TASKS takes task ids or tiers (fixture, public, desktop). BENCH_REPEAT
# defaults to 3. BENCH_OUT defaults to $TMPDIR/alans-way-bench/<UTC time>; each
# arm lands in its own subdirectory. To compare runs made separately (say a
# VPS run and a Codex run on the Mac), copy their arm directories side by side
# and run: node desktop/eval/report.cjs --out DIR ARM_DIR ARM_DIR...
# Arguments you pass win over the defaults above (run.cjs reads the first
# occurrence). They are read from desktop/, so give paths in them as absolute.
# Give each arm its own --label: arms sharing a label merge in the report.
set -eu
ARMS=${BENCH_ARMS:-oracle null}
TASKS=${BENCH_TASKS:-fixture}
REPEAT=${BENCH_REPEAT:-3}
OUT=${BENCH_OUT:-${TMPDIR:-/tmp}/alans-way-bench/$(date -u +%Y%m%dT%H%M%SZ)}
case $OUT in /*) ;; *) OUT=$PWD/$OUT ;; esac
cd "$(dirname "$0")/../desktop"
[ -d node_modules ] || npm ci --ignore-scripts
dirs=
for arm in $ARMS; do
  node eval/run.cjs "$@" --mode "$arm" --tasks "$TASKS" --repeat "$REPEAT" --out "$OUT/$arm"
  dirs="$dirs $OUT/$arm"
done
# shellcheck disable=SC2086 # dirs is a word list of paths without spaces in the default layout
node eval/report.cjs --out "$OUT" $dirs
