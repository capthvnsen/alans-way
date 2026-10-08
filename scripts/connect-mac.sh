#!/bin/sh
# connect-mac.sh — connect this Mac to the VPS that runs your Hermes gateway.
# Your setup agent prints this command with the VPS's address and public keys
# filled in:
#
#   curl -fsSL https://raw.githubusercontent.com/capthvnsen/alans-way/main/scripts/connect-mac.sh | sh -s -- \
#     --vps root@<vps-tailscale-ip> \
#     --vps-host-key 'ssh-ed25519 AAAA...' \
#     --vps-key 'ssh-ed25519 AAAA... root@vps'
#
# It installs or upgrades the Alan's Way app, lets that VPS key log in to this
# Mac (only from your Tailscale network), pins the VPS host key so this Mac can
# reach the VPS without a trust-on-first-use prompt, and prints the values the
# agent needs next. The VPS address must be a Tailscale name or IP. Only public
# keys are printed. Safe to re-run.
set -eu

INSTALL_URL="https://raw.githubusercontent.com/capthvnsen/alans-way/main/scripts/install-mac.sh"
VPS="" VPS_HOST_KEY="" VPS_KEY="" SKIP_INSTALL=0

die() { printf 'connect-mac: %s\n' "$*" >&2; exit 1; }
say() { printf '%s\n' "$*"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --vps) VPS="${2:-}"; shift 2;;
    --vps-host-key) VPS_HOST_KEY="${2:-}"; shift 2;;
    --vps-key) VPS_KEY="${2:-}"; shift 2;;
    --skip-install) SKIP_INSTALL=1; shift;;
    -h|--help) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0;;
    *) die "unknown arg: $1";;
  esac
done

[ "$(uname -s)" = Darwin ] || die "run this on your Mac"
[ -n "$VPS" ] && [ -n "$VPS_HOST_KEY" ] && [ -n "$VPS_KEY" ] \
  || die "needs --vps, --vps-host-key and --vps-key; ask your setup agent for the full command"

# Strict shapes: these values land in authorized_keys and known_hosts.
printf '%s' "$VPS" | grep -Eq '^([A-Za-z0-9._-]+@)?[A-Za-z0-9.:-]+$' || die "bad --vps (expected user@host)"
KEY_RE='^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)) [A-Za-z0-9+/]+=*'
printf '%s' "$VPS_HOST_KEY" | grep -Eq "$KEY_RE\$" || die "bad --vps-host-key (expected 'ssh-ed25519 AAAA...')"
printf '%s' "$VPS_KEY" | grep -Eq "$KEY_RE( [A-Za-z0-9@._-]+)?\$" || die "bad --vps-key (expected 'ssh-ed25519 AAAA... comment')"
VPS_HOST="${VPS#*@}"

# --- tailnet helpers begin (tests/test_connect_scripts.py runs this block)
# Tailscale addresses are 100.64.0.0/10 (100.64.0.0 to 100.127.255.255) and
# fd7a:115c:a1e0::/48. Names are MagicDNS (*.ts.net) or a short single label.
is_tailnet_ip() {
  case "$1" in
    *[!0-9.]*) ;;
    *) printf '%s' "$1" | awk -F. '{ ok = (NF == 4); for (i = 1; i <= 4 && ok; i++) if ($i !~ /^(0|[1-9][0-9]*)$/ || $i + 0 > 255) ok = 0; ok = ok && $1 == 100 && $2 >= 64 && $2 <= 127 } END { exit !ok }'; return;;
  esac
  case "$1" in
    [fF][dD]7[aA]:115[cC]:[aA]1[eE]0:*) return 0;;
  esac
  return 1
}
is_tailnet_host() {
  is_tailnet_ip "$1" && return 0
  case "$1" in
    ""|*[!A-Za-z0-9.-]*|.*|*.|*..*) return 1;;
    *.[tT][sS].[nN][eE][tT]) return 0;;
    *.*) return 1;;
  esac
  return 0
}
# Add KEY to FILE limited to the tailnet. Any existing line carrying the same
# key (for example an earlier unrestricted one) is replaced, so re-running
# tightens an old install and never duplicates the line. The wanted line rides
# into awk through the environment: awk -v would interpret backslash escapes
# in the key, so keys carrying escapes, newlines or quotes are refused instead.
FROM_TAILNET='from="100.64.0.0/10,fd7a:115c:a1e0::/48"'
install_tailnet_key() {
  _file="$1"; _key="$2"; _tmp="$_file.tmp.$$"
  case "$_key" in *\\*|*'"'*|*"'"*|*'
'*) return 1;;
  esac
  _blob="$(printf '%s' "$_key" | awk '{print $2}')"
  [ -n "$_blob" ] || return 1
  WANT="$FROM_TAILNET $_key" BLOB="$_blob" awk '
    { hit = 0; n = split($0, f, " "); for (i = 1; i <= n; i++) if (f[i] == ENVIRON["BLOB"]) hit = 1
      if (hit) { if (!done) print ENVIRON["WANT"]; done = 1; next }
      print }
    END { if (!done) print ENVIRON["WANT"] }' "$_file" > "$_tmp" \
    && cat "$_tmp" > "$_file" || { rm -f "$_tmp"; return 1; }
  rm -f "$_tmp"
}
# Append LINE to FILE on its own line, even when FILE lacks a trailing newline.
append_known_host() {
  [ -z "$(tail -c 1 "$1" 2>/dev/null)" ] || printf '\n' >> "$1"
  printf '%s\n' "$2" >> "$1"
}
# --- tailnet helpers end

