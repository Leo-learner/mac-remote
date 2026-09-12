#!/bin/bash
# Build the native helper -> bin/macctl
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p bin
swiftc -O -swift-version 5 helper/macctl.swift -o bin/macctl \
  -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker helper/Info.plist
echo "built bin/macctl"
