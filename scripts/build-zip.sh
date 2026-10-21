#!/usr/bin/env bash
# Build the release zip for Publii's "Install plugin" button.
#
#   scripts/build-zip.sh        -> dist/talk-it-out-<version>.zip
#
# The zip holds a single talkItOut/ folder, which is what Publii expects:
# it installs (or updates) the plugin under that folder name.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLUGIN_DIR_NAME="talkItOut"
cd "$ROOT"

VERSION="$(python3 -c 'import json; print(json.load(open("plugin.json"))["version"])')"

# The version is repeated in files Publii loads directly; they must agree
for file in runtime/index.js options/options.js runtime/tinymce-plugin.js; do
    if ! grep -q "$VERSION" "$file"; then
        echo "Version $VERSION from plugin.json not found in $file" >&2
        exit 1
    fi
done

node --test tests/*.test.js > /dev/null
for file in runtime/*.js runtime/adapters/*.js options/options.js main.js; do
    node --check "$file"
done

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/$PLUGIN_DIR_NAME" dist

for item in plugin.json main.js thumbnail.svg LICENSE README.md runtime options; do
    cp -R "$item" "$STAGE/$PLUGIN_DIR_NAME/"
done

find "$STAGE" -name '.DS_Store' -delete

OUT="$ROOT/dist/talk-it-out-$VERSION.zip"
rm -f "$OUT"
(cd "$STAGE" && zip -qrX "$OUT" "$PLUGIN_DIR_NAME")

echo "Built $OUT"
echo "  $(du -h "$OUT" | cut -f1), $(unzip -Z1 "$OUT" | wc -l | tr -d ' ') entries"
echo "  sha256 $(shasum -a 256 "$OUT" | cut -d' ' -f1)"
