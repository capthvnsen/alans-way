#!/bin/sh
# One-time maintainer setup for release signing. Finds the "Developer ID
# Application" identity in the login keychain, exports only that identity to a
# temporary .p12, reads the Team ID from the certificate, and stores the five
# CI secrets (CSC_LINK, CSC_KEY_PASSWORD, APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD,
# APPLE_TEAM_ID) on the GitHub repo. Secret values are piped to gh over stdin
# so they never appear in argv; only the secret names are printed.
#
# Usage: setup-signing-secrets.sh [--dry-run]
set -eu

REPO=capthvnsen/alans-way
DRY_RUN=0
case "${1:-}" in
  --dry-run) DRY_RUN=1 ;;
  '') ;;
  *) printf 'usage: %s [--dry-run]\n' "$0" >&2; exit 2 ;;
esac

say() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
random_pass() { openssl rand -hex 24; }

command -v security >/dev/null 2>&1 || die "run this on macOS (security not found)"
command -v openssl >/dev/null 2>&1 || die "openssl not found"
command -v gh >/dev/null 2>&1 || die "gh is not installed; install it and run: gh auth login"
gh auth status >/dev/null 2>&1 || die "gh is not logged in; run: gh auth login"

# --- pick the Developer ID Application identity -----------------------------
IDENTITIES=$(security find-identity -v -p codesigning login.keychain 2>/dev/null || true)
MATCHES=$(printf '%s\n' "$IDENTITIES" | sed -n 's/^ *[0-9]*) \([0-9A-Fa-f][0-9A-Fa-f]*\) "\(Developer ID Application: [^"]*\)".*/\1|\2/p')
COUNT=$(printf '%s' "$MATCHES" | grep -c '|' || true)
if [ "$COUNT" -eq 0 ]; then
  die "no \"Developer ID Application\" identity in the login keychain; create one at developer.apple.com -> Certificates -> Developer ID -> Application first"
fi
if [ "$COUNT" -gt 1 ]; then
  say "Several Developer ID Application identities found:"
  printf '%s\n' "$MATCHES" | cut -d'|' -f2- | nl -v 1 -s') ' | sed 's/^/  /'
  printf 'Use which (1-%s)? ' "$COUNT" >&2
  read -r CHOICE
  case "$CHOICE" in ''|*[!0-9]*) die "not a number" ;; esac
  [ "$CHOICE" -ge 1 ] && [ "$CHOICE" -le "$COUNT" ] || die "out of range"
else
  CHOICE=1
fi
SELECTED=$(printf '%s\n' "$MATCHES" | sed -n "${CHOICE}p")
HASH=${SELECTED%%|*}
NAME=${SELECTED#*|}
say "Identity: $NAME"

# --- Team ID from the certificate subject (OU) ------------------------------
SUBJECT=$(security find-certificate -c "$NAME" -p login.keychain | openssl x509 -noout -subject -nameopt RFC2253 2>/dev/null || true)
TEAM_ID=$(printf '%s\n' "$SUBJECT" | sed -n 's/.*OU=\([^,]*\).*/\1/p' | head -n 1)
[ -n "$TEAM_ID" ] || die "could not read the Team ID (OU) from the certificate subject: $SUBJECT"
say "Team ID: $TEAM_ID"

# --- export only that identity ----------------------------------------------
# `security export` takes no per-item selector, so the export hops through a
# throwaway keychain: everything lands there, every other identity is deleted,
# and only the chosen one is exported for CSC_LINK. macOS shows its own Allow
# prompt for the private key.
WORK=$(mktemp -d "${TMPDIR:-/tmp}/signing-secrets.XXXXXX")
TMPKC="$WORK/export.keychain"
BULK="$WORK/all-identities.p12"
P12="$WORK/developer-id-application.p12"
cleanup() {
  security delete-keychain "$TMPKC" >/dev/null 2>&1 || true
  rm -Pf "$BULK" "$P12" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT INT TERM

KC_PASS=$(random_pass); BULK_PASS=$(random_pass); P12_PASS=$(random_pass)
security create-keychain -p "$KC_PASS" "$TMPKC"
security unlock-keychain -p "$KC_PASS" "$TMPKC"
security set-keychain-settings "$TMPKC" >/dev/null 2>&1 || true
say "Exporting the identity; click Allow when macOS asks about the private key."
security export -k login.keychain -t identities -f pkcs12 -P "$BULK_PASS" -o "$BULK"
security import "$BULK" -k "$TMPKC" -f pkcs12 -P "$BULK_PASS" -A >/dev/null
# No policy filter here: every other identity in the throwaway keychain must
# go, not just the codesigning ones.
security find-identity -v "$TMPKC" 2>/dev/null \
  | sed -n 's/^ *[0-9]*) \([0-9A-Fa-f][0-9A-Fa-f]*\) ".*/\1/p' \
  | while read -r H; do [ "$H" = "$HASH" ] || security delete-identity -Z "$H" "$TMPKC"; done
security export -k "$TMPKC" -t identities -f pkcs12 -P "$P12_PASS" -o "$P12"
security delete-keychain "$TMPKC"
[ -s "$P12" ] || die "the exported certificate file is empty"

# --- the two Apple credentials only the maintainer knows --------------------
printf 'Apple ID email: ' >&2
read -r APPLE_ID_VALUE
printf 'App-specific password (appleid.apple.com -> Sign-In and Security): ' >&2
if [ -t 0 ]; then stty -echo; fi
read -r APPLE_PW || true
if [ -t 0 ]; then stty echo; printf '\n' >&2; fi
[ -n "$APPLE_ID_VALUE" ] && [ -n "${APPLE_PW:-}" ] || die "Apple ID and app-specific password are required"

# --- store the secrets -------------------------------------------------------
set_secret() {
  if [ "$DRY_RUN" = 1 ]; then
    cat >/dev/null
    say "[dry-run] would set $1"
  else
    gh secret set "$1" -R "$REPO" >/dev/null
    say "set $1"
  fi
}
base64 < "$P12" | set_secret CSC_LINK
printf %s "$P12_PASS" | set_secret CSC_KEY_PASSWORD
printf %s "$APPLE_ID_VALUE" | set_secret APPLE_ID
printf %s "$APPLE_PW" | set_secret APPLE_APP_SPECIFIC_PASSWORD
printf %s "$TEAM_ID" | set_secret APPLE_TEAM_ID
say "Done. Secrets set on $REPO."
