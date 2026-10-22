#!/usr/bin/env bash
# The reproducible CycloneDX 1.6 SBOM of a Stable release (REL-05): Core and
# Desktop from their lockfiles, merged into one document. The release job
# and scripts/release-dry-run.mjs both run this.
#
#   scripts/generate-release-sbom.sh <output.cdx.json>
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_ARG="${1:?usage: generate-release-sbom.sh <output.cdx.json>}"
mkdir -p "$(dirname "$OUT_ARG")"
OUT="$(cd "$(dirname "$OUT_ARG")" && pwd)/$(basename "$OUT_ARG")"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/emperor-sbom.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

cd "$ROOT"
npx --yes @cyclonedx/cyclonedx-npm@6.0.0 \
  --package-lock-only \
  --output-reproducible \
  --spec-version 1.6 \
  --output-format JSON \
  --validate \
  --output-file "$WORK/core.cdx.json"
npx --yes @cyclonedx/cyclonedx-npm@6.0.0 \
  --package-lock-only \
  --ignore-npm-errors \
  --output-reproducible \
  --spec-version 1.6 \
  --output-format JSON \
  --validate \
  --output-file "$WORK/desktop.cdx.json" \
  desktop/package.json
node scripts/merge-cyclonedx-sboms.mjs \
  "$WORK/core.cdx.json" \
  "$WORK/desktop.cdx.json" \
  "$OUT"
