#!/bin/sh
# webapp-signin.sh — turn on Hermes Desktop sign-in on your own Hermes server, reachable
# only from your tailnet. Run it on the server, as the OS user that runs Hermes:
#
#   sh webapp-signin.sh [--user NAME] [--port PORT]
#
#   --user NAME   sign-in username (default hermes)
#   --port PORT   the Webapp's loopback port (default 9120)
#
# It keeps the Webapp on 127.0.0.1, publishes it at https://<server>.<tailnet>.ts.net
# with Tailscale Serve (never Funnel), turns on username and password sign-in, and makes
# a new random password and signing secret. The password goes only into a private file,
# $HERMES_HOME/webapp-signin.txt (mode 600). Nothing secret is printed or passed on a
# command line. Re-running makes a new password and secret, which signs every browser out.
# It never restarts the gateway; it tells you when to.
set -eu

USER_NAME="hermes" PORT="9120"
HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
SUDO="${SUDO-sudo}"
[ "$(id -u)" = 0 ] && SUDO=""

die() { printf 'webapp-signin: %s\n' "$*" >&2; exit 1; }
say() { printf '%s\n' "$*"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --user) USER_NAME="${2:-}"; shift 2;;
    --port) PORT="${2:-}"; shift 2;;
    -h|--help) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0;;
    *) die "unknown option: $1";;
  esac
done
case "$USER_NAME" in ''|*[!A-Za-z0-9._-]*) die "--user takes letters, digits, dot, dash or underscore.";; esac
case "$PORT" in ''|*[!0-9]*) die "--port takes a number.";; esac

for tool in tailscale hermes python3; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool is not installed or not on PATH."
done
[ -d "$HERMES_HOME" ] || die "No Hermes home at $HERMES_HOME. Set HERMES_HOME to the profile you run."

NAME=$(tailscale status --json | python3 -c 'import json, sys; print((json.load(sys.stdin).get("Self") or {}).get("DNSName", "").rstrip(".").lower())') \
  || die "tailscale status failed. Run: sudo tailscale up"
case "$NAME" in
  *[!a-z0-9.-]*|'') die "This server has no Tailscale name. Turn on MagicDNS in the Tailscale admin console.";;
  *.ts.net) ;;
  *) die "This server's Tailscale name ($NAME) is not a .ts.net name. Turn on MagicDNS and HTTPS Certificates.";;
esac
ADDRESS="https://$NAME"

funnel_off() {
  # shortcut: matches the "(Funnel on)" marker `tailscale funnel status` prints; recheck if Tailscale changes that text.
  ! $SUDO tailscale funnel status 2>/dev/null | grep -qi 'funnel on'
}
funnel_off || die "Tailscale Funnel is on, which puts this server on the public internet. Run: sudo tailscale funnel reset"

# The password, its hash and the signing secret never leave this process except
# into two files only this user can read.
umask 077
HERMES_HOME="$HERMES_HOME" ADDRESS="$ADDRESS" USER_NAME="$USER_NAME" python3 - <<'PY'
import base64, hashlib, os, secrets, tempfile
home = os.environ["HERMES_HOME"]
password = secrets.token_urlsafe(24)  # 32 characters, 192 bits
salt = secrets.token_bytes(16)
dk = hashlib.scrypt(password.encode(), salt=salt, n=2**14, r=8, p=1, dklen=32, maxmem=0)
# The format plugins/dashboard_auth/basic.hash_password writes.
password_hash = f"scrypt${2**14}$8$1${base64.b64encode(salt).decode()}${base64.b64encode(dk).decode()}"
secret = base64.b64encode(secrets.token_bytes(32)).decode()

def write_private(path, text):
    fd, tmp = tempfile.mkstemp(dir=home, prefix=".webapp-signin-")
    with os.fdopen(fd, "w") as f:
        f.write(text)
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)

env_path = os.path.join(home, ".env")
prefix = "HERMES_DASHBOARD_BASIC_AUTH_"
replaced = ("PASSWORD", "PASSWORD_HASH", "SECRET")
kept = []
if os.path.exists(env_path):
    with open(env_path) as f:
        kept = [line for line in f.read().splitlines()
                if not any(line.strip().removeprefix("export ").startswith(f"{prefix}{key}=") for key in replaced)]
write_private(env_path, "\n".join(kept + [f"{prefix}PASSWORD_HASH={password_hash}", f"{prefix}SECRET={secret}"]) + "\n")
write_private(os.path.join(home, "webapp-signin.txt"),
              f"Hermes Desktop sign-in\naddress: {os.environ['ADDRESS']}\nusername: {os.environ['USER_NAME']}\npassword: {password}\n")
PY

hermes config set webapp.enabled true >/dev/null
hermes config set webapp.host 127.0.0.1 >/dev/null
hermes config set webapp.port "$PORT" >/dev/null
hermes config set webapp.public_url "$ADDRESS" >/dev/null
hermes config set dashboard.basic_auth.username "$USER_NAME" >/dev/null

$SUDO tailscale serve --bg --https=443 "http://127.0.0.1:$PORT" >/dev/null || die "tailscale serve failed. Check that HTTPS Certificates is on in the Tailscale admin console."
funnel_off || die "Tailscale Funnel turned on. Run: sudo tailscale funnel reset"
hermes webapp --build-only >/dev/null || die "Building the Webapp failed. Run hermes webapp --build-only to see why."

say "Hermes Desktop sign-in is set up for $ADDRESS (username $USER_NAME)."
say "The password is in $HERMES_HOME/webapp-signin.txt. Only this user can read it."
say ""
say "Next:"
say "  1. Lock port 443 on this server to your own devices in the Tailscale admin console (Access controls)."
say "  2. When no chat is running, restart the gateway: hermes gateway restart"
say "  3. Check: hermes webapp --status"
say "  4. From your own computer, read the password over your own SSH session:"
say "       ssh <this server> cat $HERMES_HOME/webapp-signin.txt"
say "     or show it as a QR code here: qrencode -t ansiutf8 < $HERMES_HOME/webapp-signin.txt"
say "     Put it in Workspace: Settings > Chat surface > Hermes Desktop. Never paste it into a chat."
