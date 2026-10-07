#!/bin/sh
# vm-update.sh — bring this machine's Alan's Way browser host checkout to a
# release tag, restart the tab broker and verify it answers with that version.
#
# The desktop app pipes this script over SSH (ssh <host> 'sh -s -- v0.3.2'),
# so nothing is installed on the VM and no file is left behind. It only ever
# touches the checkout setup.sh created, that checkout's node_modules, and the
# browser services named below. Hermes, the alans-way-agents plugin and the
# user's other files are never touched.
#
#   sh vm-update.sh v0.3.2    update to the tag and restart the browser host
#   sh vm-update.sh --check   read-only: print the checkout/live versions
#
# Checkout discovery matches setup.sh: a root install lives at
# /opt/hermes-alans-way/browser, a user install at
# ~/.local/share/hermes-alans-way/app. Services match setup.sh too:
#   Linux   hermes-alans-way-browser.service (system or user unit)
#   macOS   gui/<uid>/com.alans-way.browser  (LaunchAgent)
# Chromium is deliberately not restarted so open tabs and sign-ins survive.
#
# The last stdout line is one JSON result: {"ok":bool,"version":"x.y.z",
# "restarted":bool,"error":"..."}. Everything above it is progress.
set -u

TAG="" CHECK=0
case "${1:-}" in
  --check) CHECK=1;;
  -h|--help) sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; exit 0;;
  *) TAG="${1:-}";;
esac

GIT="${ALANS_WAY_VM_GIT:-git}"
NPM="${ALANS_WAY_VM_NPM:-npm}"
GUEST_OS="${ALANS_WAY_VM_OS:-$(uname -s 2>/dev/null || echo Linux)}"
BUSY_WAIT="${ALANS_WAY_VM_BUSY_WAIT:-60}"
BUSY_POLL="${ALANS_WAY_VM_BUSY_POLL:-5}"
HEALTH_WAIT="${ALANS_WAY_VM_HEALTH_WAIT:-45}"
VERSION="" RESTARTED=false

say() { printf 'vm-update: %s\n' "$*"; }
json_string() { printf '%s' "$1" | tr '\n' ' ' | sed 's/"/\\"/g' | cut -c1-300; }
json() { printf '{"ok":%s,"version":"%s","restarted":%s,"error":"%s"}\n' "$1" "$2" "$3" "$(json_string "$4")"; }
fail() { json false "$VERSION" "$RESTARTED" "$1"; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

find_checkout() {
  if [ -n "${ALANS_WAY_DESKTOP_DIR:-}" ]; then
    [ -f "$ALANS_WAY_DESKTOP_DIR/desktop/package.json" ] && [ -d "$ALANS_WAY_DESKTOP_DIR/.git" ] \
      && printf '%s' "$ALANS_WAY_DESKTOP_DIR" && return 0
    return 1
  fi
  for d in /opt/hermes-alans-way/browser "$HOME/.local/share/hermes-alans-way/app"; do
    [ -f "$d/desktop/package.json" ] && [ -d "$d/.git" ] && { printf '%s' "$d"; return 0; }
  done
  if [ "$(id -u)" = 0 ]; then
    for d in /home/*/.local/share/hermes-alans-way/app /root/.local/share/hermes-alans-way/app; do
      [ -f "$d/desktop/package.json" ] && [ -d "$d/.git" ] && { printf '%s' "$d"; return 0; }
    done
  fi
  return 1
}

find_data_dir() {
  for d in "${ALANS_WAY_VM_DATA:-}" "${HERMES_VPS_BROWSER_DATA:-}" \
      "$HOME/.local/share/hermes-alans-way/browser" \
      "$HOME/Library/Application Support/hermes-alans-way/browser"; do
    [ -n "$d" ] && [ -f "$d/config.json" ] && { printf '%s' "$d"; return 0; }
  done
  if [ "$(id -u)" = 0 ]; then
    for d in /home/*/.local/share/hermes-alans-way/browser /root/.local/share/hermes-alans-way/browser \
        "/var/root/Library/Application Support/hermes-alans-way/browser"; do
      [ -f "$d/config.json" ] && { printf '%s' "$d"; return 0; }
    done
  fi
  return 1
}

NODE_BIN=""
node_bin() {
  [ -n "$NODE_BIN" ] && return 0
  NODE_BIN="$(command -v node 2>/dev/null || true)"
  for n in /usr/local/bin/node /opt/homebrew/bin/node /usr/bin/node; do
    [ -z "$NODE_BIN" ] && [ -x "$n" ] && NODE_BIN="$n"
  done
  [ -n "$NODE_BIN" ]
}

# Prints the broker's /v1/status body, or nothing when it cannot be asked
# (no data dir, no readable token, broker down). Only loopback is contacted.
status_body() {
  DATA="$(find_data_dir)" || return 1
  PORT="$(sed -n 's/.*"port"[^0-9]*\([0-9][0-9]*\).*/\1/p' "$DATA/config.json" | head -1)"
  PORT="${PORT:-9465}"
  TOKEN=""
  for tf in "$DATA/app-token.json" "$DATA/connection.json"; do
    TOKEN="$(sed -n 's/.*"token"[^"]*"\([^"]*\)".*/\1/p' "$tf" 2>/dev/null | head -1)"
    [ -n "$TOKEN" ] && break
  done
  [ -n "$TOKEN" ] || return 1
  if have curl; then
    curl -fsS --max-time 4 -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT/v1/status" 2>/dev/null
  elif node_bin; then
    "$NODE_BIN" -e 'fetch(process.argv[1],{headers:{authorization:"Bearer "+process.argv[2]}}).then(r=>r.text()).then(t=>process.stdout.write(t)).catch(()=>process.exit(1))' \
      "http://127.0.0.1:$PORT/v1/status" "$TOKEN" 2>/dev/null
  else
    return 1
  fi
}
json_field() { sed -n 's/.*"'"$1"'"[^"]*"\([^"]*\)".*/\1/p' | head -1; }

