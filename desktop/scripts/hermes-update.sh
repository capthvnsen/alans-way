#!/bin/sh
# hermes-update.sh - run `hermes update` on this machine, then message the
# user from every Hermes profile through `hermes send`, so each bot reports
# the result in its usual chat.
#
# The desktop app pipes this script over SSH (ssh <host> 'sh -s'), so nothing
# is installed on the machine and no file is left behind. It only ever runs
# the hermes CLI itself: `hermes update --yes --keep-stash` once (the update
# restarts the fleet's own services, and --keep-stash leaves local source
# edits parked in git stash instead of silently restoring them), `hermes
# --version` for the report, and
# `hermes [-p <profile>] send -t telegram <text>` for every profile hermes
# would count. The message goes out even when the update fails - a failed
# update is exactly the report nobody should have to go looking for.
#
# The app's "Update everything" flow sends one message after all its steps:
# it runs this with ALANS_WAY_HERMES_QUIET=1 (update, no message), then again
# with ALANS_WAY_HERMES_REPORT=<text> (no update, only that message).
#
# The last stdout line is one JSON result:
# {"ok":bool,"version":"x.y.z","updated":bool,"error":"...","messaged":bool,
#  "messages":[{"profile":"default","sent":bool,"error":"..."}]}
# Everything above it is progress ("hermes-update: <phase>").
set -u

UPDATE_TIMEOUT="${ALANS_WAY_HERMES_UPDATE_TIMEOUT:-200}"
SEND_TIMEOUT="${ALANS_WAY_HERMES_SEND_TIMEOUT:-30}"
VERSION_TIMEOUT="${ALANS_WAY_HERMES_VERSION_TIMEOUT:-20}"
# A run budget under the app's remote cap so the result line is always reached.
BUDGET="${ALANS_WAY_HERMES_BUDGET:-270}"
HERMES_BIN="" VERSION="" BEFORE="" CURRENT=false UPDATED=false MESSAGED=false MESSAGES_JSON=""
START_S="$(date +%s)"

safe_git_error() { sed -E 's#([[:alpha:]][[:alnum:]+.-]*://)[^/@[:space:]]+@#\1[redacted]@#g; s#([[:alpha:]][[:alnum:]+.-]*://[^?#[:space:]]+)[?#][^[:space:]]*#\1[redacted]#g' | tr '\n' ' '; }
say() { printf 'hermes-update: %s\n' "$(printf '%s' "$*" | safe_git_error)"; }
json_string() { printf '%s' "$1" | safe_git_error | tr '\n\t' '  ' | tr -d '\000-\037\177' | sed 's/\\/\\\\/g; s/"/\\"/g' | cut -c1-300; }
json() { printf '{"ok":%s,"version":"%s","updated":%s,"before":"%s","current":%s,"error":"%s","messaged":%s,"messages":[%s]}\n' "$1" "$2" "$3" "$BEFORE" "$CURRENT" "$(json_string "$4")" "$5" "$6"; }
fail() { json false "$VERSION" "$UPDATED" "$1" "$MESSAGED" "$MESSAGES_JSON"; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }
budget_left() { printf '%s' "$(( BUDGET - ($(date +%s) - START_S) ))"; }
tail_text() { printf '%s' "$1" | tr '\n' ' ' | sed 's/  */ /g' | tail -c 300; }

HERMES_BIN_RES=""
hermes_bin() {
  [ -n "$HERMES_BIN_RES" ] && return 0
  HERMES_BIN_RES="$(command -v hermes 2>/dev/null || true)"
  for h in "$HOME/.local/bin/hermes" "${HERMES_HOME:-$HOME/.hermes}/bin/hermes" \
      /usr/local/bin/hermes /opt/homebrew/bin/hermes; do
    [ -z "$HERMES_BIN_RES" ] && [ -x "$h" ] && HERMES_BIN_RES="$h"
  done
  [ -n "$HERMES_BIN_RES" ]
}

# One bounded hermes call: stdin is /dev/null so a prompt can only ever read
# EOF ("no"), and `timeout` (or a perl alarm: a Mac has perl but no GNU
# timeout) caps the call inside the run's remaining budget so the JSON result
# line is always reached. The alarm exits 142, not timeout's 124.
run_hermes() {
  _secs="$1"; shift
  _left=$(( $(budget_left) - 8 ))
  [ "$_left" -gt 0 ] || return 124
  [ "$_secs" -le "$_left" ] || _secs="$_left"
  if have timeout; then timeout -k 5 "$_secs" "$HERMES_BIN_RES" "$@" </dev/null 2>&1
  elif have perl; then perl -e 'alarm shift; exec @ARGV' "$_secs" "$HERMES_BIN_RES" "$@" </dev/null 2>&1
  else "$HERMES_BIN_RES" "$@" </dev/null 2>&1; fi
}

