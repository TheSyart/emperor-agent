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

DIST_DIR="$ROOT/desktop/build/backend"
WORK_DIR="$ROOT/build/pyinstaller"
ENTRY="$ROOT/scripts/backend_entry.py"

rm -rf "$DIST_DIR" "$WORK_DIR"
mkdir -p "$DIST_DIR" "$WORK_DIR"

"$PYTHON_BIN" -m PyInstaller \
  --noconfirm \
  --clean \
  --name emperor-agent \
  --onefile \
  --distpath "$DIST_DIR" \
  --workpath "$WORK_DIR/work" \
  --specpath "$WORK_DIR/spec" \
  --collect-submodules agent \
  --hidden-import mcp \
  --hidden-import mcp.client.sse \
  --hidden-import mcp.client.stdio \
  --add-data "$ROOT/templates/agent/compact_prompt.md:templates/agent" \
  "$ENTRY"

if [[ -f "$DIST_DIR/emperor-agent" ]]; then
  chmod +x "$DIST_DIR/emperor-agent"
fi

echo "Backend bundle written to $DIST_DIR"
