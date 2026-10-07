#!/bin/bash
# Build MacRemote.app (menu bar shell + bundled Orbit agent) and the phone terminal's helper, and
# install them: ~/Applications/MacRemote.app and ~/Library/Application Support/MacRemote/RemoteTerm.app.
#   bash launcher/build.sh            build, sign and install (stops MacRemote: terminal sessions end)
#   bash launcher/build.sh --check    build and sign in a temporary folder only
# The agents are copied into the bundle so they do not read code from the TCC-protected Desktop.
# Signing with an Apple Development identity keeps granted permissions across rebuilds.
# The bundle is assembled in a temporary directory, so the installed copy is the only one.
#
# The terminal comes from remote-term/ in this repository (REMOTE_TERM_DIR overrides it): its
# launcher/build-helper.sh builds RemoteTerm.app, with its own bundle id and signature, so its Full
# Disk Access grant stays its own and never this app's. It must not go inside MacRemote.app: TCC
# treats code in an app's bundle as that app, so nested, the shells would get MacRemote's grants.
set -euo pipefail
cd "$(dirname "$0")/.."

REMOTE_TERM_DIR="${REMOTE_TERM_DIR:-$PWD/remote-term}"
if [ ! -f "$REMOTE_TERM_DIR/launcher/build-helper.sh" ]; then
  echo "remote-term not found at $REMOTE_TERM_DIR (no launcher/build-helper.sh)." >&2
  echo "It is the remote-term/ directory of this repository; REMOTE_TERM_DIR can point elsewhere." >&2
  exit 1
fi

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
# The helper is signed (inside-out) and verified by its own script, with the same identity.
CODESIGN_IDENTITY="$IDENTITY" bash "$REMOTE_TERM_DIR/launcher/build-helper.sh" "$WORK/helpers"
HELPER="$WORK/helpers/RemoteTerm.app"

codesign --force --sign "$IDENTITY" "$APP/Contents/Resources/bin/macctl"
codesign --force --sign "$IDENTITY" "$APP"
codesign --verify --strict --deep "$APP"

if [ "${1:-}" = "--check" ]; then
  echo "built and verified $APP and $HELPER (not installed)"
  exit 0
fi

mkdir -p "$SUPPORT"
NODE="$(command -v node)"
printf '{\n  "node": "%s"\n}\n' "$NODE" > "$SUPPORT/launcher.json"

pkill -x MacRemote 2>/dev/null || true
pkill -f "MacRemote.app/Contents/Resources/agent/index.js" 2>/dev/null || true # agents from older builds outlive their launcher
# The terminal: MacRemote's helper, and the standalone RemoteTerm.app it replaces (same
# executable name), with their agents. Each relay keeps one agent connection.
pkill -x RemoteTerm 2>/dev/null || true
pkill -f "RemoteTerm.app/Contents/Resources/agent/index.js" 2>/dev/null || true
rm -rf build # older versions left a second, launchable copy here
mkdir -p "$HOME/Applications"
rm -rf "$HOME/Applications/MacRemote.app"
ditto "$APP" "$HOME/Applications/MacRemote.app"
rm -rf "$SUPPORT/RemoteTerm.app"
ditto "$HELPER" "$SUPPORT/RemoteTerm.app"

echo "installed ~/Applications/MacRemote.app and its terminal helper, $SUPPORT/RemoteTerm.app"
echo "  signed with: $([ "$IDENTITY" = "-" ] && echo ad-hoc || echo "$IDENTITY" | sed -E 's/ *\(.*\)//')"
echo "  node: $NODE"
echo "start it with: open ~/Applications/MacRemote.app"
if [ -d "$HOME/Applications/RemoteTerm.app" ]; then
  echo
  echo "The standalone ~/Applications/RemoteTerm.app is replaced by the terminal in MacRemote."
  echo "Move it to the Trash, and switch off its entry under System Settings > General > Login Items."
fi
