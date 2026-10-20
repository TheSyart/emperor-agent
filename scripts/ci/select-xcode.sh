#!/usr/bin/env bash
# CI only: select the Xcode with the macOS 26 SDK the helpers build against
# (the Dictation Helper uses the macOS 26 speech APIs). Prefers the version
# the release workflows were verified with, then the newest Xcode 26.
set -euo pipefail

preferred=/Applications/Xcode_26.0.1.app
if [ -d "$preferred" ]; then
  xcode="$preferred"
else
  xcode="$(ls -d /Applications/Xcode_26*.app 2>/dev/null | sort -V | tail -n 1 || true)"
fi
if [ -z "${xcode:-}" ] || [ ! -d "$xcode" ]; then
  echo "select-xcode: no Xcode 26 in /Applications on this runner" >&2
  ls -d /Applications/Xcode*.app >&2 || true
  exit 1
fi
sudo xcode-select -s "$xcode/Contents/Developer"
xcodebuild -version
