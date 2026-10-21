#!/usr/bin/env bash
# Builds one unsigned macOS Stable candidate (REL-05): the DMG and ZIP named
# Emperor-Agent-<version>-macos-<arch>, from electron-builder.release.cjs.
# Nothing is signed or notarized: the config has no identity, signing
# discovery is off, and after-pack flips the fuses and seals every piece of
# code ad hoc with the hardened runtime, as for Preview. Verify the result
# with scripts/verify-macos-release.sh <arch>.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

HOST_ARCH="${ELECTRON_ARCH:-$(uname -m)}"
case "$HOST_ARCH" in
  x86_64|AMD64|x64)
    ELECTRON_ARCH="x64"
    ;;
  arm64|aarch64)
    ELECTRON_ARCH="arm64"
    ;;
  *)
    echo "Unsupported architecture for macOS release: $HOST_ARCH" >&2
    exit 1
    ;;
esac

npm --prefix "$ROOT/desktop" run build
rm -rf "$ROOT/desktop/dist"

(
  cd "$ROOT/desktop"
  CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder \
    --config electron-builder.release.cjs \
    --mac dmg zip \
    "--$ELECTRON_ARCH" \
    --publish never
)
