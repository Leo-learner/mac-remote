#!/bin/bash
# RemoteTerm no longer installs on its own: the repository root's launcher/build.sh (MacRemote)
# builds it as MacRemote's terminal helper, ~/Library/Application Support/MacRemote/RemoteTerm.app.
# A second, standalone RemoteTerm.app would start a second agent with the same device token, and
# the relay keeps only one agent connection.
#   bash launcher/build.sh --check    build and verify the helper in a temporary folder only
set -euo pipefail
cd "$(dirname "$0")/.."

if [ "${1:-}" != "--check" ]; then
  echo "RemoteTerm now ships with MacRemote.app. Build and install it from the repository root:" >&2
  echo "  bash launcher/build.sh" >&2
  echo "To check that the helper builds and signs: bash launcher/build.sh --check" >&2
  exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
bash launcher/build-helper.sh "$WORK"