# The profiles hermes counts: the default home plus every profile dir with the
# canonical name grammar, an identity marker and no .deleted tombstone - the
# same rules hermes_cli uses to enumerate them.
list_profiles() {
  [ -d "$HHOME" ] && printf 'default %s\n' "$HHOME"
  for d in "$HHOME"/profiles/*/; do
    [ -d "$d" ] || continue
    _n="$(basename "$d")"
    case "$_n" in ''|[!a-z0-9]*|*[!a-z0-9_-]*) continue;; esac
    [ "${#_n}" -le 63 ] || continue
    if [ -e "$HHOME/profiles/.deleted/$_n" ] || [ -L "$HHOME/profiles/.deleted/$_n" ]; then continue; fi
    _ok=0
    for _m in config.yaml .env SOUL.md profile.yaml auth.json state.db; do
      if [ -f "$d$_m" ] || [ -L "$d$_m" ]; then _ok=1; break; fi
    done
    [ "$_ok" = 1 ] && printf '%s %s\n' "$_n" "${d%/}"
  done
}

# $1 = profile, $2 = sent bool, $3 = error; one JSON entry.
msg_entry() {
  printf '{"profile":"%s","sent":%s,"error":"%s"}' "$(json_string "$1")" "$2" "$(json_string "$3")"
}

QUIET="${ALANS_WAY_HERMES_QUIET:-}" REPORT="${ALANS_WAY_HERMES_REPORT:-}"
hermes_bin || fail 'no hermes CLI on this machine'
if [ -n "$REPORT" ]; then
  UPD_OUT="" UPD_RC=0
else
  BEFORE="$(run_hermes "$VERSION_TIMEOUT" --version | sed -n 's/^Hermes Agent v\([^[:space:]]*\).*/\1/p' | head -1)"
  say 'running hermes update'
  UPD_OUT="$(run_hermes "$UPDATE_TIMEOUT" update --yes --keep-stash)"
  UPD_RC=$?
fi
# The version read follows the update so an install that moved reports the new
# one; a failed update still reports whatever version is on the machine now.
VERSION="$(run_hermes "$VERSION_TIMEOUT" --version | sed -n 's/^Hermes Agent v\([^[:space:]]*\).*/\1/p' | head -1)"
case "$UPD_RC" in
  0) ERR=""
     if [ -n "$VERSION" ] && [ -n "$BEFORE" ] && [ "$VERSION" != "$BEFORE" ]; then UPDATED=true
     elif [ -z "$REPORT" ]; then
       CHECK_OUT="$(run_hermes "$VERSION_TIMEOUT" update --check)"; CHECK_RC=$?
       if [ "$CHECK_RC" -eq 0 ] && [ -n "$VERSION" ] && printf '%s' "$CHECK_OUT" | grep -Eiq 'up to date|no newer release|no update available'; then CURRENT=true
       else ERR="version unchanged or unverified after hermes update: $(tail_text "$UPD_OUT")"; fi
     fi;;
  124|142) ERR='the hermes update timed out';;
  *) ERR="$(tail_text "$UPD_OUT")"; [ -n "$ERR" ] || ERR="hermes update exited $UPD_RC";;
esac
[ -n "$REPORT" ] && UPDATED=false
[ -n "$REPORT" ] || { [ "$UPD_RC" -eq 0 ] && say 'hermes update finished' || say "hermes update failed: $ERR"; }

# The message each profile's bot sends home: outcome, host and version so a
# user with several machines can tell them apart.
HOST="$(hostname 2>/dev/null || true)"; HOST="${HOST:+ on $HOST}"
if [ "$UPD_RC" -eq 0 ]; then
  if [ "$UPDATED" = true ]; then MSG="Hermes update finished$HOST."; elif [ "$CURRENT" = true ]; then MSG="Hermes is already up to date$HOST."; else MSG="Hermes update warning$HOST: $ERR."; fi
  [ -n "$VERSION" ] && MSG="$MSG Now on v$VERSION."
else
  MSG="Hermes update failed$HOST: $(printf '%s' "$ERR" | cut -c1-200)"
fi
[ -n "$REPORT" ] && MSG="$REPORT"
MSG="$(printf '%s' "$MSG" | safe_git_error)"

HHOME="${HERMES_HOME:-$HOME/.hermes}"
if [ -n "$QUIET" ]; then
  say 'the message waits for the end of the update'
elif [ "$(budget_left)" -gt 15 ]; then
  say 'telling your bot to message you'
  while read -r _pname _phome; do
    [ -n "$_pname" ] || continue
    if [ "$(budget_left)" -le 12 ]; then
      say 'ran out of the time budget; remaining profiles were not messaged'
      break
    fi
    if [ "$_pname" = default ]; then
      _s_out="$(run_hermes "$SEND_TIMEOUT" send -q -t telegram "$MSG")"
    else
      _s_out="$(run_hermes "$SEND_TIMEOUT" -p "$_pname" send -q -t telegram "$MSG")"
    fi; _s_rc=$?
    if [ "$_s_rc" -eq 0 ]; then _s_sent=true _s_err="" MESSAGED=true
    else _s_sent=false _s_err="$(tail_text "$_s_out" | cut -c1-200)"; [ -n "$_s_err" ] || _s_err="send exited $_s_rc"; fi
    say "message $_pname: $([ "$_s_sent" = true ] && echo sent || echo failed)"
    MESSAGES_JSON="${MESSAGES_JSON}${MESSAGES_JSON:+,}$(msg_entry "$_pname" "$_s_sent" "$_s_err")"
  done <<EOF
$(list_profiles)
EOF
else
  say 'no time left to message you'
fi
[ "$MESSAGED" != true ] && [ "$UPD_RC" -eq 0 ] && [ -z "$QUIET" ] && say 'no profile could message you; the result is only in this report'

if [ "$UPD_RC" -eq 0 ]; then
  json true "$VERSION" "$UPDATED" "$ERR" "$MESSAGED" "$MESSAGES_JSON"
  exit 0
fi
fail "$ERR"
