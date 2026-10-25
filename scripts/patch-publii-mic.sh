#!/usr/bin/env bash
# Let Publii use the microphone on macOS.
#
# Publii's macOS build runs under Apple's hardened runtime but is signed without
# the "audio input" entitlement, so macOS silently hands it silence instead of
# microphone audio (and never asks for permission). This script adds that one
# entitlement to your copy of Publii and re-signs it locally (ad hoc).
#
#   scripts/patch-publii-mic.sh              patch /Applications/Publii.app (backs it up first)
#   scripts/patch-publii-mic.sh --restore    put the original app back from the backup
#   scripts/patch-publii-mic.sh --app PATH   use a different Publii.app
#
# Side effects, all expected:
#   - macOS asks once for microphone access the next time you dictate.
#   - macOS asks once to let Publii read its saved server passwords in your
#     keychain (enter your Mac password and choose "Always Allow").
#   - Installing a new Publii version replaces the app; run this script again.
set -euo pipefail

APP="/Applications/Publii.app"
RESTORE=0
ENTITLEMENT="com.apple.security.device.audio-input"

while [ $# -gt 0 ]; do
    case "$1" in
        --app) APP="${2:?--app needs a path}"; shift 2 ;;
        --restore) RESTORE=1; shift ;;
        -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
        *) echo "Unknown option: $1" >&2; exit 1 ;;
    esac
done

if [ "$(uname)" != "Darwin" ]; then
    echo "This fix is only needed on macOS." >&2
    exit 1
fi

APP="${APP%/}"

if [ ! -d "$APP/Contents/MacOS" ]; then
    echo "Publii not found at $APP" >&2
    exit 1
fi

VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist")"
BACKUP_DIR="$HOME/Library/Application Support/Talk It Out/backups"
BACKUP="$BACKUP_DIR/Publii-${VERSION}.app"

if pgrep -f "$APP/Contents/MacOS/" > /dev/null; then
    echo "Please quit Publii first (⌘Q), then run this again." >&2
    exit 1
fi

if [ "$RESTORE" = 1 ]; then
    if [ ! -d "$BACKUP" ]; then
        echo "No backup found for Publii ${VERSION} at $BACKUP" >&2
        exit 1
    fi
    rm -rf "$APP"
    ditto "$BACKUP" "$APP"
    echo "Restored the original Publii ${VERSION}."
    exit 0
fi

has_entitlement () {
    codesign -d --entitlements :- "$1" 2>/dev/null | grep -q "$ENTITLEMENT"
}

if has_entitlement "$APP"; then
    echo "Publii ${VERSION} can already use the microphone. Nothing to do."
    exit 0
fi

if [ ! -w "$APP" ]; then
    echo "No permission to modify $APP. Run with sudo, or move Publii into /Applications yourself first." >&2
    exit 1
fi

# Keep the untouched app so --restore can put it back
if [ ! -d "$BACKUP" ]; then
    echo "Backing up the original app to: $BACKUP"
    mkdir -p "$BACKUP_DIR"
    ditto "$APP" "$BACKUP"
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Re-sign one bundle with its existing entitlements plus audio input
resign () {
    local bundle="$1"
    local plist="$WORK/$(basename "$bundle").plist"

    codesign -d --entitlements :- "$bundle" > "$plist" 2>/dev/null || true

    if [ ! -s "$plist" ]; then
        /usr/libexec/PlistBuddy -c 'Save' "$plist" > /dev/null
    fi

    /usr/libexec/PlistBuddy -c "Delete :$ENTITLEMENT" "$plist" > /dev/null 2>&1 || true
    /usr/libexec/PlistBuddy -c "Add :$ENTITLEMENT bool true" "$plist"
    codesign --force --options runtime --sign - --entitlements "$plist" "$bundle"
}

echo "Adding microphone access to Publii ${VERSION}…"

# Helpers first (Chromium captures audio in a helper process), then the app itself
for helper in "$APP"/Contents/Frameworks/*.app; do
    resign "$helper"
done

resign "$APP"

# The app was downloaded, so macOS would re-check the new local signature and refuse it
xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true

codesign --verify --deep --strict "$APP"

if ! has_entitlement "$APP"; then
    echo "Re-signing finished, but the entitlement is missing. Restore with --restore." >&2
    exit 1
fi

cat <<EOF
Done. Publii ${VERSION} can now use the microphone.

Next:
  1. Open Publii. The first time you dictate, macOS asks for microphone access: click Allow.
  2. If macOS asks about your keychain, enter your Mac password and choose "Always Allow".

To undo: scripts/patch-publii-mic.sh --restore
After installing a new Publii version, run this script again.
EOF
