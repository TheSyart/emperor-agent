#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$ROOT"

echo "== git diff --check =="
git diff --check

echo "== prettier --check =="
npm run format:check

echo "== bash -n =="
while IFS= read -r script; do
  bash -n "$script"
done < <(git ls-files '*.sh')

echo "== public documentation boundaries =="
node scripts/check_public_docs.mjs

echo "== core vitest =="
npm test --workspace @emperor/core

echo "== core typecheck =="
npm run typecheck --workspace @emperor/core

echo "== core eslint =="
npm run lint --workspace @emperor/core

echo "== ACP stdio bundle =="
npm run build:acp --workspace @emperor/core
node scripts/test-acp-bundle.mjs

echo "== desktop vitest =="
npm --prefix desktop run test

echo "== desktop test typecheck =="
npm --prefix desktop run typecheck:test

echo "== vue-tsc + tsc =="
npm --prefix desktop run typecheck

echo "== desktop eslint =="
npm --prefix desktop run lint

echo "== electron-vite build =="
npm --prefix desktop run build
