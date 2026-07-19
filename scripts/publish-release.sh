#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
BUNDLE="${1:?usage: publish-release.sh <release-bundle>}"
TAG="${EMPEROR_RELEASE_TAG:-${GITHUB_REF_NAME:-}}"
[[ -n "$TAG" ]] || { echo 'EMPEROR_RELEASE_TAG or GITHUB_REF_NAME is required' >&2; exit 1; }

[[ -d "$BUNDLE" ]] || { echo "Release bundle not found: $BUNDLE" >&2; exit 1; }
[[ ! -e "$BUNDLE/UNSIGNED-INTERNAL.txt" ]] || { echo 'Unsigned internal bundle cannot be published' >&2; exit 1; }
git -C "$ROOT" rev-parse --verify "refs/tags/$TAG^{commit}" >/dev/null
if gh release view "$TAG" >/dev/null 2>&1; then
  echo "Release already exists: $TAG" >&2
  exit 1
fi
BUNDLE="$BUNDLE" node <<'NODE'
const fs = require('node:fs')
const path = require('node:path')
const bundle = process.env.BUNDLE
const actual = fs.readdirSync(bundle, { withFileTypes: true })
if (actual.some((entry) => !entry.isFile())) {
  throw new Error('release bundle must contain regular files only')
}
const expected = actual
  .map((entry) => entry.name)
  .filter((name) => name !== 'SHA256SUMS.txt')
  .sort()
const checksums = fs
  .readFileSync(path.join(bundle, 'SHA256SUMS.txt'), 'utf8')
  .trim()
  .split(/\r?\n/)
  .map((line) => {
    const match = /^[a-f0-9]{64}\s+\*?(.+)$/i.exec(line)
    if (!match) throw new Error('invalid release checksum manifest')
    return match[1]
  })
  .sort()
if (JSON.stringify(expected) !== JSON.stringify(checksums)) {
  throw new Error('release checksum manifest does not cover the full bundle')
}
NODE
(
  cd "$BUNDLE"
  sha256sum --check SHA256SUMS.txt
)

created=false
cleanup() {
  if [[ "$created" == true ]]; then
    gh release delete "$TAG" --yes >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

gh release create "$TAG" --draft --verify-tag --title "Emperor Agent $TAG" --generate-notes
created=true
gh release upload "$TAG" "$BUNDLE"/*

LOCAL_ASSETS="$(find "$BUNDLE" -maxdepth 1 -type f -exec basename {} \; | LC_ALL=C sort)" \
REMOTE_JSON="$(gh release view "$TAG" --json assets,isDraft)" node <<'NODE'
const local = process.env.LOCAL_ASSETS.split('\n').filter(Boolean)
const remote = JSON.parse(process.env.REMOTE_JSON)
const names = remote.assets.map((asset) => asset.name).sort()
if (remote.isDraft !== true || JSON.stringify(local) !== JSON.stringify(names)) {
  throw new Error('draft release asset inventory mismatch')
}
NODE

gh release edit "$TAG" --draft=false
created=false
trap - EXIT
