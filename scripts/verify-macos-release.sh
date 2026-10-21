#!/usr/bin/env bash
# Verifies one unsigned macOS Stable candidate (REL-05) and writes its
# receipt. No certificate is involved: the app in desktop/dist, the app in
# the DMG and the app in the ZIP must each be sealed ad hoc only, with the
# hardened runtime and the planned entitlements on every piece of Emperor's
# code, the identifier and the fuses (desktop/scripts/verify-unsigned-app.cjs).
# The packaged smoke then runs the app from the mounted DMG.
#
#   scripts/verify-macos-release.sh <arm64|x64>
#
# Writes, next to the candidate in desktop/dist:
#   SHA256SUMS-macos-<arch>.txt, packaged-smoke/darwin-<arch>.json,
#   release-receipts/macos-<arch>.json
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARCH="${1:?usage: verify-macos-release.sh <arm64|x64>}"
DIST="$ROOT/desktop/dist"
VERSION="$(node -p 'require(process.argv[1]).version' "$ROOT/desktop/package.json")"

case "$ARCH" in
  arm64) APP_DIR="$DIST/mac-arm64" ;;
  x64) APP_DIR="$DIST/mac" ;;
  *) echo "Unsupported macOS release architecture: $ARCH" >&2; exit 2 ;;
esac

APP="$APP_DIR/Emperor Agent.app"
DMG="$DIST/Emperor-Agent-$VERSION-macos-$ARCH.dmg"
ZIP="$DIST/Emperor-Agent-$VERSION-macos-$ARCH.zip"
for file in "$DMG" "$ZIP"; do
  if [[ ! -f "$file" ]]; then
    echo "Missing Stable candidate: $(basename "$file") (scripts/build_desktop_release.sh builds it)" >&2
    exit 1
  fi
done
# This candidate's two files only: no Preview, Internal or other build beside them.
shopt -s nullglob
for file in "$DIST"/*.dmg "$DIST"/*.zip; do
  if [[ "$file" != "$DMG" && "$file" != "$ZIP" ]]; then
    echo "Unexpected package next to the Stable candidate: $(basename "$file")" >&2
    exit 1
  fi
done
shopt -u nullglob
test -d "$APP"

verify_app() {
  node "$ROOT/desktop/scripts/verify-unsigned-app.cjs" "$1" "$ARCH"
}

verify_app "$APP" >/dev/null

MOUNT="$(mktemp -d -t emperor-dmg)"
ZIP_EXTRACT="$(mktemp -d -t emperor-zip)"
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
# The DMG and ZIP copies are checked and run here only: LaunchServices
# forgets them before they go.
forget_copies() {
  "$LSREGISTER" -u "$MOUNT/Emperor Agent.app" >/dev/null 2>&1 || true
  "$LSREGISTER" -u "$ZIP_EXTRACT/Emperor Agent.app" >/dev/null 2>&1 || true
}
cleanup() {
  forget_copies
  hdiutil detach "$MOUNT" -quiet >/dev/null 2>&1 || true
  rmdir "$MOUNT" >/dev/null 2>&1 || true
  rm -rf "$ZIP_EXTRACT"
}
trap cleanup EXIT

hdiutil attach "$DMG" -readonly -nobrowse -mountpoint "$MOUNT" >/dev/null
MOUNTED_APP="$MOUNT/Emperor Agent.app"
SEAL="$(verify_app "$MOUNTED_APP")"

ditto -x -k "$ZIP" "$ZIP_EXTRACT"
verify_app "$ZIP_EXTRACT/Emperor Agent.app" >/dev/null

# Through npm, as in CI: the smoke's Seatbelt probe runs the host npm.
npm --prefix "$ROOT/desktop" run -s package:smoke -- \
  --app "$MOUNTED_APP/Contents/MacOS/Emperor Agent"

forget_copies
hdiutil detach "$MOUNT" -quiet
rmdir "$MOUNT"
rm -rf "$ZIP_EXTRACT"
trap - EXIT

(
  cd "$DIST"
  shasum -a 256 "$(basename "$DMG")" "$(basename "$ZIP")" \
    >"SHA256SUMS-macos-$ARCH.txt"
)

COMMIT="${EMPEROR_RELEASE_COMMIT:-${GITHUB_SHA:-$(git -C "$ROOT" rev-parse HEAD)}}"
mkdir -p "$DIST/release-receipts"
DIST="$DIST" ARCH="$ARCH" VERSION="$VERSION" COMMIT="$COMMIT" SEAL="$SEAL" \
DMG="$DMG" ZIP="$ZIP" node <<'NODE'
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { DIST, ARCH, VERSION, COMMIT, SEAL, DMG, ZIP } = process.env
const record = (file) => {
  const body = fs.readFileSync(file)
  return {
    name: path.basename(file),
    sha256: createHash('sha256').update(body).digest('hex'),
    size: body.length,
  }
}
const smokeName = `darwin-${ARCH}.json`
const smoke = JSON.parse(
  fs.readFileSync(path.join(DIST, 'packaged-smoke', smokeName), 'utf8'),
)
if (smoke.appVersion !== VERSION || smoke.commit !== COMMIT)
  throw new Error(
    `packaged smoke ran ${smoke.appVersion} at ${smoke.commit}, expected ${VERSION} at ${COMMIT}`,
  )
const receipt = {
  schemaVersion: 1,
  channel: 'stable',
  signingStatus: 'unsigned',
  notarized: false,
  version: VERSION,
  commit: COMMIT,
  platform: 'macos',
  arch: ARCH,
  seal: JSON.parse(SEAL),
  dmgMounted: true,
  zipExtracted: true,
  packagedSmoke: smokeName,
  artifacts: [record(DMG), record(ZIP)],
}
fs.writeFileSync(
  path.join(DIST, 'release-receipts', `macos-${ARCH}.json`),
  `${JSON.stringify(receipt, null, 2)}\n`,
)
console.log(`unsigned Stable candidate verified: macos-${ARCH}`)
NODE
