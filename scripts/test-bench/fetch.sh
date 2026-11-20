#!/bin/sh
# Mac side. Copy the bench's credentials file from the VM to a 0600 file under a bench directory here. The file's
# contents never pass through the terminal: ssh writes them straight into the file.
#   scripts/test-bench/fetch.sh <ssh-target> [--user hermes-bench] [--remote-file <path>] [--dest <dir>]
# The ssh login needs `sudo -n -u <bench user> cat <that file>` on the VM (one sudoers line for exactly that command).
set -eu
TARGET=${1:?usage: fetch.sh <ssh-target> [--user U] [--remote-file F] [--dest D]}; shift
BENCH_USER=hermes-bench; REMOTE_FILE=; DEST=${ALANS_WAY_BENCH_DIR:-$HOME/.alans-way-test-bench}
while [ $# -gt 0 ]; do
  case $1 in
    --user) BENCH_USER=${2:?}; shift ;;
    --remote-file) REMOTE_FILE=${2:?}; shift ;;
    --dest) DEST=${2:?}; shift ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
  shift
done
[ -n "$REMOTE_FILE" ] || REMOTE_FILE="~$BENCH_USER/bench-credentials.json"
case $BENCH_USER$REMOTE_FILE in *[!A-Za-z0-9_./~-]*) echo "refused: user and path may only hold letters, digits and _ . / -" >&2; exit 2 ;; esac
case $BENCH_USER in hermes-bench|hermes-bench-[a-z0-9]*) ;; *) echo "refused: not a bench user name" >&2; exit 2 ;; esac
umask 077
mkdir -p "$DEST"; chmod 700 "$DEST"
TMP=$DEST/.fetch.$$
trap 'rm -f "$TMP"' EXIT
ssh -o BatchMode=yes -o ClearAllForwardings=yes "$TARGET" "sudo -n -u $BENCH_USER cat $REMOTE_FILE" > "$TMP"
node -e '
const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
for (const k of ["gateway_url", "api_url", "username", "password", "api_key"]) if (typeof j[k] !== "string" || !j[k]) { console.error("the fetched file has no " + k); process.exit(1); }
if (j.marker !== "alans-way-test-bench") { console.error("the fetched file is not a bench credentials file"); process.exit(1); }' "$TMP"
chmod 600 "$TMP"
mv "$TMP" "$DEST/credentials.json"
echo "saved: $DEST/credentials.json (mode 0600; contents not shown)"
echo "next: tunnel.sh start <ssh-target>, then: node desktop/test/bench/run.cjs --config $DEST/credentials.json"