is_tailnet_host "$VPS_HOST" || die "$VPS_HOST is not a Tailscale address. Alan's Way connects over your Tailscale network only. On the VPS run 'tailscale ip -4' and use that 100.x.y.z address (or its name ending in .ts.net), then re-run this command."

TS=/Applications/Tailscale.app/Contents/MacOS/Tailscale
[ -x "$TS" ] || TS="$(command -v tailscale || true)"
MAC_IP="$([ -n "$TS" ] && "$TS" ip -4 2>/dev/null | head -1 || true)"
[ -n "$MAC_IP" ] || die "Tailscale is not connected on this Mac. Install it from https://tailscale.com/download, sign in with the same account as your VPS, then re-run this command."
is_tailnet_ip "$VPS_HOST" || "$TS" ip -4 "$VPS_HOST" >/dev/null 2>&1 \
  || die "$VPS_HOST is not on your tailnet. Check the name with 'tailscale status', or use the VPS's 100.x.y.z address, then re-run this command."

nc -z -G 2 127.0.0.1 22 >/dev/null 2>&1 \
  || die "Remote Login is off. Turn it on in System Settings → General → Sharing → Remote Login, then re-run this command."

if [ "$SKIP_INSTALL" = 0 ]; then
  curl -fsSL "$INSTALL_URL" | ALANS_WAY_SKIP_CONNECT=1 sh || die "installing the app failed (see above)"
fi

mkdir -p "$HOME/.ssh"
chmod 700 "$HOME/.ssh"
touch "$HOME/.ssh/authorized_keys" "$HOME/.ssh/known_hosts"
chmod 600 "$HOME/.ssh/authorized_keys"

PINNED="$(ssh-keygen -F "$VPS_HOST" -f "$HOME/.ssh/known_hosts" 2>/dev/null | grep -v '^#' || true)"
if [ -z "$PINNED" ]; then
  append_known_host "$HOME/.ssh/known_hosts" "$VPS_HOST $VPS_HOST_KEY"
  say "connect-mac: pinned the VPS host key for $VPS_HOST"
elif printf '%s\n' "$PINNED" | grep -qF "$VPS_HOST_KEY"; then
  say "connect-mac: the VPS host key for $VPS_HOST was already pinned"
else
  die "this Mac already has a different host key for $VPS_HOST. If the VPS was rebuilt, remove the old one with: ssh-keygen -R $VPS_HOST — then re-run."
fi

install_tailnet_key "$HOME/.ssh/authorized_keys" "$VPS_KEY"
chmod 600 "$HOME/.ssh/authorized_keys"
say "connect-mac: the VPS key can log in to this Mac, from your tailnet only"

[ -f "$HOME/.ssh/id_ed25519" ] || ssh-keygen -q -t ed25519 -N '' -f "$HOME/.ssh/id_ed25519"
MAC_HOST_KEY="$(cut -d' ' -f1,2 /etc/ssh/ssh_host_ed25519_key.pub 2>/dev/null || true)"
[ -n "$MAC_HOST_KEY" ] || MAC_HOST_KEY="$(ssh-keyscan -t ed25519 127.0.0.1 2>/dev/null | awk '{print $2" "$3; exit}')"
[ -n "$MAC_HOST_KEY" ] || die "could not read this Mac's SSH host key"

say ""
say "===== Copy everything between these lines and send it to your agent ====="
say "MAC_SSH=$(whoami)@$MAC_IP"
say "MAC_TZ=$(readlink /etc/localtime | sed 's#.*zoneinfo/##')"
say "MAC_HOST_KEY=$MAC_HOST_KEY"
say "MAC_KEY=$(cut -d' ' -f1,2 "$HOME/.ssh/id_ed25519.pub") $(whoami)@mac"
say "===== end ====="
