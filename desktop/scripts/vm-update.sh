#!/bin/sh
# vm-update.sh - bring this machine's Alan's Way browser host checkout to a
# release tag, restart the tab broker and verify it answers with that version,
# then update each Hermes profile's alans-way plugins through `hermes plugins
# update` and drain-restart the gateway once when any plugin changed.
#
# The desktop app pipes this script over SSH (ssh <host> 'sh -s -- v0.3.2'),
# so nothing is installed on the VM and no file is left behind. It only ever
# touches the checkout setup.sh created, that checkout's node_modules, the
# browser services named below, and the Hermes plugins listed below - and the
# plugins only through `hermes -p <profile> plugins update <name>`. Consent
# gates (a re-pin that widens the plugin, new dependencies) can never be
# answered here: hermes runs with stdin closed and those plugins come back as
# needs_approval. Installs recorded with a file:// source re-clone it, so the
# alans-way-agents clone is first advanced to its newest release tag - forward
# only, never a branch tip, never over local changes.
#
#   sh vm-update.sh v0.3.2    update to the tag, restart broker + plugins
#   sh vm-update.sh --check   read-only: print the checkout/live versions
#
# Checkout discovery matches setup.sh: a root install lives at
# /opt/hermes-alans-way/browser, a user install at
# ~/.local/share/hermes-alans-way/app. Services match setup.sh too:
#   Linux   hermes-alans-way-browser.service (system or user unit), or the
#           supervisord program whose command line runs vps-browser-host.cjs
#           on a guest without a live systemd
#   macOS   gui/<uid>/com.alans-way.browser  (LaunchAgent)
# Chromium is deliberately not restarted so open tabs and sign-ins survive.
#
# The last stdout line is one JSON result: {"ok":bool,"version":"x.y.z",
# "restarted":bool,"error":"...","plugins":[...],"gatewayRestarted":bool}.
# When the gateway runs under a supervisor the result also carries
# "gatewayRestartCmd", the restart command that works on this host.
# Everything above it is progress; "vm-update: <phase>" lines map to UI text.
set -u

TAG="" CHECK=0
case "${1:-}" in
  --check) CHECK=1;;
  -h|--help)
    # $0 is 'sh' when the app pipes this script via 'sh -s', so the usage text
    # is embedded rather than read back out of the script file.
    cat <<'EOF'
vm-update.sh - bring this machine's Alan's Way browser host checkout to a
release tag, restart the tab broker and verify it answers with that version.

  sh vm-update.sh v0.3.2    update to the tag and restart the browser host
  sh vm-update.sh --check   read-only: print the checkout/live versions

The desktop app pipes this script over SSH, so nothing is installed on the VM
and no file is left behind. It only ever touches the checkout setup.sh
created, that checkout's node_modules, the browser services it manages, and
the Hermes plugins it updates through `hermes plugins update`.
EOF
    exit 0;;
  *) TAG="${1:-}";;
esac

GIT="${ALANS_WAY_VM_GIT:-git}"
NPM="${ALANS_WAY_VM_NPM:-npm}"
GUEST_OS="${ALANS_WAY_VM_OS:-$(uname -s 2>/dev/null || echo Linux)}"
BUSY_WAIT="${ALANS_WAY_VM_BUSY_WAIT:-60}"
BUSY_POLL="${ALANS_WAY_VM_BUSY_POLL:-5}"
HEALTH_WAIT="${ALANS_WAY_VM_HEALTH_WAIT:-45}"
PLUGIN_TIMEOUT="${ALANS_WAY_VM_PLUGIN_TIMEOUT:-90}"
GATEWAY_TIMEOUT="${ALANS_WAY_VM_GATEWAY_TIMEOUT:-180}"
# A run budget under the app's remote cap so the result line is always reached.
VM_BUDGET="${ALANS_WAY_VM_BUDGET:-270}"
VERSION="" RESTARTED=false PLUGINS_JSON="" GATEWAY_RESTARTED=false
# The gateway restart that works on this host; GW_EXTRA carries it into the
# result JSON only when it is not the usual hermes command.
GW_CMD="hermes gateway restart" GW_EXTRA=""
START_S="$(date +%s)"

