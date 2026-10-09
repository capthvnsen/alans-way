#!/bin/sh
# connect-server.sh — connect this computer to the server that runs your Hermes
# gateway, driven from here. Run it on your Mac or Linux computer:
#
#   curl -fsSL https://raw.githubusercontent.com/capthvnsen/alans-way/main/scripts/connect-server.sh | sh
#
# It asks for the server's SSH address and logs in once with your usual SSH
# password or key. Then it trusts both machines' keys (connect-mac.sh or
# connect-linux.sh here, which also install the app if it is missing), installs
# the alans-way-agents plugin on the server, restarts its gateway and checks SSH
# both ways. The plugin's setup.sh asks its own questions on the server.
#
#   --server user@host   skip the address question
#   -- ARGS              extra setup.sh flags, e.g. -- --profile work
#
# Both machines must be on the same Tailscale network. Safe to re-run.
set -eu

RAW="https://raw.githubusercontent.com/capthvnsen/alans-way/main/scripts"
AGENTS_RAW="https://raw.githubusercontent.com/capthvnsen/alans-way-agents/main"
SERVER="" EXTRA=""

die() { printf 'connect-server: %s\n' "$*" >&2; exit 1; }
say() { printf '%s\n' "$*"; }
q() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }
has_tty() { if (: < /dev/tty) 2>/dev/null; then return 0; fi; return 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --server) SERVER="${2:-}"; shift 2;;
    --) shift; for a in "$@"; do EXTRA="$EXTRA $(q "$a")"; done; break;;
    -h|--help) sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 0;;
    *) die "unknown arg: $1";;
  esac
done

case "$(uname -s)" in
  Darwin) OS=mac APP=/Applications/alans-way-localapp.app;;
  Linux) OS=linux APP="$HOME/.local/share/alans-way-localapp";;
  *) die "run this on your Mac or Linux computer (Windows: use the setup prompt in the README)";;
esac

if [ -z "$SERVER" ]; then
  has_tty || die "no terminal to ask in; pass --server user@host"
  say "Your Hermes server's SSH address on Tailscale, e.g. root@hermes-vps (a .ts.net name or 100.x address)"
  printf 'Server: ' > /dev/tty
  read -r SERVER < /dev/tty || SERVER=""
fi
printf '%s' "$SERVER" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._@:-]*$' || die "bad server address: '$SERVER'"

TMPD="$(mktemp -d)"
SSH="ssh -o ControlMaster=auto -o ControlPath=$TMPD/cm -o ControlPersist=300 -o ConnectTimeout=20"
trap '$SSH -O exit "$SERVER" >/dev/null 2>&1 || true; rm -rf "$TMPD"' EXIT
trap 'exit 130' INT TERM
# Under curl | sh our stdin is the rest of this script, so every child that
# could read stdin gets /dev/null or the terminal instead.

# One login, shared by every later step, so a password is typed at most once.
say "Logging in to $SERVER"
if has_tty; then $SSH "$SERVER" true < /dev/tty; else $SSH -o BatchMode=yes "$SERVER" true < /dev/null; fi \
  || die "could not log in to $SERVER. Check that 'ssh $SERVER' works from this terminal, then re-run."

$SSH "$SERVER" sh -s > "$TMPD/server" <<'EOF' || die "could not read the server's keys"
set -e
mkdir -p ~/.ssh && chmod 700 ~/.ssh
[ -f ~/.ssh/id_ed25519 ] || ssh-keygen -q -t ed25519 -N '' -f ~/.ssh/id_ed25519
TS="$(command -v tailscale || echo /Applications/Tailscale.app/Contents/MacOS/Tailscale)"
echo "VPS_SSH=$(whoami)@$("$TS" ip -4 2>/dev/null | head -1)"
echo "VPS_KEY=$(cut -d' ' -f1,2 ~/.ssh/id_ed25519.pub) $(whoami)@vps"
echo "VPS_HOST_KEY=$(cut -d' ' -f1,2 /etc/ssh/ssh_host_ed25519_key.pub 2>/dev/null || ssh-keyscan -t ed25519 127.0.0.1 2>/dev/null | awk '{print $2" "$3; exit}')"
EOF
val() { sed -n "s/^$1=//p" "$2" | head -1; }
VPS_SSH="$(val VPS_SSH "$TMPD/server")"
case "$VPS_SSH" in *@) die "Tailscale is not connected on the server. Run 'sudo tailscale up' there, sign in with the same account as this computer, then re-run.";; esac

