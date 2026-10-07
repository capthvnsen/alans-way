#!/bin/sh
# connect-linux.sh: connect this Linux computer to the VPS that runs your
# Hermes gateway. Your setup agent prints this command with the VPS's address
# and public keys filled in:
#
#   curl -fsSL https://raw.githubusercontent.com/capthvnsen/alans-way/main/scripts/connect-linux.sh | sh -s -- \
#     --vps root@<vps-tailscale-ip> \
#     --vps-host-key 'ssh-ed25519 AAAA...' \
#     --vps-key 'ssh-ed25519 AAAA... root@vps'
#
# It checks Tailscale and the systemd SSH server, builds and installs the
# Alan's Way app (skip with --skip-install), lets that VPS key log in to this
# computer (only from your Tailscale network), pins the VPS host key so this
# computer can reach the VPS without a trust-on-first-use prompt, and prints
# the values the agent needs next. The VPS address must be a Tailscale name or
# IP. Only public keys are printed. Safe to re-run.
set -eu

REPO_URL="https://github.com/capthvnsen/alans-way"
DIR="${ALANS_WAY_DIR:-$HOME/alans-way}"
APP_NAME="alans-way-localapp"
DEST="$HOME/.local/share/$APP_NAME"
VPS="" VPS_HOST_KEY="" VPS_KEY="" SKIP_INSTALL=0

die() { printf 'connect-linux: %s\n' "$*" >&2; exit 1; }
say() { printf '%s\n' "$*"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --vps) VPS="${2:-}"; shift 2;;
    --vps-host-key) VPS_HOST_KEY="${2:-}"; shift 2;;
    --vps-key) VPS_KEY="${2:-}"; shift 2;;
    --skip-install) SKIP_INSTALL=1; shift;;
    -h|--help) sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 0;;
    *) die "unknown arg: $1";;
  esac
done

[ "$(uname -s)" = Linux ] || die "run this on your Linux computer"
[ "$(uname -m)" = x86_64 ] || die "Alan's Way for Linux only comes as a 64-bit Intel/AMD (x86_64) build, and this computer is $(uname -m)."
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
# tightens an old install and never duplicates the line.
FROM_TAILNET='from="100.64.0.0/10,fd7a:115c:a1e0::/48"'
install_tailnet_key() {
  _file="$1"; _key="$2"; _tmp="$_file.tmp.$$"
  _blob="$(printf '%s' "$_key" | awk '{print $2}')"
  awk -v blob="$_blob" -v want="$FROM_TAILNET $_key" '
    { hit = 0; n = split($0, f, " "); for (i = 1; i <= n; i++) if (f[i] == blob) hit = 1
      if (hit) { if (!done) print want; done = 1; next }
      print }
    END { if (!done) print want }' "$_file" > "$_tmp" && cat "$_tmp" > "$_file"
  rm -f "$_tmp"
}
# Append LINE to FILE on its own line, even when FILE lacks a trailing newline.
append_known_host() {
  [ -z "$(tail -c 1 "$1" 2>/dev/null)" ] || printf '\n' >> "$1"
  printf '%s\n' "$2" >> "$1"
}
# --- tailnet helpers end

is_tailnet_host "$VPS_HOST" || die "$VPS_HOST is not a Tailscale address. Alan's Way connects over your Tailscale network only. On the VPS run 'tailscale ip -4' and use that 100.x.y.z address (or its name ending in .ts.net), then re-run this command."

TS="$(command -v tailscale || true)"
PC_IP="$([ -n "$TS" ] && "$TS" ip -4 2>/dev/null | head -1 || true)"
[ -n "$PC_IP" ] || die "Tailscale is not connected on this computer. Install it from https://tailscale.com/download, run 'sudo tailscale up' with the same account as your VPS, then re-run this command."
is_tailnet_ip "$VPS_HOST" || "$TS" ip -4 "$VPS_HOST" >/dev/null 2>&1 \
  || die "$VPS_HOST is not on your tailnet. Check the name with 'tailscale status', or use the VPS's 100.x.y.z address, then re-run this command."

# The SSH server. Ubuntu 22.10 and later start sshd on demand from ssh.socket,
# so a stopped ssh.service can still be answering; ask the port first.
sshd_answers() { [ -n "$(ssh-keyscan -T 3 127.0.0.1 2>/dev/null)" ]; }
if ! sshd_answers; then
  command -v systemctl >/dev/null 2>&1 || die "this script needs systemd; start your SSH server by hand, then re-run with the same arguments"
  SSH_UNIT=""
  for unit in ssh.socket ssh.service sshd.service; do
    systemctl list-unit-files "$unit" 2>/dev/null | grep -q "^$unit" && { SSH_UNIT="$unit"; break; }
  done
  if [ -z "$SSH_UNIT" ]; then
    if command -v apt-get >/dev/null 2>&1; then HINT="sudo apt-get install -y openssh-server"
    elif command -v dnf >/dev/null 2>&1; then HINT="sudo dnf install -y openssh-server"
    elif command -v pacman >/dev/null 2>&1; then HINT="sudo pacman -S --noconfirm openssh"
    else HINT="install your distribution's OpenSSH server package"; fi
    die "no SSH server is installed. Run: $HINT   then re-run this command."
  fi
  sudo -n systemctl enable --now "$SSH_UNIT" >/dev/null 2>&1 \
    || die "the SSH server is not running. Run: sudo systemctl enable --now $SSH_UNIT   then re-run this command."
  sshd_answers || die "the SSH server was started but is not answering on port 22. Check its configuration."
