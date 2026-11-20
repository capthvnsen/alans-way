#!/bin/zsh
# Runs the iOS gateway integration tests against the desktop's fake Hermes backend. Fake data only; nothing leaves loopback.
#   ios/scripts/test-gateway-integration.sh <simulator UDID> [extra xcodebuild args]
# Defaults to the XCTest integration tests; pass -only-testing:AlanWorkspaceUITests/GatewayUITests for the UI run
# (GATEWAY_SHOT_DIR=<dir> saves its screenshots there; FAKE_ARGS="--whole" makes the backend send whole replies).
set -eu
UDID=${1:?usage: test-gateway-integration.sh <simulator UDID> [extra xcodebuild args]}
HERE=${0:A:h}
OUT=$(mktemp -t gateway-fake)
# Words arrive 150 ms apart so a drop can land mid-reply.
node "$HERE/gateway-fake-backend.cjs" --delta-ms "${DELTA_MS:-150}" ${=FAKE_ARGS:-} > "$OUT" &
FAKE=$!
trap 'kill $FAKE 2>/dev/null; rm -f "$OUT"' EXIT
for _ in {1..50}; do [ -s "$OUT" ] && break; sleep 0.1; done
URL=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["url"])' "$OUT")
CONTROL=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["control"])' "$OUT")
cd "$HERE/.."
EXTRA=(); [ -n "${DERIVED_DATA:-}" ] && EXTRA=(-derivedDataPath "$DERIVED_DATA")
ONLY=(-only-testing:AlanWorkspaceTests/GatewayIntegrationTests); [ $# -gt 1 ] && ONLY=("${@:2}")
export TEST_RUNNER_GATEWAY_FAKE_URL=$URL TEST_RUNNER_GATEWAY_FAKE_CONTROL=$CONTROL
[ -n "${GATEWAY_SHOT_DIR:-}" ] && export TEST_RUNNER_GATEWAY_SHOT_DIR=$GATEWAY_SHOT_DIR
xcodebuild test -project AlanWorkspace.xcodeproj -scheme AlanWorkspace -destination "id=$UDID" \
  "${EXTRA[@]}" "${ONLY[@]}"
