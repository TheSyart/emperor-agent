#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

HOST_ARCH="${ELECTRON_ARCH:-$(uname -m)}"
case "$HOST_ARCH" in
  x86_64|AMD64)
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
  EMPEROR_RELEASE_TARGET=mac npx electron-builder \
    --config electron-builder.release.cjs \
    --mac dmg zip \
    "--$ELECTRON_ARCH" \
    --publish never
)