say() { printf 'vm-update: %s\n' "$*"; }
json_string() { printf '%s' "$1" | tr '\n\t' '  ' | tr -d '\000-\037\177' | sed 's/\\/\\\\/g; s/"/\\"/g' | cut -c1-300; }
json() { printf '{"ok":%s,"version":"%s","restarted":%s,"error":"%s","plugins":[%s],"gatewayRestarted":%s%s}\n' "$1" "$2" "$3" "$(json_string "$4")" "$5" "$6" "$GW_EXTRA"; }
fail() { json false "$VERSION" "$RESTARTED" "$1" "$PLUGINS_JSON" "$GATEWAY_RESTARTED"; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }
budget_left() { printf '%s' "$(( VM_BUDGET - ($(date +%s) - START_S) ))"; }

# True only when systemd is the running service manager. A systemctl binary
# alone is not enough: minimal VM images ship one that answers "offline".
# When no systemctl exists, /run/systemd/system is the fallback marker.
systemd_live() {
  if have systemctl; then
    case "$(systemctl is-system-running 2>/dev/null)" in
      running|degraded|starting|initializing|maintenance) return 0;;
    esac
    return 1
  fi
  [ -d /run/systemd/system ]
}

# supervisorctl as this user, then under passwordless sudo when the socket
# needs root (sudo -n fails instead of ever asking for a password). Only one
# call answers: status and pid exit nonzero whenever a program is not RUNNING
# while still printing a valid reply, so a plain || retry would run both and
# concatenate their output (two identical pid lines reading as one number).
_sp_ctl() {
  _sp_out="$(supervisorctl "$@" 2>/dev/null)" && { printf '%s' "$_sp_out"; return 0; }
  _sp_sudo="$(sudo -n supervisorctl "$@" 2>/dev/null)" && { printf '%s' "$_sp_sudo"; return 0; }
  printf '%s' "$_sp_out"
  return 1
}

