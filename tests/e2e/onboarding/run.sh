#!/bin/bash
# Onboarding e2e: a fresh "Orgo-like" server container (supervisord, real
# Hermes, real sshd) and a fresh "user computer" container (Linux, real sshd).
# Runs scripts/connect-server.sh from the computer, then the server doctor
# (desktop/scripts/vm-update.sh --doctor) through the app's Check setup logic,
# asserts all rows green, then repeats the whole thing to prove re-runs are harmless.
#
#   AGENTS_REPO=~/alans-way-agents tests/e2e/onboarding/run.sh [--keep] [--ref origin/release/plugin-0.8.0]
#
# Stubbed (see stubs/): tailscale CLI (the docker net is inside 100.64.0.0/10),
# curl for the two raw.githubusercontent.com URLs (served from local exports),
# uname -m on the computer (arm64 docker VM), the fake app directory, the
# Telegram bot token in the server's .env. Real: sshd both sides, supervisord,
# Hermes, setup.sh, connect scripts, vm-update.sh --doctor, setup-check.cjs.
# E2E_INIT=systemd runs both machines as a normal VPS (systemd, --privileged) instead of Orgo-like supervisord.
# E2E_BARE=1 also leaves out the Telegram bot token: a server before any prep (expected red).
# Needs the image alans-way-orgo-sim:test (build: $AGENTS_REPO/tests/orgo-sim);
# the Chromium layer on top of it is built once. E2E_BARE=1 skips it.
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
AGENTS_REPO="${AGENTS_REPO:-$HOME/alans-way-agents}"
REF="origin/release/plugin-0.8.0" KEEP=0
BASE_IMAGE="${E2E_BASE_IMAGE:-alans-way-orgo-sim:test}" IMAGE="aw-e2e-chrome:$(shasum "$HERE/Dockerfile.chrome" | cut -c1-8)"
BARE="${E2E_BARE:-0}"   # 1: base image only, a server with no Chromium or X display
while [ $# -gt 0 ]; do case "$1" in --keep) KEEP=1; shift;; --ref) REF="$2"; shift 2;; *) echo "unknown arg $1" >&2; exit 2;; esac; done

ID="e2e$$"; NET="aw-$ID"; S="aw-server-$ID"; C="aw-computer-$ID"
WORK="$(mktemp -d "$HOME/.aw-e2e.XXXXXX")"   # under $HOME: colima shares only /Users
FAILS=0
step() { printf '\n== %s\n' "$*"; }
ok() { printf 'PASS %s\n' "$*"; }
bad() { printf 'FAIL %s\n' "$*"; FAILS=$((FAILS+1)); }
cleanup() {
  if [ "$KEEP" = 1 ]; then echo "kept: docker rm -f $S $C; docker network rm $NET; rm -rf $WORK"; return; fi
  docker rm -f "$S" "$C" >/dev/null 2>&1 || true; docker network rm "$NET" >/dev/null 2>&1 || true; rm -rf "$WORK"
}
trap cleanup EXIT
sx() { docker exec -i "$S" "$@"; }
cx() { docker exec -i "$C" "$@"; }

docker image inspect "$BASE_IMAGE" >/dev/null 2>&1 || { echo "missing image $BASE_IMAGE: docker build -t $BASE_IMAGE $AGENTS_REPO/tests/orgo-sim" >&2; exit 2; }
[ "$BARE" = 0 ] || IMAGE="$BASE_IMAGE"
docker image inspect "$IMAGE" >/dev/null 2>&1 || docker build -q -t "$IMAGE" --build-arg "BASE=$BASE_IMAGE" -f "$HERE/Dockerfile.chrome" "$HERE" >/dev/null 2>&1 || { echo "image build failed" >&2; exit 2; }
RUN_OPTS=""; READY='supervisorctl pid'
if [ "${E2E_INIT:-supervisord}" = systemd ]; then
  CHROME_IMAGE="$IMAGE"; IMAGE="aw-e2e-systemd:$(shasum "$HERE/Dockerfile.systemd" | cut -c1-8)"
  docker image inspect "$IMAGE" >/dev/null 2>&1 || docker build -q -t "$IMAGE" --build-arg "BASE=$CHROME_IMAGE" -f "$HERE/Dockerfile.systemd" "$HERE" >/dev/null
  RUN_OPTS="--privileged --cgroupns=host"; READY='systemctl is-system-running | grep -Eq "running|degraded"'
fi

step "export both repos as fresh git checkouts"
export_repo() { # <dir> <archive-cmd...>
  d="$1"; shift; mkdir -p "$d"; "$@" | tar -x -C "$d"
  git -C "$d" init -q && git -C "$d" add -A && git -C "$d" -c user.email=e2e@x -c user.name=e2e commit -qm export
}
export_repo "$WORK/agents" git -C "$AGENTS_REPO" archive "$REF"
# vm-update --doctor asks the plugin remote (github) for release tags; the git
# insteadOf below points that at this export, so it carries the plugin's own version as a tag.
PV="$(sed -n 's/^version:[[:space:]]*"\{0,1\}\([0-9.]*\).*/\1/p' "$WORK/agents/alans-way/plugin.yaml" | head -1)"
git -C "$WORK/agents" tag "v$PV"
printf '[{"name":"v%s"},{"name":"v0.0.1"}]\n' "$PV" > "$WORK/agents-tags.json"
export_repo "$WORK/desktop" git -C "$REPO" archive HEAD
echo "plugin $REF ($(git -C "$AGENTS_REPO" rev-parse --short "$REF")), app $(git -C "$REPO" rev-parse --short HEAD)"

step "network + containers"
SUBNET="100.64.$((RANDOM % 200 + 20)).0/24"
docker network create --subnet "$SUBNET" "$NET" >/dev/null
for n in "$S" "$C"; do
  extra=""; [ "$n" != "$C" ] || extra="-v $HERE/stubs/uname:/usr/local/bin/uname:ro"
  # shellcheck disable=SC2086
  docker run -d $RUN_OPTS --name "$n" --network "$NET" \
    -v "$WORK/agents:/srv/agents:ro" -v "$WORK/agents-tags.json:/srv/agents-tags.json:ro" -v "$WORK/desktop:/srv/alans-way:ro" \
    -v "$HERE/stubs/tailscale:/usr/local/bin/tailscale:ro" -v "$HERE/stubs/curl:/usr/local/bin/curl:ro" $extra \
    "$IMAGE" >/dev/null
  for _ in $(seq 90); do docker exec "$n" sh -c "$READY" >/dev/null 2>&1 && break; sleep 1; done
  docker exec "$n" git config --global safe.directory '*'
  docker exec "$n" git config --global url./srv/agents.insteadOf https://github.com/capthvnsen/alans-way-agents
  docker exec "$n" git config --global url./srv/alans-way.insteadOf https://github.com/capthvnsen/alans-way
done
SIP="$(docker inspect -f "{{(index .NetworkSettings.Networks \"$NET\").IPAddress}}" "$S")"
CIP="$(docker inspect -f "{{(index .NetworkSettings.Networks \"$NET\").IPAddress}}" "$C")"
echo "server $SIP  computer $CIP"

step "user's starting state (what a real user already has before running anything)"
# Their usual SSH login to the server; the Telegram bot the server already runs.
cx sh -c "mkdir -p ~/.ssh && ssh-keygen -q -t ed25519 -N '' -f ~/.ssh/id_ed25519 -C user@laptop && mkdir -p ~/.local/share/alans-way-localapp"
cx cat /root/.ssh/id_ed25519.pub | sx sh -c 'mkdir -p ~/.ssh; cat >> ~/.ssh/authorized_keys; chmod 600 ~/.ssh/authorized_keys'
cx sh -c "ssh-keyscan -T 5 $SIP >> ~/.ssh/known_hosts 2>/dev/null"
[ "$BARE" = 1 ] || sx sh -c 'mkdir -p ~/.hermes && grep -q ^TELEGRAM_BOT_TOKEN= ~/.hermes/.env 2>/dev/null || echo "TELEGRAM_BOT_TOKEN=123456789:AAEe2eStubStubStubStubStubStubStubStub" >> ~/.hermes/.env'

snapshot() { # state that must not change on a re-run
  {
    echo "--- computer authorized_keys"; cx sh -c 'cut -c1-60 ~/.ssh/authorized_keys | sort'
    echo "--- computer known_hosts"; cx sh -c 'cut -d" " -f1,2 ~/.ssh/known_hosts | sort'
    echo "--- server authorized_keys"; sx sh -c 'cut -c1-60 ~/.ssh/authorized_keys | sort'
    echo "--- server known_hosts"; sx sh -c 'cut -d" " -f1,2 ~/.ssh/known_hosts 2>/dev/null | sort'
    echo "--- server service definitions"; sx sh -c 'cat /etc/supervisor/conf.d/*.conf /etc/systemd/system/*alans-way*.service /etc/systemd/system/mac-watch.service 2>/dev/null | md5sum; ls /etc/supervisor/conf.d /etc/systemd/system 2>/dev/null | grep -i -e alans -e mac-watch'
    echo "--- server hermes config"; sx sh -c 'md5sum ~/.hermes/config.yaml; ls ~/.hermes/plugins'
    echo "--- ssh config blocks"; cx sh -c 'md5sum ~/.ssh/config 2>&1 || true'; sx sh -c 'md5sum ~/.ssh/config 2>&1 || true'
    echo "--- server .env keys"; sx sh -c 'cut -d= -f1 ~/.hermes/.env | sort'
  } 2>&1
}

doctor() { # prints rows; returns 1 on any warn/fail
  cx sh -c "ssh -o BatchMode=yes root@$SIP 'sh -s -- --doctor' < /srv/alans-way/desktop/scripts/vm-update.sh" > "$WORK/doctor.out" 2>"$WORK/doctor.err" || true
  tail -1 "$WORK/doctor.out" | cut -c1-600
  VER="$(node -p "require('$REPO/desktop/package.json').version")"
  tail -1 "$WORK/doctor.out" | node "$HERE/check-doctor.cjs" "$REPO/desktop/src/setup-check.cjs" "$VER"
}

run_pass() { # <n>
  step "pass $1: connect-server.sh from the computer"
  if cx sh /srv/alans-way/scripts/connect-server.sh --server "root@$SIP" -- --non-interactive </dev/null > "$WORK/connect.$1.log" 2>&1; then ok "connect-server.sh exit 0"; else bad "connect-server.sh exit $?"; fi
  tail -25 "$WORK/connect.$1.log"
  step "pass $1: server doctor through Check setup"
  if doctor; then ok "doctor all green"; else bad "doctor has warn/fail rows"; fi
  snapshot > "$WORK/snap.$1"
}

run_pass 1
run_pass 2
step "idempotency: state after pass 2 equals state after pass 1"
if diff -u "$WORK/snap.1" "$WORK/snap.2"; then ok "no state drift"; else bad "state changed on re-run"; fi
[ "$KEEP" = 0 ] || cp "$WORK"/connect.*.log "$WORK"/doctor.* /tmp/ 2>/dev/null || true
step "result"; [ "$FAILS" = 0 ] && echo "ALL PASS" || { echo "$FAILS failure(s)"; exit 1; }
