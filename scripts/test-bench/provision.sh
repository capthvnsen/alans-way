#!/bin/sh
# Provision the test bench: a throwaway Hermes under its own Unix user on this VM. See docs/test-bench.md.
#
#   scripts/test-bench/provision.sh --hermes-bin <path> --prod-home <dir> --provider-key-file <file> [--model <slug>] [--bind-ip <tailnet ip>] [--user <name>] [--apply]
#   scripts/test-bench/provision.sh --hermes-bin <path> --no-prod-check ...            (skip the production-readability check; discouraged)
#
# Run it as your normal user (never root). It is a dry run unless --apply is given. It never prints a secret, never
# touches the production user, its files, its service or its ports, and never uses tailscale serve/funnel.
# shellcheck disable=SC2016  # the single-quoted blocks are scripts for the bench user's shell, on purpose
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=common.sh
. "$HERE/common.sh"

HERMES_BIN=; PROD_HOME=; NO_PROD_CHECK=0; PROVIDER_KEY_FILE=; MODEL=anthropic/claude-haiku-5-5; BIND_IP=
while [ $# -gt 0 ]; do
  case $1 in
    --apply) ;;
    --hermes-bin) HERMES_BIN=${2:?}; shift ;;
    --prod-home) PROD_HOME=${2:?}; shift ;;
    --no-prod-check) NO_PROD_CHECK=1 ;;
    --provider-key-file) PROVIDER_KEY_FILE=${2:?}; shift ;;
    --model) MODEL=${2:?}; shift ;;
    --bind-ip) BIND_IP=${2:?}; shift ;;
    --user) BENCH_USER=${2:?}; shift ;;
    *) die "unknown option $1" ;;
  esac
  shift
done
parse_apply "$@"
need_not_root
check_bench_user

