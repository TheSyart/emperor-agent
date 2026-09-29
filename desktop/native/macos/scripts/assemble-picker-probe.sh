#!/bin/bash
set -euo pipefail
: "${EMPEROR_DEV_SIGN_IDENTITY:?Set a stable Apple signing identity for the TCC experiment}"

native_dir="$(cd "$(dirname "$0")/.." && pwd)"
arch="$(uname -m)"
app="$native_dir/build/$arch/Emperor Capture Picker Probe.app"
executable="$app/Contents/MacOS/Emperor Capture Picker Probe"
mkdir -p "$(dirname "$executable")"
cat > "$app/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>com.emperor.agent.capturepickerprobe</string>
  <key>CFBundleName</key><string>Emperor Capture Picker Probe</string>
  <key>CFBundleExecutable</key><string>Emperor Capture Picker Probe</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>15.2</string>
  <key>NSScreenCaptureUsageDescription</key><string>Test whether the system window picker can capture the selected Emperor AX Fixture window without an existing Screen Recording grant.</string>
</dict></plist>
PLIST
swiftc -swift-version 6 -O -target "$arch-apple-macos15.2" \
  "$native_dir/Fixtures/ScreenCapturePickerProbe/main.swift" -o "$executable"
codesign --force --options runtime --timestamp=none \
  --sign "$EMPEROR_DEV_SIGN_IDENTITY" "$app"
codesign --verify --deep --strict "$app"
echo "$app"
