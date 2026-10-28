#!/bin/sh
set -eu

case "${1:-}" in
  '') external=0 ;;
  --external) external=1 ;;
  *) echo 'Usage: APPLE_TEAM_ID=YOURTEAMID ./ios/scripts/testflight.sh [--external]' >&2; exit 1 ;;
esac
if [ -z "${APPLE_TEAM_ID:-}" ]; then
  echo 'Set APPLE_TEAM_ID to your Apple Developer team ID. Sign into Xcode Settings > Accounts first.' >&2
  exit 1
fi
case "$APPLE_TEAM_ID" in
  *[!A-Z0-9]*|'') echo 'APPLE_TEAM_ID must contain 10 uppercase letters or digits.' >&2; exit 1 ;;
esac
if [ "${#APPLE_TEAM_ID}" -ne 10 ]; then
  echo 'APPLE_TEAM_ID must contain 10 uppercase letters or digits.' >&2
  exit 1
fi

ios_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ios_root"
# The hash would be baked into the Info.plist of a build that leaves this Mac.
local_config=${LOCAL_CONFIGURATION:-"$ios_root/LocalConfiguration.xcconfig"}
if [ -n "${TELEGRAM_API_HASH:-}" ] || { [ -f "$local_config" ] && grep -Eq '^[[:space:]]*TELEGRAM_API_HASH[[:space:]]*=[[:space:]]*[^[:space:]/]' "$local_config"; }; then
  echo 'Refusing to archive: TELEGRAM_API_HASH is set and would be baked into the TestFlight build. Unset it and clear it in LocalConfiguration.xcconfig.' >&2
  exit 1
fi
command -v xcodegen >/dev/null 2>&1 || { echo 'Install XcodeGen with: brew install xcodegen' >&2; exit 1; }
distribution_dir=${TESTFLIGHT_BUILD_DIR:-"$ios_root/.build/TestFlight"}
mkdir -p "$distribution_dir"
cp ExportOptions-TestFlight.plist "$distribution_dir/ExportOptions.plist"
/usr/bin/plutil -insert teamID -string "$APPLE_TEAM_ID" "$distribution_dir/ExportOptions.plist"
# External groups need a build App Store Connect may offer outside the team; it then goes through Beta App Review.
[ "$external" = 1 ] && /usr/bin/plutil -remove testFlightInternalTestingOnly "$distribution_dir/ExportOptions.plist"
xcodegen generate --spec project.yml

xcodebuild -project AlanWorkspace.xcodeproj -scheme AlanWorkspace \
  -destination 'generic/platform=iOS' -derivedDataPath .build/DeviceDerivedData \
  -clonedSourcePackagesDirPath .build/SourcePackages \
  -archivePath "$distribution_dir/AlanWorkspace.xcarchive" \
  -allowProvisioningUpdates "DEVELOPMENT_TEAM=$APPLE_TEAM_ID" \
  CODE_SIGN_STYLE=Automatic CODE_SIGNING_ALLOWED=YES archive

xcodebuild -exportArchive -archivePath "$distribution_dir/AlanWorkspace.xcarchive" \
  -exportOptionsPlist "$distribution_dir/ExportOptions.plist" \
  -exportPath "$distribution_dir/Upload" -allowProvisioningUpdates
