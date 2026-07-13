#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
BUNDLE="${1:?usage: publish-preview-release.sh <preview-bundle>}"
TAG="${GITHUB_REF_NAME:?GITHUB_REF_NAME is required}"
COMMIT="${GITHUB_SHA:?GITHUB_SHA is required}"
RUN_ID="${GITHUB_RUN_ID:?GITHUB_RUN_ID is required}"
DEFAULT_BRANCH="${DEFAULT_BRANCH:?DEFAULT_BRANCH is required}"
NOTICE="$BUNDLE/UNSIGNED-PREVIEW-NOTICE.md"

[[ -d "$BUNDLE" ]] || { echo "Preview bundle not found: $BUNDLE" >&2; exit 1; }
node "$ROOT/scripts/preview-release-contract.mjs" assert "$TAG" preview
node "$ROOT/scripts/preview-publication-contract.mjs" \
  "$BUNDLE" "$TAG" "$COMMIT" "$RUN_ID"

TAG_COMMIT="$(git -C "$ROOT" rev-parse --verify "refs/tags/$TAG^{commit}")"
[[ "$TAG_COMMIT" == "$COMMIT" ]] || {
  echo "Preview tag commit does not match workflow commit" >&2
  exit 1
}
git -C "$ROOT" rev-parse --verify "refs/remotes/origin/$DEFAULT_BRANCH^{commit}" >/dev/null
if ! git -C "$ROOT" merge-base --is-ancestor \
  "$TAG_COMMIT" "refs/remotes/origin/$DEFAULT_BRANCH"; then
  echo "Preview tag commit is not reachable from the default branch" >&2
  exit 1
fi
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

gh release create "$TAG" \
  --draft \
  --prerelease \
  --verify-tag \
  --title "Emperor Agent $TAG · UNSIGNED-PREVIEW" \
  --notes-file "$NOTICE"
created=true
gh release upload "$TAG" "$BUNDLE"/*

LOCAL_ASSETS="$(find "$BUNDLE" -maxdepth 1 -type f -exec basename {} \; | LC_ALL=C sort)" \
REMOTE_JSON="$(gh release view "$TAG" --json assets,isDraft,isPrerelease)" node <<'NODE'
const local = process.env.LOCAL_ASSETS.split('\n').filter(Boolean)
const remote = JSON.parse(process.env.REMOTE_JSON)
const names = remote.assets.map((asset) => asset.name).sort()
if (
  remote.isDraft !== true ||
  remote.isPrerelease !== true ||
  JSON.stringify(local) !== JSON.stringify(names)
) {
  throw new Error('Preview draft release asset inventory mismatch')
}
NODE

gh release edit "$TAG" --draft=false --prerelease
created=false
trap - EXIT
