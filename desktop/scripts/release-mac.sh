#!/bin/sh
# Local private-beta release for Apple Silicon Macs. Signs with the login
# keychain's Developer ID Application identity (hardened runtime), notarizes
# and staples the app and the dmg with a notarytool keychain profile, then
# verifies. Builds into desktop/dist only: nothing is tagged or uploaded.
# No secret is read, printed or stored here; notarytool reads its own profile.
#
# Usage: release-mac.sh [--sign-only]   (--sign-only skips notarization)
# Env:   NOTARY_PROFILE (default alans-way-notary), CSC_NAME to pick an identity
set -eu

PROFILE=${NOTARY_PROFILE:-alans-way-notary}
SIGN_ONLY=0
case "${1:-}" in
  --sign-only) SIGN_ONLY=1 ;;
  '') ;;
  *) printf 'usage: %s [--sign-only]\n' "$0" >&2; exit 2 ;;
esac

die() { printf 'error: %s\n' "$*" >&2; exit 1; }
cd "$(dirname "$0")/.."

[ "$(uname -s)-$(uname -m)" = Darwin-arm64 ] || die "run this on an Apple Silicon Mac"

# electron-builder wants the name without the "Developer ID Application: " prefix.
if [ -z "${CSC_NAME:-}" ]; then
  NAMES=$(security find-identity -v -p codesigning | sed -n 's/.*"Developer ID Application: \(.*\)"$/\1/p')
  [ -n "$NAMES" ] || die "no Developer ID Application identity in the keychain"
  [ "$(printf '%s\n' "$NAMES" | wc -l | tr -d ' ')" = 1 ] || die "several Developer ID identities; set CSC_NAME to one of: $NAMES"
  CSC_NAME=$NAMES
fi
IDENTITY="Developer ID Application: $CSC_NAME"
printf 'Identity: %s\n' "$IDENTITY"

if [ "$SIGN_ONLY" = 0 ] && ! xcrun notarytool history --keychain-profile "$PROFILE" >/dev/null 2>&1; then
  TEAM_ID=$(printf '%s' "$CSC_NAME" | sed -n 's/.*(\([A-Z0-9]*\))$/\1/p')
  cat >&2 <<EOF
No notarytool profile named "$PROFILE" in the keychain. One-time setup:

  xcrun notarytool store-credentials "$PROFILE" --apple-id "<your Apple ID email>" --team-id "$TEAM_ID"

It prompts for an app-specific password (make one at account.apple.com ->
Sign-In and Security -> App-Specific Passwords). Then rerun this script.
EOF
  exit 3
fi

# The CI secrets path must not mix with the local keychain path.
unset CSC_LINK CSC_KEY_PASSWORD APPLE_ID APPLE_APP_SPECIFIC_PASSWORD APPLE_TEAM_ID
export CSC_NAME
[ "$SIGN_ONLY" = 1 ] || export APPLE_KEYCHAIN_PROFILE="$PROFILE"

rm -rf dist
npm ci --no-audit --no-fund
npm run package:mac

APP=dist/mac-arm64/alans-way-localapp.app
DMG=dist/OpenAlan-mac.dmg
codesign --sign "$IDENTITY" --timestamp "$DMG"
if [ "$SIGN_ONLY" = 0 ]; then
  xcrun notarytool submit "$DMG" --keychain-profile "$PROFILE" --wait
  xcrun stapler staple "$DMG"
fi
# shortcut: latest-mac.yml keeps the pre-staple dmg hash; electron-updater on macOS reads only the zip entry.
shasum -a 512 "$DMG" | cut -d' ' -f1 > "$DMG.sha512"

codesign --verify --deep --strict --verbose=2 "$APP"
codesign -dv --verbose=2 "$APP" 2>&1 | grep -E '^(Authority=Developer ID Application|TeamIdentifier|Runtime Version|Timestamp)'
codesign --verify --verbose=2 "$DMG"
if [ "$SIGN_ONLY" = 1 ]; then
  printf '\nSigned only (not notarized): Gatekeeper will reject this build. Done: %s\n' "$DMG"
  exit 0
fi
spctl --assess --type execute --verbose=4 "$APP"
spctl --assess --type open --context context:primary-signature --verbose=4 "$DMG"
xcrun stapler validate "$APP"
xcrun stapler validate "$DMG"
printf '\nReady: %s\n' "$DMG"
