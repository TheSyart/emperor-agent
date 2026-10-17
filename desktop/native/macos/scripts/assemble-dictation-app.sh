#!/bin/bash
set -euo pipefail

if [[ ( $# -ne 1 && $# -ne 2 ) || ( "$1" != "arm64" && "$1" != "x86_64" ) ]]; then
  echo 'usage: assemble-dictation-app.sh <arm64|x86_64> [output-dir]' >&2
  exit 2
fi

native_dir="$(cd "$(dirname "$0")/.." && pwd)"
arch="$1"
output_dir="${2:-$native_dir/build/$arch}"
app="$output_dir/Emperor Dictation Helper.app"
mkdir -p "$output_dir"

swift build --package-path "$native_dir" -c release --arch "$arch" --product emperor-dictation-helper
binary="$(swift build --package-path "$native_dir" -c release --arch "$arch" --show-bin-path)/emperor-dictation-helper"
test -x "$binary"
rm -rf "$app"
mkdir -p "$app/Contents/MacOS"
cp "$binary" "$app/Contents/MacOS/emperor-dictation-helper"
# Emperor starts the helper as its child; the usage strings are shown when
# macOS asks for the microphone and speech recognition (experiment E-D1
# records whose name the grants are kept under).
cat > "$app/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>com.emperor.agent.desktop.dictation-helper</string>
  <key>CFBundleName</key><string>Emperor Dictation Helper</string>
  <key>CFBundleExecutable</key><string>emperor-dictation-helper</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>LSUIElement</key><true/>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>NSMicrophoneUsageDescription</key><string>Emperor 只在你向聊天输入框听写时使用麦克风；声音只在这台 Mac 上处理，不会保存。</string>
  <key>NSSpeechRecognitionUsageDescription</key><string>Emperor 在这台 Mac 上把你说的话识别成文字，填进聊天输入框；不会发送到网络。</string>
</dict></plist>
PLIST

if [[ -n "${EMPEROR_DEV_SIGN_IDENTITY:-}" ]]; then
  codesign --force --options runtime --timestamp=none \
    --entitlements "$native_dir/scripts/dictation-helper.entitlements" \
    --sign "$EMPEROR_DEV_SIGN_IDENTITY" "$app"
  codesign --verify --strict "$app"
fi
plutil -lint "$app/Contents/Info.plist"
echo "$app"