# Prints the supervisord program whose command line contains every pattern in
# $*, or nothing. Programs are matched by live process argv (a wrapper that
# execs shows the real command), so a renamed program still resolves.
# Supervisor conf files are the fallback for programs that are not running,
# but only where systemd is not live: on a systemd host a leftover conf must
# never win over the real unit or start a duplicate stopped program.
supervisor_program() {
  have supervisorctl || return 1
  for _sp_name in $(_sp_ctl status | awk '{print $1}'); do
    _sp_pid="$(_sp_ctl pid "$_sp_name" | tr -d '[:space:]')"
    case "$_sp_pid" in ''|0|*[!0-9]*) continue;; esac
    _sp_argv="$(ps -p "$_sp_pid" -o args= 2>/dev/null)"
    _sp_ok=1
    for _sp_pat in "$@"; do
      case "$_sp_argv" in *"$_sp_pat"*) ;; *) _sp_ok=0;; esac
    done
    [ "$_sp_ok" = 1 ] && { printf '%s\n' "$_sp_name"; return 0; }
  done
  systemd_live && return 1
  _sp_pats="$(printf '%s\034' "$@")"
  for _sp_conf in ${ALANS_WAY_VM_SUPERVISOR_CONFS:-/etc/supervisor/conf.d/*.conf /etc/supervisor/conf.d/*.ini /etc/supervisord.d/*.conf /etc/supervisord.d/*.ini /etc/supervisor/supervisord.conf /etc/supervisord.conf}; do
    [ -f "$_sp_conf" ] || continue
    _sp_prog="$(awk -v pats="$_sp_pats" '
      BEGIN { np = split(pats, P, "\034") }
      /^\[program:/ { n=$0; sub(/^\[program:[[:space:]]*/, "", n); sub(/[[:space:]]*\].*/, "", n); next }
      /^\[/ { n="" }
      n != "" && /^[[:space:]]*command[[:space:]]*=/ {
        ok = 1
        for (i = 1; i <= np; i++) if (P[i] != "" && index($0, P[i]) == 0) ok = 0
        if (ok) { print n; exit }
      }
    ' "$_sp_conf" 2>/dev/null)"
    [ -n "$_sp_prog" ] && { printf '%s\n' "$_sp_prog"; return 0; }
  done
  return 1
}

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
    for h in /home/* /root; do
      d="$h/.local/share/hermes-alans-way/app"
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
    for h in /home/* /root; do
      d="$h/.local/share/hermes-alans-way/browser"
      [ -f "$d/config.json" ] && { printf '%s' "$d"; return 0; }
    done
    d="/var/root/Library/Application Support/hermes-alans-way/browser"
    [ -f "$d/config.json" ] && { printf '%s' "$d"; return 0; }
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
# connection.json is authoritative: the broker writes its own url and token
# there, so a relocated port or token file still resolves.
status_body() {
  DATA="$(find_data_dir)" || return 1
  URL="$(sed -n 's/.*"url"[^"]*"\([^"]*\)".*/\1/p' "$DATA/connection.json" 2>/dev/null | head -1)"
  TOKEN="$(sed -n 's/.*"token"[^"]*"\([^"]*\)".*/\1/p' "$DATA/connection.json" 2>/dev/null | head -1)"
  if [ -z "$TOKEN" ]; then
    TOKEN="$(sed -n 's/.*"token"[^"]*"\([^"]*\)".*/\1/p' "$DATA/app-token.json" 2>/dev/null | head -1)"
  fi
  if [ -z "$TOKEN" ]; then
    TF="$(sed -n 's/.*"appTokenFile"[^"]*"\([^"]*\)".*/\1/p' "$DATA/config.json" | head -1)"
    [ -n "$TF" ] && TOKEN="$(sed -n 's/.*"token"[^"]*"\([^"]*\)".*/\1/p' "$TF" 2>/dev/null | head -1)"
  fi
  [ -n "$TOKEN" ] || return 1
  case "$URL" in
    http://127.0.0.1:*|http://localhost:*|http://\[::1\]:*) ;;
    *) PORT="$(sed -n 's/.*"port"[^0-9]*\([0-9][0-9]*\).*/\1/p' "$DATA/config.json" | head -1)"
       URL="http://127.0.0.1:${PORT:-9465}";;
  esac
  if have curl; then
    curl -fsS --max-time 4 -H "Authorization: Bearer $TOKEN" "$URL/v1/status" 2>/dev/null
  elif node_bin; then
    "$NODE_BIN" -e 'fetch(process.argv[1],{headers:{authorization:"Bearer "+process.argv[2]}}).then(r=>r.text()).then(t=>process.stdout.write(t)).catch(()=>process.exit(1))' \
      "$URL/v1/status" "$TOKEN" 2>/dev/null
  else
    return 1
  fi
}
json_field() { sed -n 's/.*"'"$1"'"[^"]*"\([^"]*\)".*/\1/p' | head -1; }

# --- Hermes plugins ---------------------------------------------------------
# Each profile's alans-way / alans-way-computer plugin updates through
# `hermes -p <profile> plugins update <name>` and nothing else. Consent gates
# (a re-pin that widens the plugin, newly declared dependencies) are reported
# needs_approval - never forced, never answered, never --yes.

HERMES_BIN=""
hermes_bin() {
  [ -n "$HERMES_BIN" ] && return 0
  HERMES_BIN="$(command -v hermes 2>/dev/null || true)"
  for h in "$HOME/.local/bin/hermes" "${HERMES_HOME:-$HOME/.hermes}/bin/hermes" \
      /usr/local/bin/hermes /opt/homebrew/bin/hermes; do
    [ -z "$HERMES_BIN" ] && [ -x "$h" ] && HERMES_BIN="$h"
  done
  [ -n "$HERMES_BIN" ]
}