# The connect script prints MAC_* lines meant for pasting to an agent; this
# script reads them itself, so the copy-me block is hidden.
CONNECT=""; [ ! -f "$0" ] || CONNECT="$(cd "$(dirname "$0")" && pwd)/connect-$OS.sh"
[ -f "$CONNECT" ] || { CONNECT="$TMPD/connect-$OS.sh"; curl -fsSL "$RAW/connect-$OS.sh" -o "$CONNECT" || die "could not download connect-$OS.sh"; }
SKIP=""; [ ! -e "$APP" ] || SKIP=--skip-install
ALANS_WAY_SKIP_CONNECT=1 sh "$CONNECT" $SKIP --vps "$VPS_SSH" \
  --vps-host-key "$(val VPS_HOST_KEY "$TMPD/server")" --vps-key "$(val VPS_KEY "$TMPD/server")" < /dev/null \
  | tee "$TMPD/local" | sed '/^===== Copy/,/^===== end/d; /^(The names say/d'
MAC_SSH="$(val MAC_SSH "$TMPD/local")"
[ -n "$MAC_SSH" ] || die "connecting this computer stopped; the reason is above"

TZ_ARG=""; [ -z "$(val MAC_TZ "$TMPD/local")" ] || TZ_ARG=" --timezone $(q "$(val MAC_TZ "$TMPD/local")")"

say ""
say "Installing the Alan's Way Plugin on the server"
# A downloaded setup.sh fetches the plugin itself, pinned to the catalog's
# version when the plugin came from the Hermes catalog.
REMOTE="set -e; d=\$(mktemp -d); trap 'rm -rf \"\$d\"' EXIT
curl -fsSL $AGENTS_RAW/setup.sh -o \"\$d/setup.sh\"
bash \"\$d/setup.sh\" --mac-ssh $(q "$MAC_SSH") --host-os $OS$TZ_ARG \
  --mac-key $(q "$(val MAC_KEY "$TMPD/local")") --mac-host-key $(q "$(val MAC_HOST_KEY "$TMPD/local")") --restart$EXTRA"
# A login shell, so the server's PATH matches what you get when you ssh in.
if has_tty; then $SSH -t "$SERVER" "exec \"\${SHELL:-/bin/sh}\" -lc $(q "$REMOTE")" < /dev/tty
else $SSH "$SERVER" "exec \"\${SHELL:-/bin/sh}\" -lc $(q "$REMOTE")" < /dev/null; fi \
  || die "server setup stopped; the reason is above. Fix it and re-run this command."

say ""
say "Checking SSH both ways"
$SSH "$SERVER" "ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=15 $(q "$MAC_SSH") $(q "test -e $(q "$APP") && echo ok")" < /dev/null 2>/dev/null | grep -qx ok \
  || die "the server cannot log in to this computer as $MAC_SSH. Check Remote Login (Mac) or the SSH server (Linux) is on, then re-run."
ssh -o ControlPath=none -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=15 "$VPS_SSH" true < /dev/null \
  || die "this computer cannot log in to $VPS_SSH without a prompt. If the server uses Tailscale SSH, change its rule from \"check\" to \"accept\" in the Tailscale admin console, then re-run."

say ""
say "Connected. Last steps, in the Alan's Workspace app:"
say "  - Sign in to Telegram with the QR code (phone: Telegram > Settings > Devices > Link Desktop Device)."
[ "$OS" != mac ] || say "  - At this Mac: System Settings > Privacy & Security. Turn on Alan's Workspace (listed as alans-way-localapp) under Accessibility and under Screen Recording."
say "  - Settings > Agent setup: VPS address $VPS_SSH, this computer $MAC_SSH. Click Save addresses, then Test agent path."
