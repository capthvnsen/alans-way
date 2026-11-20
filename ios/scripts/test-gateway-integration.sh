#!/bin/zsh
# Runs the iOS gateway integration tests against the desktop's fake Hermes backend. Fake data only; nothing leaves loopback.
#   ios/scripts/test-gateway-integration.sh <simulator UDID> [--whole]
set -eu
UDID=${1:?usage: test-gateway-integration.sh <simulator UDID> [--whole]}
HERE=${0:A:h}
OUT=$(mktemp -t gateway-fake)
# Words arrive 150 ms apart so a drop can land mid-reply.
node "$HERE/gateway-fake-backend.cjs" --delta-ms "${DELTA_MS:-150}" "${@:2}" > "$OUT" &
FAKE=$!
trap 'kill $FAKE 2>/dev/null; rm -f "$OUT"' EXIT
for _ in {1..50}; do [ -s "$OUT" ] && break; sleep 0.1; done
URL=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["url"])' "$OUT")
CONTROL=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["control"])' "$OUT")
cd "$HERE/.."
EXTRA=(); [ -n "${DERIVED_DATA:-}" ] && EXTRA=(-derivedDataPath "$DERIVED_DATA")
TEST_RUNNER_GATEWAY_FAKE_URL=$URL TEST_RUNNER_GATEWAY_FAKE_CONTROL=$CONTROL \
  xcodebuild test -project AlanWorkspace.xcodeproj -scheme AlanWorkspace -destination "id=$UDID" \
  "${EXTRA[@]}" CODE_SIGNING_ALLOWED=NO -only-testing:AlanWorkspaceTests/GatewayIntegrationTests