# One bounded hermes call: stdin is /dev/null so a consent prompt can only ever
# read EOF ("no"), and `timeout` (when the guest has it) caps the call inside
# the run's remaining budget so the JSON result line is always reached.
run_hermes() {
  _secs="$1"; shift
  _left=$(( $(budget_left) - 8 ))
  [ "$_left" -gt 0 ] || return 124
  [ "$_secs" -le "$_left" ] || _secs="$_left"
  if have timeout; then timeout "$_secs" "$HERMES_BIN" "$@" </dev/null 2>&1
  else "$HERMES_BIN" "$@" </dev/null 2>&1; fi
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

# $1 = plugin manifest dir; prints its declared version ("" when unreadable).
plugin_version() {
  sed -n 's/^version:[[:space:]]*"\{0,1\}\([^"]\{1,\}\)"\{0,1\}[[:space:]]*$/\1/p' "$1/plugin.yaml" 2>/dev/null | head -1
}
# $1 = install-metadata entry; prints its recorded revision ("" when absent).
plugin_rev() {
  printf '%s\n' "$1" | sed -n 's/.*"revision"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1
}

# $1 = plugins dir, $2 = plugin name; prints the plugin's .install-metadata.json
# entry. Braces are counted so pretty-printed and compact JSON both resolve to
# the one block for that plugin name.
plugin_meta() {
  [ -f "$1/.install-metadata.json" ] || return 0
  awk -v key="$2" '
    !inblk && match($0, "\"" key "\"[ \t]*:[ \t]*{") { inblk=1; n=0 }
    inblk { print; n += gsub(/{/, "{") - gsub(/}/, "}"); if (n <= 0) exit }
  ' "$1/.install-metadata.json" 2>/dev/null
}

# $1 = clone dir. Advances an alans-way-agents clone to its newest release tag,
# forward only - the tag is resolved as refs/tags/<tag>^{commit} so a branch
# can never stand in for it. Prints "<outcome> <detail>": moved|ahead <ref>,
# skipped <reason>, or none (not our clone / no release tags to aim at).
clone_refresh() {
  _cr="$1"
  [ -d "$_cr/.git" ] || { echo "none"; return 0; }
  _cr_url="$("$GIT" -C "$_cr" remote get-url origin 2>/dev/null || true)"
  case "$_cr_url" in *alans-way-agents*) ;; *) echo "none"; return 0;; esac
  "$GIT" -C "$_cr" fetch --tags origin >/dev/null 2>&1 \
    || "$GIT" -C "$_cr" fetch --unshallow --tags origin >/dev/null 2>&1 \
    || say "plugin clone fetch reported a problem; using the refs already in $_cr"
  _cr_tag="$("$GIT" -C "$_cr" tag -l 'v*' 2>/dev/null | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -t. -k1.2n -k2n -k3n | tail -1)"
  [ -n "$_cr_tag" ] || { echo "none"; return 0; }
  _cr_want="$("$GIT" -C "$_cr" rev-parse --verify -q "refs/tags/$_cr_tag^{commit}" 2>/dev/null || true)"
  _cr_head="$("$GIT" -C "$_cr" rev-parse HEAD 2>/dev/null || true)"
  [ -n "$_cr_want" ] && [ -n "$_cr_head" ] || { echo "none"; return 0; }
  if "$GIT" -C "$_cr" merge-base --is-ancestor "$_cr_want" "$_cr_head" 2>/dev/null; then
    echo "ahead $("$GIT" -C "$_cr" describe --tags --always 2>/dev/null || printf '%s' "$_cr_head" | cut -c1-12)"
    return 0
  fi
  if [ -n "$("$GIT" -C "$_cr" status --porcelain 2>/dev/null | head -1)" ]; then
    echo "skipped local changes"; return 0
  fi
  "$GIT" -C "$_cr" merge-base --is-ancestor "$_cr_head" "$_cr_want" 2>/dev/null \
    || { echo "skipped not an ancestor of $_cr_tag"; return 0; }
  if "$GIT" -C "$_cr" -c advice.detachedHead=false checkout -q "refs/tags/$_cr_tag" 2>/dev/null \
      && [ "$("$GIT" -C "$_cr" rev-parse HEAD 2>/dev/null)" = "$_cr_want" ]; then
    echo "moved $_cr_tag"; return 0
  fi
  echo "skipped could not check out $_cr_tag"
}

# $1 = cached clone record path - echoes its recorded outcome or "".
clone_seen() {
  printf '%s\n' "$CLONES" | while IFS='|' read -r _cp _co; do
    [ "$_cp" = "$1" ] && { printf '%s' "$_co"; break; }
  done
}