# ── refusals that need no sudo ──────────────────────────────────────────────
case $HERMES_BIN in /*) ;; *) die "--hermes-bin must be an absolute path to the hermes executable the bench may run." ;; esac
case $HERMES_BIN in *[!A-Za-z0-9_./+-]*) die "--hermes-bin may only hold letters, digits and _ . / + -" ;; esac
case $MODEL in *[!A-Za-z0-9_./:@-]*|'') die "--model holds a character a model id never has." ;; esac
if [ -z "$PROD_HOME" ] && [ "$NO_PROD_CHECK" = 0 ]; then die "say where production lives (--prod-home <dir>) so the bench user can be proven unable to read it, or pass --no-prod-check."; fi
if [ -n "$PROD_HOME" ]; then case $PROD_HOME in /*) ;; *) die "--prod-home must be absolute." ;; esac; fi
if [ -z "$BIND_IP" ]; then BIND_IP=$(tailscale ip -4 2>/dev/null | head -n 1 || true); fi
[ -n "$BIND_IP" ] || die "no tailnet address: tailscale is not answering. Pass --bind-ip <100.x.y.z>."
printf '%s\n' "$BIND_IP" | awk -F. 'NF==4 && $1==100 && $2>=64 && $2<=127 && $3>=0 && $3<=255 && $4>=0 && $4<=255 {ok=1} END{exit !ok}' \
  || die "--bind-ip must be a tailnet address (the 100.64/10 range); the bench is never bound to anything else."
if [ -n "$PROVIDER_KEY_FILE" ]; then
  [ -f "$PROVIDER_KEY_FILE" ] && [ ! -L "$PROVIDER_KEY_FILE" ] || die "--provider-key-file must be a plain file."
  find "$PROVIDER_KEY_FILE" -maxdepth 0 -perm 600 -user "$(id -un)" | grep -q . || die "--provider-key-file must be mode 0600 and yours."
fi
if port_busy "$API_PORT" || port_busy "$SERVE_PORT"; then
  if ! (bench_exists && unit_active "$UNIT_GATEWAY" 2>/dev/null); then die "port $API_PORT or $SERVE_PORT is already in use by something that is not the running bench. Nothing was changed."; fi
fi

say "plan:"
say "  bench user      $BENCH_USER (own group, no sudo, no other groups)"
say "  hermes          $HERMES_BIN"
say "  model           $MODEL via OpenRouter, tools: clarify only, no messaging platforms"
say "  API server      127.0.0.1:$API_PORT   (loopback; the Mac reaches it through an SSH tunnel)"
say "  hermes serve    $BIND_IP:$SERVE_PORT   (tailnet only, password sign-in)"
say "  units           $UNIT_GATEWAY, $UNIT_SERVE   (user units of $BENCH_USER)"
say ""
warm_sudo

# ── the dedicated user ──────────────────────────────────────────────────────
if bench_exists; then
  say "user $BENCH_USER already exists: checking it is the bench"
  if [ "$APPLY" = 1 ] || sudo -n true 2>/dev/null; then require_bench_marker; else say "(dry run: cannot look inside the account without sudo)"; fi
else
  run sudo useradd --create-home --shell /usr/sbin/nologin --comment "Alan's Way test bench" "$BENCH_USER"
fi
if [ "$APPLY" = 1 ]; then
  home=$(bench_home)
  [ "$(id -nG "$BENCH_USER" | tr ' ' '\n' | grep -c .)" = 1 ] || die "$BENCH_USER belongs to more than its own group ($(id -nG "$BENCH_USER")): a bench account must not share a group with anything."
  run sudo chmod 700 "$home"
  run sudo loginctl enable-linger "$BENCH_USER"
  [ -d "/run/user/$(bench_uid)" ] || { sleep 2; [ -d "/run/user/$(bench_uid)" ] || die "the user manager for $BENCH_USER did not start (is systemd-logind running?)."; }
  as_bench test -x "$HERMES_BIN" || die "$BENCH_USER cannot run $HERMES_BIN. Install Hermes for the bench user (or point at a copy it can read) and try again."
  if [ -n "$PROD_HOME" ] && as_bench sh -c 'ls "$1" >/dev/null 2>&1 || test -r "$1/.hermes"' sh "$PROD_HOME"; then
    die "$BENCH_USER can read $PROD_HOME. Tighten production's permissions yourself (for example chmod 700 on that home), then run this again. Nothing of production was touched."
  fi
  as_bench test -f "$home/.hermes-test-bench" || as_bench sh -c 'umask 077; printf "%s\n" "$1" > "$HOME/.hermes-test-bench"' sh "$MARKER_TEXT"
else
  say "DRY-RUN: sudo chmod 700 <home of $BENCH_USER>; sudo loginctl enable-linger $BENCH_USER"
  say "DRY-RUN: refuse if $BENCH_USER is in any group besides its own, cannot run $HERMES_BIN, or can read ${PROD_HOME:-<production check skipped>}"
  say "DRY-RUN: write the marker <home>/.hermes-test-bench"
fi

# ── files and secrets, all written by the bench user, never printed ─────────
SETUP='
set -eu
umask 077
H=$HOME
BH=$H/bench-home
for d in "$BH" "$H/bench-state" "$H/bench-state/locks" "$H/bench-logs" "$H/bench-bin" "$H/.config" "$H/.config/systemd" "$H/.config/systemd/user"; do mkdir -p "$d"; chmod 700 "$d"; done
for f in "$BH/.env" "$H/bench-credentials.json" "$H/.config/systemd/user/hermes-bench-gateway.service" "$H/.config/systemd/user/hermes-bench-serve.service"; do
  if [ -e "$f" ] && ! head -c 4096 "$f" | grep -q "alans-way-test-bench"; then echo "refused: $f exists and is not the bench'"'"'s" >&2; exit 2; fi
done
if [ -f "$BH/.env" ] && grep -Eq "^(TELEGRAM|DISCORD|SLACK|WHATSAPP|MATRIX|MATTERMOST|SIGNAL|SMS|BLUEBUBBLES|FEISHU|WECOM|LINE|TEAMS|MSGRAPH)[A-Z_]*=" "$BH/.env"; then echo "refused: the bench .env names a messaging platform" >&2; exit 2; fi
if [ -f "$BH/.env" ]; then HAVE_ENV=1; else HAVE_ENV=0; fi
if [ -f "$H/bench-credentials.json" ]; then HAVE_CREDS=1; else HAVE_CREDS=0; fi
if [ "$HAVE_ENV" != "$HAVE_CREDS" ]; then echo "refused: .env and bench-credentials.json disagree; run uninstall.sh first" >&2; exit 2; fi
IFS= read -r PROVIDER_KEY || true   # a last line without a newline still fills the variable
if [ ! -f "$BH/.env" ]; then
  [ -n "$PROVIDER_KEY" ] || { echo "refused: no provider key (pass --provider-key-file)" >&2; exit 2; }
  API_KEY=$(openssl rand -hex 32); PASS=$(openssl rand -hex 24); SECRET=$(openssl rand -hex 32)
  {
    echo "# alans-way-test-bench: secrets for the bench Hermes only"
    printf "API_SERVER_KEY=%s\nHERMES_DASHBOARD_BASIC_AUTH_USERNAME=bench\nHERMES_DASHBOARD_BASIC_AUTH_PASSWORD=%s\nHERMES_DASHBOARD_BASIC_AUTH_SECRET=%s\nOPENROUTER_API_KEY=%s\n" "$API_KEY" "$PASS" "$SECRET" "$PROVIDER_KEY"
  } > "$BH/.env"
  printf "{\"marker\":\"alans-way-test-bench\",\"gateway_url\":\"http://%s:%s\",\"api_url\":\"http://127.0.0.1:%s\",\"username\":\"bench\",\"password\":\"%s\",\"api_key\":\"%s\"}\n" "$BIND_IP" "$SERVE_PORT" "$API_PORT" "$PASS" "$API_KEY" > "$H/bench-credentials.json"
elif [ -n "$PROVIDER_KEY" ]; then
  { grep -v "^OPENROUTER_API_KEY=" "$BH/.env" || true; printf "OPENROUTER_API_KEY=%s\n" "$PROVIDER_KEY"; } > "$BH/.env.new"
  mv "$BH/.env.new" "$BH/.env"
fi
chmod 600 "$BH/.env" "$H/bench-credentials.json"

cat > "$BH/config.yaml" <<YAML
# alans-way-test-bench: no secrets here. Written by provision.sh; edit and re-run it, do not hand-edit.
model:
  default: $MODEL
  provider: openrouter
platform_toolsets:
  api_server: [clarify]
  cli: [clarify]
agent:
  max_turns: 4
  run_budget_seconds: 120
memory:
  memory_enabled: false
  user_profile_enabled: false
gateway:
  api_server:
    enabled: true
    host: 127.0.0.1
    port: $API_PORT
    model_name: $MODEL_NAME
    max_concurrent_runs: 2
dashboard:
  basic_auth:
    username: bench
YAML

for name in gateway serve; do
  if [ "$name" = gateway ]; then cmd="gateway run --external-supervisor"; else cmd="serve --isolated --host $BIND_IP --port $SERVE_PORT"; fi
  cat > "$H/bench-bin/run-$name.sh" <<LAUNCH
#!/bin/sh
# alans-way-test-bench
set -eu
umask 077
cd "$H/bench-state"
echo \$\$ > "$H/bench-state/$name.pid"
unset HERMES_DESKTOP HERMES_DESKTOP_TERMINAL HERMES_PROFILE
export HERMES_HOME="$BH" HERMES_GATEWAY_LOCK_DIR="$H/bench-state/locks" XDG_STATE_HOME="$H/bench-state" HERMES_TUI_TOOLSETS=clarify
exec "$HERMES_BIN" $cmd
LAUNCH
  chmod 700 "$H/bench-bin/run-$name.sh"
  cat > "$H/.config/systemd/user/hermes-bench-$name.service" <<UNIT
# alans-way-test-bench
[Unit]
Description=Alan'"'"'s Way test bench Hermes ($name)
[Service]
Type=simple
ExecStart=%h/bench-bin/run-$name.sh
Restart=on-failure
RestartSec=5
RestartPreventExitStatus=78
NoNewPrivileges=yes
PrivateTmp=yes
MemoryMax=1500M
TasksMax=300
StandardOutput=append:%h/bench-logs/$name.log
StandardError=append:%h/bench-logs/$name.log
[Install]
WantedBy=default.target
UNIT
done
'
if [ "$APPLY" = 1 ]; then
  say "+ write config, secrets (not shown), launchers and unit files as $BENCH_USER"
  if [ -n "$PROVIDER_KEY_FILE" ]; then key_in=$PROVIDER_KEY_FILE; else key_in=/dev/null; fi
  as_bench env "BIND_IP=$BIND_IP" "MODEL=$MODEL" "API_PORT=$API_PORT" "SERVE_PORT=$SERVE_PORT" "MODEL_NAME=$MODEL_NAME" "HERMES_BIN=$HERMES_BIN" sh -c "$SETUP" < "$key_in"
  run_ctl daemon-reload
  run_ctl enable --now "$UNIT_GATEWAY" "$UNIT_SERVE"
  say "waiting for the units"
  i=0; while [ "$i" -lt 30 ]; do if port_busy "$API_PORT" && port_busy "$SERVE_PORT"; then break; fi; sleep 1; i=$((i + 1)); done
else
  say "DRY-RUN: as $BENCH_USER, create ~/bench-home (0700) with .env (0600: API_SERVER_KEY, dashboard password and signing secret generated here with openssl, provider key copied from $PROVIDER_KEY_FILE; none shown) and config.yaml"
  say "DRY-RUN: as $BENCH_USER, write ~/bench-credentials.json (0600) for fetch.sh, ~/bench-bin/run-gateway.sh and run-serve.sh, and the two user unit files"
  say "DRY-RUN: refuse to overwrite any of those that does not carry the bench marker, or an .env that names a messaging platform"
  say "DRY-RUN: systemctl --user daemon-reload; systemctl --user enable --now $UNIT_GATEWAY $UNIT_SERVE (as $BENCH_USER)"
fi

say ""
say "done. facts (no secrets):"
say "  user            $BENCH_USER"
say "  units           $UNIT_GATEWAY $UNIT_SERVE   (systemctl --user, as $BENCH_USER)"
say "  API server      127.0.0.1:$API_PORT"
say "  hermes serve    $BIND_IP:$SERVE_PORT"
say "  hermes home     <home of $BENCH_USER>/bench-home"
say "  logs            <home of $BENCH_USER>/bench-logs/"
say "  credentials     <home of $BENCH_USER>/bench-credentials.json (0600; copy it with fetch.sh)"
say "next: scripts/test-bench/status.sh"
