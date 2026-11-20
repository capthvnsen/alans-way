#!/bin/sh
# Copies the desktop bust images and eye manifest into the iOS app so the two cannot drift.
# `--check` changes nothing and fails if the iOS copies differ (the unit tests run the same comparison).
set -eu

ios_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
source_dir="$ios_root/../desktop/assets/avatars"
catalog="$ios_root/AlanWorkspace/Resources/Assets.xcassets"
manifest="$ios_root/AlanWorkspace/Resources/avatars-manifest.json"
check=false
[ "${1:-}" = "--check" ] && check=true

drift=0
sync_file() {
  if $check; then
    cmp -s "$1" "$2" || { echo "differs: $2" >&2; drift=1; }
  else
    mkdir -p "$(dirname "$2")"
    cp "$1" "$2"
  fi
}

sync_file "$source_dir/manifest.json" "$manifest"
for image in "$source_dir"/*.png; do
  name=$(basename "$image" .png)
  sync_file "$image" "$catalog/$name.imageset/$name.png"
done
exit $drift
