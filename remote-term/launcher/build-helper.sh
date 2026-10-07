#!/bin/bash
# Build the terminal's helper bundle, <out-dir>/RemoteTerm.app, signed and verified.
#   bash launcher/build-helper.sh <out-dir>
#   SKIP_NPM_INSTALL=1 bash launcher/build-helper.sh <out-dir>    use agent/node_modules as it is
# The repository root's launcher/build.sh (MacRemote) runs this and installs the bundle at
# ~/Library/Application Support/MacRemote/RemoteTerm.app. MacRemote starts it with TCC
# responsibility disclaimed, so dev.remote-term.launcher stays the identity that holds Full Disk
# Access for remote shells. Never put it inside MacRemote.app: TCC treats code in an app's bundle
# as that app, and the shells would get MacRemote's grants instead. Signing with the same Apple Development
# identity as the standalone RemoteTerm.app keeps the designated requirement, and with it that grant.
# The agent is copied into the bundle so it does not run code from the TCC-protected Desktop.
set -euo pipefail

if [ $# -ne 1 ] || [ -z "$1" ]; then
  echo "usage: bash launcher/build-helper.sh <out-dir>" >&2
  exit 64
fi
mkdir -p "$1"
OUT="$(cd "$1" && pwd)"
cd "$(dirname "$0")/.."

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
APP="$OUT/RemoteTerm.app"

if [ "${SKIP_NPM_INSTALL:-}" != 1 ] || [ ! -d agent/node_modules ]; then
  npm --prefix agent install --omit=dev --no-audit --no-fund >/dev/null
fi

swiftc -O -swift-version 5 launcher/helper/main.swift -o "$WORK/RemoteTerm"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$WORK/RemoteTerm" "$APP/Contents/MacOS/RemoteTerm"
cp launcher/helper/Info.plist "$APP/Contents/Info.plist"
# node-pty loads prebuilds/<platform>-<arch>, so only the darwin ones can ever run here; the win32
# ones alone are about 59 MB.
rsync -a --exclude package-lock.json --exclude '*.test.js' \
  --include 'node-pty/prebuilds/darwin-*' --exclude 'node-pty/prebuilds/*' \
  agent shared "$APP/Contents/Resources/"
# Every session starts through spawn-helper. npm's postinstall sets its bit, but an install that
# was skipped or done another way may not have.
chmod +x "$APP"/Contents/Resources/agent/node_modules/node-pty/prebuilds/darwin-*/spawn-helper

IDENTITY="${CODESIGN_IDENTITY:-$(security find-identity -v -p codesigning | awk -F'"' '/Apple Development/ {print $2; exit}')}"
IDENTITY="${IDENTITY:--}"
if [ "$IDENTITY" = "-" ]; then
  echo "warning: no Apple Development identity, signing ad-hoc: Full Disk Access granted to RemoteTerm will not apply to this build" >&2
fi
# Inside-out: every Mach-O under Resources first (node-pty's pty.node and spawn-helper today), found
# by content so that a native module added later is signed too; then the bundle, which seals them.
NATIVE=()
while IFS= read -r -d '' path && IFS= read -r type; do
  case "$type" in *application/x-mach-binary*) NATIVE+=("$path") ;; esac
done < <(find "$APP/Contents/Resources" -type f -exec file --mime-type -N -0 {} +)
if [ ${#NATIVE[@]} -eq 0 ]; then
  echo "no native code found under $APP/Contents/Resources: is node-pty installed?" >&2
  exit 1
fi
for path in "${NATIVE[@]}"; do
  codesign --force --sign "$IDENTITY" "$path"
done
codesign --force --sign "$IDENTITY" "$APP"
codesign --verify --strict --deep "$APP"
echo "built $APP, signed with: $([ "$IDENTITY" = "-" ] && echo ad-hoc || echo "$IDENTITY" | sed -E 's/ *\(.*\)//')"
