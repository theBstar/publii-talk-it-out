#!/usr/bin/env bash
# Install Talk It Out into Publii.
#
#   ./install.sh               copy the plugin into Publii's plugins folder
#   ./install.sh --link        symlink instead (for development: edits apply on reload)
#   ./install.sh --autostart   also load it automatically in the WYSIWYG editor
#                              (adds an external_plugins entry to tinymce.override.json)
#   ./install.sh --uninstall   remove the plugin and the autostart entry
#
# PUBLII_DIR overrides the Publii app folder (default: ~/Documents/Publii).
set -euo pipefail

PLUGIN_DIR_NAME="talkItOut"
SOURCE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PUBLII_DIR="${PUBLII_DIR:-$HOME/Documents/Publii}"
TARGET="$PUBLII_DIR/plugins/$PLUGIN_DIR_NAME"
OVERRIDE="$PUBLII_DIR/config/tinymce.override.json"

LINK=0
AUTOSTART=0
UNINSTALL=0

for arg in "$@"; do
    case "$arg" in
        --link) LINK=1 ;;
        --autostart) AUTOSTART=1 ;;
        --uninstall) UNINSTALL=1 ;;
        -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
        *) echo "Unknown option: $arg" >&2; exit 1 ;;
    esac
done

if [ ! -d "$PUBLII_DIR/plugins" ]; then
    echo "Publii plugins folder not found at $PUBLII_DIR/plugins" >&2
    echo "Open Publii once, or set PUBLII_DIR." >&2
    exit 1
fi

# Add or remove our entry in tinymce.override.json, keeping everything else
edit_override () {
    local mode="$1"
    local url="file://$TARGET/runtime/tinymce-plugin.js"
    mkdir -p "$(dirname "$OVERRIDE")"

    if [ -f "$OVERRIDE" ]; then
        cp "$OVERRIDE" "$OVERRIDE.bak"
    fi

    python3 - "$OVERRIDE" "$mode" "$url" <<'PY'
import json, os, sys
path, mode, url = sys.argv[1:4]
data = {}
if os.path.exists(path):
    with open(path) as f:
        text = f.read().strip()
    data = json.loads(text) if text else {}
plugins = data.get("external_plugins") or {}
if mode == "add":
    plugins["talkitout"] = url
else:
    plugins.pop("talkitout", None)
if plugins:
    data["external_plugins"] = plugins
else:
    data.pop("external_plugins", None)
with open(path, "w") as f:
    json.dump(data, f, indent=4)
    f.write("\n")
PY
}

if [ "$UNINSTALL" = 1 ]; then
    rm -rf "$TARGET"
    if [ -f "$OVERRIDE" ]; then
        edit_override remove
    fi
    echo "Removed Talk It Out. Restart Publii."
    exit 0
fi

rm -rf "$TARGET"

if [ "$LINK" = 1 ]; then
    ln -s "$SOURCE" "$TARGET"
    echo "Linked $TARGET -> $SOURCE"
else
    mkdir -p "$TARGET"
    for item in plugin.json main.js thumbnail.svg LICENSE README.md runtime options; do
        if [ -e "$SOURCE/$item" ]; then
            cp -R "$SOURCE/$item" "$TARGET/"
        fi
    done
    echo "Installed to $TARGET"
fi

if [ "$AUTOSTART" = 1 ]; then
    edit_override add
    echo "Autostart enabled in $OVERRIDE"
fi

cat <<EOF

Next:
  1. Restart Publii.
  2. Open your site → Tools → Plugins, enable "Talk It Out", then open it.
  3. Open any post: the mic panel is in the bottom-right corner.
EOF
