#!/bin/bash
set -euo pipefail

if [[ ( $# -ne 1 && $# -ne 2 ) || ( "$1" != "arm64" && "$1" != "x86_64" ) ]]; then
  echo 'usage: assemble-app.sh <arm64|x86_64> [output-dir]' >&2
  exit 2
fi

native_dir="$(cd "$(dirname "$0")/.." && pwd)"
arch="$1"
# The default is the development helper. A throwaway build passes its own
# directory: re-signing ad hoc changes the CDHash, which drops TCC grants.
output_dir="${2:-$native_dir/build/$arch}"
app="$output_dir/Emperor Computer Helper.app"
mkdir -p "$output_dir"

swift build --package-path "$native_dir" -c release --arch "$arch"
binary="$(swift build --package-path "$native_dir" -c release --arch "$arch" --show-bin-path)/emperor-computer-helper"
test -x "$binary"
rm -rf "$app"
mkdir -p "$app/Contents/MacOS"
cp "$binary" "$app/Contents/MacOS/emperor-computer-helper"
cat > "$app/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>com.emperor.agent.desktop.computer-helper</string>
  <key>CFBundleName</key><string>Emperor Computer Helper</string>
  <key>CFBundleExecutable</key><string>emperor-computer-helper</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>LSUIElement</key><true/>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>NSScreenCaptureUsageDescription</key><string>Emperor uses screen recording to observe the desktop window you choose for computer use.</string>
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