# $1..$7 = profile name before after status error repoRef; one JSON entry.
plugin_entry() {
  _extra=""
  [ -n "${6:-}" ] && _extra="$_extra,\"error\":\"$(json_string "$6")\""
  [ -n "${7:-}" ] && _extra="$_extra,\"repoRef\":\"$(json_string "$7")\""
  printf '{"profile":"%s","name":"%s","before":"%s","after":"%s","status":"%s"%s}' \
    "$(json_string "$1")" "$(json_string "$2")" "$(json_string "$3")" "$(json_string "$4")" "$5" "$_extra"
}

update_hermes_plugins() {
  if ! hermes_bin; then say "no hermes CLI on this VM; skipping plugin updates"; return 0; fi
  HHOME="${HERMES_HOME:-$HOME/.hermes}"
  say "updating Hermes plugins"
  CLONES="" CHANGED=false
  while read -r _pname _phome; do
    [ -n "$_pname" ] || continue
    _pdir="$_phome/plugins"
    for _name in alans-way alans-way-computer; do
      [ -d "$_pdir/$_name" ] || continue
      _meta="$(plugin_meta "$_pdir" "$_name")"
      _before="$(plugin_version "$_pdir/$_name")"
      [ -n "$_before" ] || _before="$(plugin_rev "$_meta")"
      _repo_ref=""
      # Catalog installs carry a "catalog" block (and a .hermes-catalog.json
      # marker): their reviewed pin is moved by `plugins update`, never here.
      _src="$(printf '%s\n' "$_meta" | sed -n 's/.*"source"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
      case "$_meta" in *'"catalog"'*) _src="";; esac
      [ -f "$_pdir/$_name/.hermes-catalog.json" ] && _src=""
      case "$_src" in
        file://*)
          _clone="$(printf '%s' "${_src#file://}" | cut -d# -f1)"
          _outcome="$(clone_seen "$_clone")"
          if [ -z "$_outcome" ]; then
            _outcome="$(clone_refresh "$_clone")"
            CLONES="${CLONES}${CLONES:+
}$_clone|$_outcome"
          fi
          _co="${_outcome%% *}"; _cd="${_outcome#"$_co"}"; _cd="${_cd# }"
          case "$_co" in
            moved|ahead) _repo_ref="$_cd";;
            skipped)
              say "plugin $_name ($_pname): clone left alone: $_cd"
              PLUGINS_JSON="${PLUGINS_JSON}${PLUGINS_JSON:+,}$(plugin_entry "$_pname" "$_name" "$_before" "$_before" skipped "$_cd")"
              continue;;
          esac;;
      esac
      [ "$(budget_left)" -gt 15 ] || { say "plugin phase ran out of the time budget; remaining plugins will retry next update"; break 2; }
      if [ "$_pname" = default ]; then
        _out="$(run_hermes "$PLUGIN_TIMEOUT" plugins update "$_name")"
      else
        _out="$(run_hermes "$PLUGIN_TIMEOUT" -p "$_pname" plugins update "$_name")"
      fi; _rc=$?
      _after="$(plugin_version "$_pdir/$_name")"
      [ -n "$_after" ] || _after="$(plugin_rev "$(plugin_meta "$_pdir" "$_name")")"
      if [ "$_rc" -eq 124 ]; then
        _st=failed; _err="the hermes update timed out"
      elif printf '%s' "$_out" | grep -Eiq 'not applied|declined|confirm to continue|fail.?closed|not granted|new capabilities'; then
        _st=needs_approval; _err=""
      elif [ "$_rc" -ne 0 ]; then
        _st=failed; _err="$(printf '%s\n' "$_out" | tail -2 | tr '\n' ' ')"
      elif printf '%s' "$_out" | grep -Eiq 'already (up to date|at catalog pin)'; then
        _st=current; _err=""
      else
        _st=updated; _err=""
      fi
      case "$_st" in
        updated) CHANGED=true;;
        needs_approval)
          # The code moved but new capabilities stay ungranted until reviewed.
          printf '%s' "$_out" | grep -Eq 'updated|Re-installed' && CHANGED=true;;
      esac
      say "plugin $_name ($_pname): $_st"
      PLUGINS_JSON="${PLUGINS_JSON}${PLUGINS_JSON:+,}$(plugin_entry "$_pname" "$_name" "$_before" "$_after" "$_st" "$_err" "$_repo_ref")"
    done
  done <<EOF