# ---------------------------------------------------------------- main
DIR="$(find_checkout)" \
  || fail "no browser host checkout found (expected /opt/hermes-alans-way/browser or ~/.local/share/hermes-alans-way/app)"
VERSION="$(json_field version < "$DIR/desktop/package.json")"

if [ "$CHECK" = 1 ]; then
  BODY="$(status_body)" || BODY=""
  HOST_VERSION="$(printf '%s' "$BODY" | json_field version)"
  HOST_BUSY=false
  case "$BODY" in *'"busy":true'*) HOST_BUSY=true;; esac
  printf '{"ok":true,"version":"%s","hostVersion":"%s","busy":%s,"error":""}\n' "$VERSION" "$HOST_VERSION" "$HOST_BUSY"
  exit 0
fi

printf '%s' "$TAG" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+$' \
  || fail "refusing non-release tag '$TAG' (need vX.Y.Z)"
say "updating $DIR to $TAG"

# Never swap code under a live agent action. The broker reports busy while a
# tab is mid-action; wait briefly, then leave this VM for a later retry.
deadline=$(( $(date +%s) + BUSY_WAIT ))
while :; do
  BODY="$(status_body)" || BODY=""
  case "$BODY" in
    *'"busy":true'*) ;;
    *) break;;
  esac
  [ "$(date +%s)" -lt "$deadline" ] || fail "busy"
  sleep "$BUSY_POLL"
done

# A root-owned checkout (/opt) still updates when the ssh user has passwordless
# sudo; anything else reports the exact command to run.
SUDO=""
if ! [ -w "$DIR" ]; then
  if sudo -n true 2>/dev/null; then
    SUDO="sudo -n"
  else
    fail "$DIR is not writable by this user; run 'sudo sh -s -- $TAG < vm-update.sh' on the VM"
  fi
fi

$SUDO "$GIT" -C "$DIR" fetch --tags origin >/dev/null 2>&1 \
  || $SUDO "$GIT" -C "$DIR" fetch --unshallow --tags origin >/dev/null 2>&1 \
  || $SUDO "$GIT" -C "$DIR" fetch --depth=1000000 --tags origin >/dev/null 2>&1 \
  || say "git fetch reported a problem; trying the objects already in the checkout"
WANT="$($SUDO "$GIT" -C "$DIR" rev-parse --verify -q "$TAG^{commit}" 2>/dev/null || true)"
[ -n "$WANT" ] || fail "tag $TAG is not in the checkout and could not be fetched"
$SUDO "$GIT" -C "$DIR" -c advice.detachedHead=false checkout -q "$TAG" \
  || fail "could not check out $TAG"
HEAD_NOW="$($SUDO "$GIT" -C "$DIR" rev-parse HEAD 2>/dev/null || true)"
[ "$HEAD_NOW" = "$WANT" ] || fail "checkout did not land on $TAG; refusing to run it"
say "checkout pinned at $TAG"

( cd "$DIR/desktop" && $SUDO env PATH="$PATH" "$NPM" ci --omit=dev --ignore-scripts >/dev/null 2>&1 ) \
  || fail "npm ci failed in $DIR/desktop"
say "dependencies installed"

# Optional per-release migration hook, run from the NEW checkout.
HOOK="$DIR/desktop/scripts/vm-post-update.sh"
if [ -f "$HOOK" ]; then
  $SUDO sh "$HOOK" "$TAG" || fail "the post-update hook failed"
fi

case "$GUEST_OS" in
  Darwin)
    if launchctl kickstart -k "gui/$(id -u)/com.alans-way.browser" 2>/dev/null; then
      RESTARTED=true
    else
      say "could not restart the broker; run: launchctl kickstart -k gui/$(id -u)/com.alans-way.browser"
    fi;;
  *)
    if [ "$(id -u)" = 0 ]; then
      systemctl restart hermes-alans-way-browser.service >/dev/null 2>&1 && RESTARTED=true \
        || say "could not restart the broker; run: systemctl restart hermes-alans-way-browser.service"
    else
      systemctl --user restart hermes-alans-way-browser.service >/dev/null 2>&1 && RESTARTED=true \
        || sudo -n systemctl restart hermes-alans-way-browser.service >/dev/null 2>&1 && RESTARTED=true \
        || say "could not restart the broker; run: systemctl --user restart hermes-alans-way-browser.service (or: sudo systemctl restart hermes-alans-way-browser.service)"
    fi;;
esac
[ "$RESTARTED" = true ] && say "browser host restarted" || say "broker restart is still owed (its file watch may restart it)"

# The broker must answer loopback /v1/status with the tag's version before the
# update is called done; a restart that never comes up is a failure.
deadline=$(( $(date +%s) + HEALTH_WAIT ))
HEALTHY=false
while [ "$(date +%s)" -lt "$deadline" ]; do
  BODY="$(status_body)" || BODY=""
  HOST_VERSION="$(printf '%s' "$BODY" | json_field version)"
  [ "$HOST_VERSION" = "${TAG#v}" ] && { HEALTHY=true; break; }
  sleep 2
done
if [ "$HEALTHY" != true ]; then
  if [ "$RESTARTED" = true ]; then
    fail "the browser host did not come back on $TAG"
  else
    fail "updated but the broker did not report v${TAG#v}; restart it with the command above"
  fi
fi
json true "${TAG#v}" "$RESTARTED" ""
