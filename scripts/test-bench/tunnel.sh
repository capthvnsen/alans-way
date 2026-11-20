#!/bin/sh
# Mac side. The bench's API server listens on the VM's loopback only; this is the SSH tunnel to it. One tunnel, tracked
# by its own pid file, started and stopped by that pid only (after checking the pid is this tunnel).
#   scripts/test-bench/tunnel.sh start|stop|status <ssh-target> [--port 28642] [--dest <dir>]
set -eu
ACTION=${1:?usage: tunnel.sh start|stop|status <ssh-target> [--port N] [--dest D]}; TARGET=${2:?ssh target}; shift 2
PORT=28642; DEST=${ALANS_WAY_BENCH_DIR:-$HOME/.alans-way-test-bench}
while [ $# -gt 0 ]; do
  case $1 in --port) PORT=${2:?}; shift ;; --dest) DEST=${2:?}; shift ;; *) echo "unknown option $1" >&2; exit 2 ;; esac
  shift
done
case $PORT in ''|*[!0-9]*) echo "refused: bad port" >&2; exit 2 ;; esac
SPEC=127.0.0.1:$PORT:127.0.0.1:$PORT
PIDFILE=$DEST/tunnel.pid
umask 077; mkdir -p "$DEST"
mine() { # is the pid in the pid file alive AND an ssh with exactly our forward?
  [ -f "$PIDFILE" ] || return 1
  pid=$(cat "$PIDFILE"); case $pid in ''|*[!0-9]*) return 1 ;; esac
  ps -p "$pid" -o command= 2>/dev/null | grep -qF -- "ssh -N -o ExitOnForwardFailure=yes -L $SPEC" || return 1
}
case $ACTION in
  start)
    if mine; then echo "tunnel already up (pid $(cat "$PIDFILE"))"; exit 0; fi
    if nc -z 127.0.0.1 "$PORT" 2>/dev/null; then echo "refused: something already listens on 127.0.0.1:$PORT" >&2; exit 2; fi
    nohup ssh -N -o ExitOnForwardFailure=yes -L "$SPEC" "$TARGET" >/dev/null 2>&1 &
    echo $! > "$PIDFILE"
    sleep 2
    if mine; then echo "tunnel up: 127.0.0.1:$PORT -> the bench API server (pid $(cat "$PIDFILE"))"; else rm -f "$PIDFILE"; echo "the tunnel did not stay up" >&2; exit 1; fi ;;
  stop)
    if mine; then kill "$(cat "$PIDFILE")"; rm -f "$PIDFILE"; echo "tunnel stopped"; else echo "no tunnel of ours is running (nothing was killed)"; rm -f "$PIDFILE"; fi ;;
  status) if mine; then echo "tunnel up (pid $(cat "$PIDFILE"))"; else echo "tunnel down"; fi ;;
  *) echo "usage: tunnel.sh start|stop|status <ssh-target>" >&2; exit 2 ;;
esac
