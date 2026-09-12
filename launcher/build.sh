#!/bin/bash
# Build MacRemote.app (menu bar shell + bundled agent) and install it to ~/Applications.
# The agent is copied into the bundle so it does not read code from the TCC-protected Desktop.
# Signing with an Apple Development identity keeps granted permissions across rebuilds.
# The bundle is assembled in a temporary directory, so the installed copy is the only one.
set -euo pipefail
cd "$(dirname "$0")/.."

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
APP="$WORK/MacRemote.app"
SUPPORT="$HOME/Library/Application Support/MacRemote"

bash helper/build.sh
npm --prefix agent install --omit=dev --no-audit --no-fund >/dev/null

mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
swiftc -O -swift-version 5 launcher/MacRemote.swift -o "$APP/Contents/MacOS/MacRemote"
cp launcher/Info.plist "$APP/Contents/Info.plist"
rsync -a --exclude package-lock.json agent shared bin "$APP/Contents/Resources/"

IDENTITY="${CODESIGN_IDENTITY:-$(security find-identity -v -p codesigning | awk -F'"' '/Apple Development/ {print $2; exit}')}"
IDENTITY="${IDENTITY:--}"
codesign --force --sign "$IDENTITY" "$APP/Contents/Resources/bin/macctl"
codesign --force --sign "$IDENTITY" "$APP"
codesign --verify --strict "$APP"

mkdir -p "$SUPPORT"
NODE="$(command -v node)"
printf '{\n  "node": "%s"\n}\n' "$NODE" > "$SUPPORT/launcher.json"

pkill -x MacRemote 2>/dev/null || true
rm -rf build # older versions left a second, launchable copy here
mkdir -p "$HOME/Applications"
rm -rf "$HOME/Applications/MacRemote.app"
ditto "$APP" "$HOME/Applications/MacRemote.app"

echo "installed ~/Applications/MacRemote.app"
echo "  signed with: $([ "$IDENTITY" = "-" ] && echo ad-hoc || echo "$IDENTITY" | sed -E 's/\(.*\)//')"
echo "  node: $NODE"
echo "start it with: open ~/Applications/MacRemote.app"
