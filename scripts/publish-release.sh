#!/usr/bin/env bash
# Publishes the attested, unsigned Stable bundle as a GitHub Release
# (REL-05): the preflight (scripts/release-contract.mjs publication), then a
# draft with the rendered notes, its asset list checked against the bundle,
# then public. Any failure after the draft exists deletes it.
#
#   scripts/publish-release.sh <release-bundle>
#   scripts/publish-release.sh --dry-run <out-dir> <release-bundle>
#
# Needs EMPEROR_RELEASE_TAG and EMPEROR_RELEASE_COMMIT. --dry-run runs the
# same preflight and writes what it would send to GitHub into <out-dir>
# (draft-release.json: title, notes, assets, the gh commands in order;
# draft-release-notes.md); it never runs gh and needs no tag yet.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
DRY_RUN_OUT=""
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN_OUT="${2:?usage: publish-release.sh --dry-run <out-dir> <release-bundle>}"
  shift 2
fi
BUNDLE="${1:?usage: publish-release.sh [--dry-run <out-dir>] <release-bundle>}"
TAG="${EMPEROR_RELEASE_TAG:?EMPEROR_RELEASE_TAG is required}"
COMMIT="${EMPEROR_RELEASE_COMMIT:?EMPEROR_RELEASE_COMMIT is required}"
NOTES="$BUNDLE/RELEASE-NOTES.md"
TITLE="Emperor Agent $TAG"

[[ -d "$BUNDLE" ]] || { echo "Release bundle not found: $BUNDLE" >&2; exit 1; }

if [[ -n "$DRY_RUN_OUT" ]]; then
  # The same preflight (a dry run's one-architecture bundle allowed), then
  # the plan instead of gh.
  node "$ROOT/scripts/release-contract.mjs" draft-plan \
    "$BUNDLE" "$TAG" "$COMMIT" "$DRY_RUN_OUT"
  exit 0
fi

node "$ROOT/scripts/release-contract.mjs" publication "$BUNDLE" "$TAG" "$COMMIT"
(
  cd "$BUNDLE"
  shasum -a 256 -c SHA256SUMS.txt
)
TAG_COMMIT="$(git -C "$ROOT" rev-parse --verify "refs/tags/$TAG^{commit}")"
[[ "$TAG_COMMIT" == "$COMMIT" ]] || {
  echo "Stable tag $TAG is at $TAG_COMMIT, not at the release commit $COMMIT" >&2
  exit 1
}
if gh release view "$TAG" >/dev/null 2>&1; then
  echo "Release already exists: $TAG" >&2
  exit 1
fi

created=false
cleanup() {
  if [[ "$created" == true ]]; then
    gh release delete "$TAG" --yes >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

gh release create "$TAG" --draft --verify-tag --title "$TITLE" --notes-file "$NOTES"
created=true
gh release upload "$TAG" "$BUNDLE"/*

LOCAL_ASSETS="$(find "$BUNDLE" -maxdepth 1 -type f -exec basename {} \; | LC_ALL=C sort)" \
REMOTE_JSON="$(gh release view "$TAG" --json assets,isDraft,isPrerelease)" node <<'NODE'
const local = process.env.LOCAL_ASSETS.split('\n').filter(Boolean)
const remote = JSON.parse(process.env.REMOTE_JSON)
const names = remote.assets.map((asset) => asset.name).sort()
if (
  remote.isDraft !== true ||
  remote.isPrerelease !== false ||
  JSON.stringify(local) !== JSON.stringify(names)
) {
  throw new Error('draft release asset inventory mismatch')
}
NODE

gh release edit "$TAG" --draft=false
created=false
trap - EXIT
