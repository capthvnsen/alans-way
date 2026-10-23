#!/bin/sh
set -eu

ios_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ios_root"
command -v xcodegen >/dev/null 2>&1 || { echo 'Install XcodeGen with: brew install xcodegen' >&2; exit 1; }
xcodegen generate --spec project.yml
mkdir -p .build

case "${1:-simulator}" in
  simulator)
    xcodebuild -project AlanWorkspace.xcodeproj -scheme AlanWorkspace \
      -destination 'generic/platform=iOS Simulator' -derivedDataPath .build/DerivedData \
      -clonedSourcePackagesDirPath .build/SourcePackages CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- build
    ;;
  device)
    xcodebuild -project AlanWorkspace.xcodeproj -scheme AlanWorkspace \
      -destination 'generic/platform=iOS' -derivedDataPath .build/DeviceDerivedData \
      -clonedSourcePackagesDirPath .build/SourcePackages \
      -archivePath .build/AlanWorkspace.xcarchive CODE_SIGNING_ALLOWED=NO archive
    ;;
  test)
    if [ -z "${2:-}" ]; then
      echo 'Usage: ./ios/scripts/build.sh test <simulator UUID>' >&2
      echo 'List simulators with: xcrun simctl list devices available' >&2
      exit 1
    fi
    xcodebuild -project AlanWorkspace.xcodeproj -scheme AlanWorkspace \
      -destination "platform=iOS Simulator,id=$2" -derivedDataPath .build/DerivedData \
      -clonedSourcePackagesDirPath .build/SourcePackages -parallel-testing-enabled NO \
      CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- test
    ;;
  *) echo 'Usage: ./ios/scripts/build.sh [simulator|device|test <simulator UUID>]' >&2; exit 1 ;;
esac
