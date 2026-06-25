#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHON_BIN="${PYTHON_BIN:-$ROOT/.venv/bin/python}"

if [[ ! -x "$PYTHON_BIN" ]]; then
  if command -v python3 >/dev/null 2>&1; then
    PYTHON_BIN="$(command -v python3)"
  else
    echo "Python not found. Create .venv or set PYTHON_BIN." >&2
    exit 1
  fi
fi

PY_ARCH="$("$PYTHON_BIN" -c 'import platform; print(platform.machine())')"
case "$PY_ARCH" in
  x86_64|AMD64)
    ELECTRON_ARCH="x64"
    ;;
  arm64|aarch64)
    ELECTRON_ARCH="arm64"
    ;;
  *)
    echo "Unsupported Python architecture for macOS release: $PY_ARCH" >&2
    exit 1
    ;;
esac

npm --prefix "$ROOT/desktop" run build
PYTHON_BIN="$PYTHON_BIN" "$ROOT/scripts/build_backend_bundle.sh"
rm -rf "$ROOT/desktop/dist"

(
  cd "$ROOT/desktop"
  npx electron-builder --mac dmg zip "--$ELECTRON_ARCH" --publish never
)
