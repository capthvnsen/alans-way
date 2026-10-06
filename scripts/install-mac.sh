#!/bin/sh
# install-mac.sh — build and install (or upgrade) the Alan's Way Mac app.
#
#   curl -fsSL https://openalan.com/install-mac | sh
#
# Clones or fast-forwards the repo into $ALANS_WAY_DIR (default ~/alans-way),
# or downloads it as a tarball when git is not installed (Node is fetched into
# ~/.alans-way/node the same way), builds the app locally (so macOS does not quarantine it), replaces
# /Applications/alans-way-localapp.app and opens it. Sign-ins and settings live
# outside the bundle and survive upgrades. Safe to re-run.
set -eu

REPO_URL="https://github.com/capthvnsen/alans-way"
DIR="${ALANS_WAY_DIR:-$HOME/alans-way}"
APP_NAME="alans-way-localapp"
DEST="/Applications/$APP_NAME.app"

say() { printf '%s\n' "$*"; }
die() { printf 'install-mac: %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = Darwin ] || die "this installs the Mac app; run it on macOS"
[ "$(uname -m)" = arm64 ] || die "Apple Silicon only for now (uname -m printed $(uname -m))"

# A fresh Mac has neither git nor Node. Node is only needed to build, so fetch
# an official build (checksum-verified) into a private folder rather than
# asking the user to install a toolchain.
NODE_DIR="$HOME/.alans-way/node"
node_ok() { command -v node >/dev/null && command -v npm >/dev/null && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ]; }
if ! node_ok; then
  [ -x "$NODE_DIR/bin/node" ] || {
    say "Downloading Node 22 for the build (into $NODE_DIR)"
    BASE="https://nodejs.org/dist/latest-v22.x"
    SUMS="$(curl -fsSL "$BASE/SHASUMS256.txt")" || die "could not reach nodejs.org"
    LINE="$(printf '%s\n' "$SUMS" | grep -E ' node-v22\.[0-9.]+-darwin-arm64\.tar\.gz$' | head -1)"
    [ -n "$LINE" ] || die "no Node 22 build for Apple Silicon listed at $BASE"
    TARBALL="${LINE##* }"; TMP="$(mktemp -d)"
    curl -fsSL "$BASE/$TARBALL" -o "$TMP/$TARBALL" || die "Node download failed"
    [ "$(shasum -a 256 "$TMP/$TARBALL" | cut -d' ' -f1)" = "${LINE%% *}" ] || die "Node download failed its checksum"
    rm -rf "$NODE_DIR"; mkdir -p "$NODE_DIR"
    tar -xzf "$TMP/$TARBALL" -C "$NODE_DIR" --strip-components 1
    rm -rf "$TMP"
  }
  PATH="$NODE_DIR/bin:$PATH"; export PATH
fi

if [ -d "$DIR/.git" ] && command -v git >/dev/null && git --version >/dev/null 2>&1; then
  say "Updating $DIR"
  git -C "$DIR" pull --ff-only -q || die "could not fast-forward $DIR (local changes?)"
  say "Version $(git -C "$DIR" rev-parse --short HEAD)"
elif [ ! -e "$DIR" ] && command -v git >/dev/null && git --version >/dev/null 2>&1; then
  say "Cloning into $DIR"
  git clone -q "$REPO_URL" "$DIR"
  say "Version $(git -C "$DIR" rev-parse --short HEAD)"
else
  # No usable git (macOS ships a stub that only offers the developer tools):
  # take the source as a tarball, which every Mac can unpack.
  [ ! -e "$DIR" ] || [ -f "$DIR/.alans-way-tarball" ] \
    || die "$DIR exists but is not a checkout this script made — move it or set ALANS_WAY_DIR"
  say "Downloading the source into $DIR"
  rm -rf "$DIR.new"; mkdir -p "$DIR.new"
  curl -fsSL "$REPO_URL/archive/refs/heads/main.tar.gz" | tar -xz -C "$DIR.new" --strip-components 1 \
    || die "could not download the source"
  touch "$DIR.new/.alans-way-tarball"
  rm -rf "$DIR"; mv "$DIR.new" "$DIR"
fi

cd "$DIR/desktop"
say "Installing dependencies"
npm ci --no-audit --no-fund --loglevel=error >/dev/null
say "Building the app"
npm run package:mac --silent -- --dir >/dev/null 2>&1 || npm run package:mac -- --dir
BUILT="$DIR/desktop/dist/mac-arm64/$APP_NAME.app"
[ -d "$BUILT" ] || die "build finished but $BUILT is missing"

if pgrep -f "$DEST/Contents/MacOS/" >/dev/null 2>&1; then
  say "Quitting the running app"
  osascript -e "quit app \"$APP_NAME\"" >/dev/null 2>&1 || true
  i=0
  while pgrep -f "$DEST/Contents/MacOS/" >/dev/null 2>&1 && [ "$i" -lt 15 ]; do sleep 1; i=$((i + 1)); done
  pkill -f "$DEST/Contents/MacOS/" 2>/dev/null || true
  sleep 1
fi

say "Installing to $DEST"
rm -rf "$DEST.new"
ditto "$BUILT" "$DEST.new"
rm -rf "$DEST"
mv "$DEST.new" "$DEST"
open "$DEST"

CONN="$HOME/Library/Application Support/Hermes Workspace/connection.json"
i=0
while [ "$i" -lt 30 ]; do
  if [ -f "$CONN" ] && STATUS="$(node -e '
    const c = require(process.argv[1]);
    fetch(c.url + "/v1/status", { headers: { Authorization: "Bearer " + c.token } })
      .then((r) => r.json()).then((s) => { if (!s.version) process.exit(1); console.log(s.host + " " + s.version); })
      .catch(() => process.exit(1));' "$CONN" 2>/dev/null)"; then
    say "install-mac: running — local browser API answers ($STATUS)"
    exit 0
  fi
  sleep 1; i=$((i + 1))
done
die "the app was installed but its local API did not answer within 30s — open $DEST and check it starts"
