#!/bin/bash
set -euo pipefail

if [[ $# -ne 1 || ( "$1" != "arm64" && "$1" != "x86_64" ) ]]; then
  echo 'usage: assemble-fixture.sh <arm64|x86_64>' >&2
  exit 2
fi

native_dir="$(cd "$(dirname "$0")/.." && pwd)"
arch="$1"
app="$native_dir/build/$arch/EmperorAXFixture.app"
mkdir -p "$app/Contents/MacOS"
swiftc -swift-version 6 -O -target "$arch-apple-macos14.0" \
  -framework AppKit "$native_dir/Fixtures/EmperorAXFixture/main.swift" \
  -o "$app/Contents/MacOS/EmperorAXFixture"
cat > "$app/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>com.emperor.agent.axfixture</string>
  <key>CFBundleName</key><string>Emperor AX Fixture</string>
  <key>CFBundleExecutable</key><string>EmperorAXFixture</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict></plist>
PLIST
if [[ -n "${EMPEROR_DEV_SIGN_IDENTITY:-}" ]]; then
  codesign --force --options runtime --timestamp=none --sign "$EMPEROR_DEV_SIGN_IDENTITY" "$app"
else
  codesign --force --sign - "$app"
fi
plutil -lint "$app/Contents/Info.plist"
codesign --verify --strict "$app"
echo "$app"
