#!/bin/sh
# install-mac.sh — install (or upgrade) the Alan's Workspace Mac app.
#
#   curl -fsSL https://openalan.com/install-mac | sh
#
# Downloads the latest signed and notarized stable release and replaces
# /Applications/alans-way-localapp.app using the same rename swap as before.
# ALANS_WAY_BUILD_FROM_SOURCE=1 instead clones or fast-forwards the repo into
# $ALANS_WAY_DIR (default ~/alans-way), or downloads it as a tarball when git is
# not installed (Node is fetched into ~/.alans-way/node the same way), and builds
# the app locally. Machines without a published release asset use that source
# build automatically. Sign-ins and settings live outside the bundle and survive
# upgrades. Safe to re-run.
set -eu

REPO_URL="https://github.com/capthvnsen/alans-way"
API_URL="https://api.github.com/repos/capthvnsen/alans-way"
APP_NAME="alans-way-localapp"
BUNDLE_ID="app.alans-way.localapp"
DIR="${ALANS_WAY_DIR:-$HOME/alans-way}"
DEST="${ALANS_WAY_APP_DEST:-/Applications/$APP_NAME.app}"
TMP=""
MOUNT=""
SOURCE_APP=""

say() { printf '%s\n' "$*"; }
die() { printf 'install-mac: %s\n' "$*" >&2; exit 1; }
make_tmp() { [ -n "$TMP" ] || TMP="$(mktemp -d)"; }
cleanup() {
  [ -z "$MOUNT" ] || hdiutil detach -quiet "$MOUNT" >/dev/null 2>&1 || true
  [ -z "$TMP" ] || rm -rf "$TMP"
  rm -rf "$DEST.new" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

want_source_build() {
  case "${ALANS_WAY_BUILD_FROM_SOURCE:-}" in
    1|yes|YES|true|TRUE) return 0 ;;
  esac
  return 1
}

[ "$(uname -s)" = Darwin ] || die "this installs the Mac app; run it on macOS"
ARCH="$(uname -m)"

build_source() {
  # A fresh Mac has neither git nor Node. Node is only needed to build, so fetch
  # an official build (checksum-verified) into a private folder rather than
  # asking the user to install a toolchain.
  NODE_DIR="$HOME/.alans-way/node"
  node_ok() { command -v node >/dev/null && command -v npm >/dev/null && node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 12) ? 0 : 1)'; }
  if ! node_ok; then
    [ -x "$NODE_DIR/bin/node" ] || {
      say "Downloading Node 22 for the build (into $NODE_DIR)"
      BASE="https://nodejs.org/dist/latest-v22.x"
      SUMS="$(curl -fsSL "$BASE/SHASUMS256.txt")" || die "could not reach nodejs.org"
      NODE_ARCH=arm64
      [ "$ARCH" != x86_64 ] || NODE_ARCH=x64
      LINE="$(printf '%s\n' "$SUMS" | grep -E " node-v22\.[0-9.]+-darwin-$NODE_ARCH\.tar\.gz$" | head -1)"
      [ -n "$LINE" ] || die "no Node 22 build for this Mac listed at $BASE"
      TARBALL="${LINE##* }"; make_tmp
      curl -fsSL "$BASE/$TARBALL" -o "$TMP/$TARBALL" || die "Node download failed"
      [ "$(shasum -a 256 "$TMP/$TARBALL" | cut -d' ' -f1)" = "${LINE%% *}" ] || die "Node download failed its checksum"
      rm -rf "$NODE_DIR"; mkdir -p "$NODE_DIR"
      tar -xzf "$TMP/$TARBALL" -C "$NODE_DIR" --strip-components 1
      rm -f "$TMP/$TARBALL"
    }
    PATH="$NODE_DIR/bin:$PATH"; export PATH
  fi

  # On a Mac without the Command Line Tools, running git opens Apple's install
  # dialog, so ask xcode-select first and take the tarball path instead.
  git_ok() { command -v git >/dev/null && xcode-select -p >/dev/null 2>&1 && git --version >/dev/null 2>&1; }

  if [ -d "$DIR/.git" ] && git_ok; then
    say "Updating $DIR"
    git -C "$DIR" pull --ff-only -q || die "could not fast-forward $DIR (local changes?)"
    say "Version $(git -C "$DIR" rev-parse --short HEAD)"
  elif [ ! -e "$DIR" ] && git_ok; then
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
  ARCH_FLAG="--arm64"
  [ "$ARCH" != x86_64 ] || ARCH_FLAG="--x64"
  npm run package:mac --silent -- --dir "$ARCH_FLAG" >/dev/null 2>&1 || npm run package:mac -- --dir "$ARCH_FLAG"
  BUILT=""
  for CANDIDATE in \
    "$DIR/desktop/dist/mac-arm64/$APP_NAME.app" \
    "$DIR/desktop/dist/mac-x64/$APP_NAME.app" \
    "$DIR/desktop/dist/mac/$APP_NAME.app"; do
    [ ! -d "$CANDIDATE" ] || { BUILT="$CANDIDATE"; break; }
  done
  [ -n "$BUILT" ] || die "build finished but the app bundle is missing"
  SOURCE_APP="$BUILT"
}

