#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARCH="${1:?usage: verify-macos-release.sh <arm64|x64>}"
EXPECTED_TEAM_ID="${APPLE_TEAM_ID:?APPLE_TEAM_ID is required for verification}"
DIST="$ROOT/desktop/dist"

case "$ARCH" in
  arm64)
    APP_DIR="$DIST/mac-arm64"
    LIPO_ARCH="arm64"
    ;;
  x64)
    APP_DIR="$DIST/mac"
    LIPO_ARCH="x86_64"
    ;;
  *) echo "Unsupported macOS release architecture: $ARCH" >&2; exit 2 ;;
esac

APP="$APP_DIR/Emperor Agent.app"
BINARY="$APP/Contents/MacOS/Emperor Agent"
DMG="$(find "$DIST" -maxdepth 1 -type f -name "Emperor-Agent-*-mac-$ARCH.dmg" -print -quit)"
ZIP="$(find "$DIST" -maxdepth 1 -type f -name "Emperor-Agent-*-mac-$ARCH.zip" -print -quit)"

test -d "$APP"
test -x "$BINARY"
test -n "$DMG"
test -n "$ZIP"

verify_app() {
  local app="$1"
  local executable="$app/Contents/MacOS/Emperor Agent"
  codesign --verify --deep --strict --verbose=2 "$app"
  local signature
  signature="$(codesign -dv --verbose=4 "$app" 2>&1)"
  grep -F "Authority=Developer ID Application:" <<<"$signature"
  grep -F "TeamIdentifier=$EXPECTED_TEAM_ID" <<<"$signature"
  spctl --assess --type execute --verbose=4 "$app"
  xcrun stapler validate "$app"
  lipo -archs "$executable" | tr ' ' '\n' | grep -Fx "$LIPO_ARCH"
}

verify_app "$APP"

MOUNT="$(mktemp -d "${TMPDIR:-/tmp}/emperor-dmg.XXXXXX")"
cleanup() {
  hdiutil detach "$MOUNT" -quiet >/dev/null 2>&1 || true
  rmdir "$MOUNT" >/dev/null 2>&1 || true
}
trap cleanup EXIT
hdiutil attach "$DMG" -readonly -nobrowse -mountpoint "$MOUNT"
MOUNTED_APP="$MOUNT/Emperor Agent.app"
verify_app "$MOUNTED_APP"

EMPEROR_SMOKE_APP="$MOUNTED_APP/Contents/MacOS/Emperor Agent" \
  node "$ROOT/desktop/scripts/run-packaged-smoke.cjs"

hdiutil detach "$MOUNT" -quiet
rmdir "$MOUNT"
trap - EXIT

(
  cd "$DIST"
  shasum -a 256 "$(basename "$DMG")" "$(basename "$ZIP")" \
    >"SHA256SUMS-macos-$ARCH.txt"
)

RECEIPT_DIR="$DIST/release-receipts"
RECEIPT_PATH="$RECEIPT_DIR/macos-$ARCH.json"
COMMIT="${GITHUB_SHA:-$(git -C "$ROOT" rev-parse HEAD)}"
mkdir -p "$RECEIPT_DIR"
RECEIPT_PATH="$RECEIPT_PATH" COMMIT="$COMMIT" ARCH="$ARCH" \
EXPECTED_TEAM_ID="$EXPECTED_TEAM_ID" DMG_NAME="$(basename "$DMG")" \
ZIP_NAME="$(basename "$ZIP")" node <<'NODE'
const fs = require('node:fs')
const receipt = {
  schemaVersion: 1,
  commit: process.env.COMMIT,
  platform: 'macos',
  arch: process.env.ARCH,
  teamId: process.env.EXPECTED_TEAM_ID,
  signed: true,
  gatekeeper: true,
  notarized: true,
  dmgMounted: true,
  packagedSmoke: `darwin-${process.env.ARCH}.json`,
  artifacts: [process.env.DMG_NAME, process.env.ZIP_NAME],
}
fs.writeFileSync(process.env.RECEIPT_PATH, `${JSON.stringify(receipt, null, 2)}\n`)
NODE