$(list_profiles)
EOF
  # The gateway loads plugin code at start, so one drain-restart when anything
  # actually changed (hermes gateway restart: SIGUSR1 drain, the supervisor or
  # service manager owns the relaunch).
  if [ "$CHANGED" = true ]; then
    say "restarting the agent gateway"
    # A gateway that runs under supervisord is restarted through it: without
    # an external-supervisor marker `hermes gateway restart` only sees a
    # "manual" process and takes its destructive stop/start path, which races
    # the supervisor's own respawn. The program is found by command line,
    # never by a hardcoded name; hermes stays the fallback.
    GW_PROG="$(supervisor_program 'hermes' 'gateway run')"
    if [ -n "$GW_PROG" ]; then
      GW_CMD="supervisorctl restart $GW_PROG"
    elif ! systemd_live && have supervisorctl; then
      # The gateway's program is unresolvable here (a stopped program whose
      # conf command is a wrapper), but supervisord is the service manager, so
      # the remediation names it rather than the hermes fallback it hides.
      GW_CMD="supervisorctl restart <program>"
    fi
    [ "$GW_CMD" = "hermes gateway restart" ] || GW_EXTRA=",\"gatewayRestartCmd\":\"$(json_string "$GW_CMD")\""
    if [ -n "$GW_PROG" ] && _sp_ctl restart "$GW_PROG" >/dev/null 2>&1; then
      GATEWAY_RESTARTED=true
    elif run_hermes "$GATEWAY_TIMEOUT" gateway restart >/dev/null 2>&1; then
      GATEWAY_RESTARTED=true
    fi
    if [ "$GATEWAY_RESTARTED" = true ]; then
      say "agent gateway restarted"
    else
      say "gateway restart did not finish; on the VM run: $GW_CMD"
    fi
  fi
}

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
# Only a real tag may satisfy the pin: resolve refs/tags/$TAG fully so a
# same-named branch or lightweight ref can never stand in for it.
WANT="$($SUDO "$GIT" -C "$DIR" rev-parse --verify -q "refs/tags/$TAG^{commit}" 2>/dev/null || true)"
[ -n "$WANT" ] || fail "tag $TAG is not in the checkout and could not be fetched"
$SUDO "$GIT" -C "$DIR" -c advice.detachedHead=false checkout -q "refs/tags/$TAG" \
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
    # A broker managed by supervisord restarts through supervisorctl; the
    # program is found by its command line, not a hardcoded name. With no
    # live systemd there is no working systemctl to fall back to, so the
    # remediation names the command that can work on this host.
    _prog="$(supervisor_program 'vps-browser-host.cjs')"
    if [ -n "$_prog" ]; then
      _sp_ctl restart "$_prog" >/dev/null 2>&1 && RESTARTED=true \
        || say "could not restart the broker; run: supervisorctl restart $_prog (or: sudo supervisorctl restart $_prog)"
    elif ! systemd_live; then
      if have supervisorctl; then
        say "could not restart the broker; find its program with: supervisorctl status"
      else
        say "could not restart the broker; restart the service that runs vps-browser-host.cjs serve"
      fi
    elif [ "$(id -u)" = 0 ]; then
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
HEALTHY=false ASKED=false
while [ "$(date +%s)" -lt "$deadline" ]; do
  BODY="$(status_body)" || BODY=""
  [ -n "$BODY" ] && ASKED=true
  HOST_VERSION="$(printf '%s' "$BODY" | json_field version)"
  [ "$HOST_VERSION" = "${TAG#v}" ] && { HEALTHY=true; break; }
  sleep 2
done
if [ "$HEALTHY" != true ]; then
  if [ "$ASKED" != true ]; then
    fail "updated but the broker status could not be read; verify $TAG on the VM and restart the broker with the command above"
  elif [ "$RESTARTED" = true ]; then
    fail "the browser host did not come back on $TAG"
  else
    fail "updated but the broker did not report v${TAG#v}; restart it with the command above"
  fi
fi

update_hermes_plugins
json true "${TAG#v}" "$RESTARTED" "" "$PLUGINS_JSON" "$GATEWAY_RESTARTED"
