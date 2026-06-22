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

cd "$ROOT"

echo "== git diff --check =="
git diff --check

echo "== py_compile =="
"$PYTHON_BIN" -m py_compile $(find agent -name '*.py' -not -path '*/__pycache__/*')

echo "== ruff =="
"$PYTHON_BIN" -m ruff check agent tests

echo "== pytest =="
"$PYTHON_BIN" -m pytest -q

echo "== vitest =="
npm --prefix desktop run test

echo "== electron-vite build =="
npm --prefix desktop run build

echo "== vue-tsc + tsc =="
npm --prefix desktop run typecheck