download_release() {
  say 'Downloading the latest stable release'
  make_tmp
  RELEASE_JSON="$TMP/release.json"
  curl -fsSL -H 'Accept: application/vnd.github+json' "$API_URL/releases/latest" -o "$RELEASE_JSON" \
    || die 'could not check the latest stable release — check the internet connection and try again'
  TAG="$(sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\(v[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)".*/\1/p' "$RELEASE_JSON" | head -1)"
  [ -n "$TAG" ] || die 'GitHub did not return a stable release tag — try again later or set ALANS_WAY_BUILD_FROM_SOURCE=1'

  ASSET="OpenAlan-mac.dmg"
  BASE="$REPO_URL/releases/download/$TAG"
  DMG="$TMP/$ASSET"
  SUMS="$TMP/$ASSET.sha512"
  curl -fsSL "$BASE/$ASSET" -o "$DMG" \
    || die "could not download $ASSET from the latest stable release — nothing was installed"
  curl -fsSL "$BASE/$ASSET.sha512" -o "$SUMS" \
    || die 'the release did not provide its checksum — the download was not installed'
  WANT="$(awk 'NF { print $1; exit }' "$SUMS")"
  GOT="$(shasum -a 512 "$DMG" | cut -d' ' -f1)"
  [ "$(printf '%s' "$WANT" | tr -d '[:space:]' | wc -c | tr -d '[:space:]')" -eq 128 ] && [ "$WANT" = "$GOT" ] \
    || die 'the downloaded app did not match its checksum — nothing was installed'

  MOUNT="$TMP/mnt"
  mkdir -p "$MOUNT"
  hdiutil attach -nobrowse -readonly -mountpoint "$MOUNT" "$DMG" >/dev/null \
    || die 'the downloaded app image could not be opened — nothing was installed'
  set -- "$MOUNT"/*.app
  [ -d "$1" ] || die 'the downloaded image has no app in it — nothing was installed'
  APP_IN_IMAGE="$1"
  ID="$(defaults read "$APP_IN_IMAGE/Contents/Info" CFBundleIdentifier 2>/dev/null || true)"
  [ "$ID" = "$BUNDLE_ID" ] || die 'the downloaded image holds a different app — nothing was installed'
  codesign --verify --deep --strict "$APP_IN_IMAGE" >/dev/null 2>&1 \
    || die 'the downloaded app failed macOS signature verification — nothing was installed'
  if xcrun stapler validate "$APP_IN_IMAGE" >/dev/null 2>&1; then
    :
  elif spctl --assess --type execute "$APP_IN_IMAGE" >/dev/null 2>&1; then
    :
  else
    die 'the downloaded app failed Gatekeeper/notarization validation — nothing was installed'
  fi
  SOURCE_APP="$APP_IN_IMAGE"
}

if want_source_build; then
  say 'Building from source because ALANS_WAY_BUILD_FROM_SOURCE is set'
  build_source
elif [ "$ARCH" != arm64 ]; then
  say "No published Mac release is available for this Mac ($ARCH); building from source instead."
  build_source
else
  download_release
fi

if pgrep -f "$DEST/Contents/MacOS/" >/dev/null 2>&1; then
  say "Quitting the running app"
  osascript -e "quit app \"$APP_NAME\"" >/dev/null 2>&1 || true
  i=0
  while pgrep -f "$DEST/Contents/MacOS/" >/dev/null 2>&1 && [ "$i" -lt 15 ]; do sleep 1; i=$((i + 1)); done
  pkill -f "$DEST/Contents/MacOS/" 2>/dev/null || true
  sleep 1
fi

say "Installing to $DEST"
# Swap by rename so the old app is only deleted once the new one is in place.
# A run killed mid-swap leaves the old app only at $DEST.old; put it back first.
[ -e "$DEST" ] || [ ! -e "$DEST.old" ] || mv "$DEST.old" "$DEST"
rm -rf "$DEST.new" "$DEST.old"
ditto "$SOURCE_APP" "$DEST.new"
[ -f "$DEST.new/Contents/Info.plist" ] && [ -x "$DEST.new/Contents/MacOS/$APP_NAME" ] \
  || { rm -rf "$DEST.new"; die "the copied app is incomplete; the installed app was left as it was"; }
if [ -e "$DEST" ]; then
  mv "$DEST" "$DEST.old" || { rm -rf "$DEST.new"; die "could not move the installed app aside; it was left as it was"; }
fi
mv "$DEST.new" "$DEST" || {
  [ ! -e "$DEST.old" ] || mv "$DEST.old" "$DEST"
  die "could not put the new app in place; the previous app was restored"
}
rm -rf "$DEST.old"
open "$DEST"

CONN="$HOME/Library/Application Support/Hermes Workspace/connection.json"
json_field() { printf '%s' "$2" | sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" | head -1; }
i=0
while [ "$i" -lt 30 ]; do
  if [ -f "$CONN" ]; then
    CONN_JSON="$(tr -d '\n' < "$CONN" 2>/dev/null || true)"
    CONN_URL="$(json_field url "$CONN_JSON")"
    CONN_TOKEN="$(json_field token "$CONN_JSON")"
    if [ -n "$CONN_URL" ] && [ -n "$CONN_TOKEN" ]       && STATUS="$(curl -fsSL --max-time 3 -H "Authorization: Bearer $CONN_TOKEN" "$CONN_URL/v1/status" 2>/dev/null)"       && printf '%s' "$STATUS" | grep -q '"version"'; then
      VERSION="$(json_field version "$STATUS")"
      HOST="$(json_field host "$STATUS")"
      say "install-mac: running — local browser API answers ($HOST $VERSION)"
      say 'install-mac: provision separate broker/bot accounts before connecting agents; see desktop/docs/bot-auth.md'
      exit 0
    fi
  fi
  sleep 1; i=$((i + 1))
done
die "the app was installed but its local API did not answer within 30s — open $DEST and check it starts"