fi

if [ "$SKIP_INSTALL" = 0 ]; then
  command -v node >/dev/null && command -v npm >/dev/null \
    && node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 12) ? 0 : 1)' \
    || die "Node 22.12 or newer is needed to build the app. Install it (https://nodejs.org), then re-run, or pass --skip-install if the app is already installed."
  command -v git >/dev/null || die "git is needed to fetch the app source. Install it, then re-run, or pass --skip-install."
  if [ -d "$DIR/.git" ]; then
    say "Updating $DIR"
    git -C "$DIR" pull --ff-only -q || die "could not fast-forward $DIR (local changes?)"
  elif [ ! -e "$DIR" ]; then
    say "Cloning into $DIR"
    git clone -q "$REPO_URL" "$DIR"
  else
    die "$DIR exists but is not a git checkout move it or set ALANS_WAY_DIR"
  fi
  cd "$DIR/desktop"
  say "Installing dependencies"
  npm ci --no-audit --no-fund --loglevel=error >/dev/null
  say "Building the app"
  npm run package:linux --silent -- --dir >/dev/null 2>&1 || npm run package:linux -- --dir
  BUILT="$DIR/desktop/dist/linux-unpacked"
  [ -x "$BUILT/$APP_NAME" ] || die "build finished but $BUILT/$APP_NAME is missing"
  pkill -f "$DEST/$APP_NAME" 2>/dev/null || true
  rm -rf "$DEST.new"; mkdir -p "$(dirname "$DEST")"
  cp -a "$BUILT" "$DEST.new"
  rm -rf "$DEST"; mv "$DEST.new" "$DEST"
  if [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then
    nohup setsid "$DEST/$APP_NAME" >"$DEST.log" 2>&1 &
    sleep 3
    if pgrep -f "$DEST/$APP_NAME" >/dev/null 2>&1; then
      say "connect-linux: started the app"
    else
      say "connect-linux: the app did not stay open. Its output is in $DEST.log. On Ubuntu 24.04 the sandbox can be blocked by AppArmor; to try without it, run: $DEST/$APP_NAME --no-sandbox"
    fi
  else
    say "connect-linux: no desktop session here, so the app was not started. Open it from your desktop: $DEST/$APP_NAME"
  fi
fi

mkdir -p "$HOME/.ssh"
chmod 700 "$HOME/.ssh"
touch "$HOME/.ssh/authorized_keys" "$HOME/.ssh/known_hosts"
chmod 600 "$HOME/.ssh/authorized_keys"

PINNED="$(ssh-keygen -F "$VPS_HOST" -f "$HOME/.ssh/known_hosts" 2>/dev/null | grep -v '^#' || true)"
if [ -z "$PINNED" ]; then
  append_known_host "$HOME/.ssh/known_hosts" "$VPS_HOST $VPS_HOST_KEY"
  say "connect-linux: pinned the VPS host key for $VPS_HOST"
elif printf '%s\n' "$PINNED" | grep -qF "$VPS_HOST_KEY"; then
  say "connect-linux: the VPS host key for $VPS_HOST was already pinned"
else
  die "this computer already has a different host key for $VPS_HOST. If the VPS was rebuilt, remove the old one with: ssh-keygen -R $VPS_HOST and then re-run."
fi

install_tailnet_key "$HOME/.ssh/authorized_keys" "$VPS_KEY"
chmod 600 "$HOME/.ssh/authorized_keys"
say "connect-linux: the VPS key can log in to this computer, from your tailnet only"

[ -f "$HOME/.ssh/id_ed25519" ] || ssh-keygen -q -t ed25519 -N '' -f "$HOME/.ssh/id_ed25519"
PC_HOST_KEY="$(cut -d' ' -f1,2 /etc/ssh/ssh_host_ed25519_key.pub 2>/dev/null || true)"
[ -n "$PC_HOST_KEY" ] || PC_HOST_KEY="$(ssh-keyscan -t ed25519 127.0.0.1 2>/dev/null | awk '{print $2" "$3; exit}')"
[ -n "$PC_HOST_KEY" ] || die "could not read this computer's SSH host key"
TZ_NAME="$(timedatectl show -p Timezone --value 2>/dev/null || readlink /etc/localtime | sed 's#.*zoneinfo/##')"

say ""
say "===== Copy everything between these lines and send it to your agent ====="
say "MAC_SSH=$(whoami)@$PC_IP"
say "MAC_TZ=$TZ_NAME"
say "MAC_HOST_KEY=$PC_HOST_KEY"
say "MAC_KEY=$(cut -d' ' -f1,2 "$HOME/.ssh/id_ed25519.pub") $(whoami)@linux"
say "===== end ====="
say "(The names say MAC_* for connector compatibility: the values describe this computer.)"
