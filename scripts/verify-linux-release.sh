#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
DIST="$ROOT/desktop/dist"
MODE="${1:-}"

if [[ "$(uname -s)" != "Linux" || "$(uname -m)" != "x86_64" ]]; then
  echo "Linux release verification requires Linux x86_64" >&2
  exit 1
fi

find_one() {
  local pattern="$1"
  local -n output="$2"
  mapfile -d '' -t matches < <(find "$DIST" -maxdepth 1 -type f -name "$pattern" -print0)
  if [[ "${#matches[@]}" -ne 1 ]]; then
    echo "Expected exactly one $pattern artifact, found ${#matches[@]}" >&2
    exit 1
  fi
  output="${matches[0]}"
}

find_one 'Emperor-Agent-*-linux-x64.AppImage' APPIMAGE
find_one 'Emperor-Agent-*-linux-x64.deb' DEB
CHECKSUMS="$DIST/SHA256SUMS-linux-x64.txt"
DEB_PACKAGE=''

prepare() {
  chmod 755 "$APPIMAGE"
  dpkg-deb --info "$DEB" >/dev/null
  local package architecture
  package="$(dpkg-deb --field "$DEB" Package)"
  architecture="$(dpkg-deb --field "$DEB" Architecture)"
  if [[ -z "$package" || "$architecture" != "amd64" ]]; then
    echo "Invalid DEB package metadata" >&2
    exit 1
  fi
  (
    cd "$DIST"
    sha256sum "$(basename "$APPIMAGE")" "$(basename "$DEB")" \
      >"$(basename "$CHECKSUMS")"
  )
  local receipt_dir="$DIST/release-receipts"
  local commit="${EMPEROR_RELEASE_COMMIT:-${GITHUB_SHA:-$(git -C "$ROOT" rev-parse HEAD)}}"
  mkdir -p "$receipt_dir"
  RECEIPT_PATH="$receipt_dir/linux-x64-build.json" COMMIT="$commit" \
  APPIMAGE_NAME="$(basename "$APPIMAGE")" DEB_NAME="$(basename "$DEB")" \
  PACKAGE_NAME="$package" node <<'NODE'
const fs = require('node:fs')
const receipt = {
  schemaVersion: 1,
  commit: process.env.COMMIT,
  platform: 'linux',
  arch: 'x64',
  package: process.env.PACKAGE_NAME,
  debArchitecture: 'amd64',
  metadataVerified: true,
  artifacts: [process.env.APPIMAGE_NAME, process.env.DEB_NAME],
}
fs.writeFileSync(process.env.RECEIPT_PATH, `${JSON.stringify(receipt, null, 2)}\n`)
NODE
}

classify_smoke_failure() {
  local label="$1"
  local output="$2"
  if grep -Eiq 'fuse|appimage.*mount|dlopen.*libfuse' "$output"; then
    echo "$label: AppImage wrapper/FUSE failure" >&2
  elif grep -Eiq 'suid sandbox|no usable sandbox|zygote.*sandbox|sandbox.*failed' "$output"; then
    echo "$label: Chromium sandbox failure" >&2
  else
    echo "$label: application smoke failure" >&2
  fi
  cat "$output" >&2
}

run_smoke() {
  local label="$1"
  local executable="$2"
  local receipt_source="$DIST/packaged-smoke/linux-x64.json"
  local output
  output="$(mktemp)"
  rm -f "$receipt_source"
  if [[ "$label" == "appimage" ]]; then
    if ! APPIMAGE_EXTRACT_AND_RUN=1 EMPEROR_SMOKE_APP="$executable" \
      node "$ROOT/desktop/scripts/run-packaged-smoke.cjs" >"$output" 2>&1; then
      classify_smoke_failure "$label" "$output"
      rm -f "$output"
      return 1
    fi
  elif ! EMPEROR_SMOKE_APP="$executable" \
    node "$ROOT/desktop/scripts/run-packaged-smoke.cjs" >"$output" 2>&1; then
    classify_smoke_failure "$label" "$output"
    rm -f "$output"
    return 1
  fi
  cat "$output"
  rm -f "$output"
  if [[ ! -f "$receipt_source" ]]; then
    echo "$label smoke did not produce a receipt" >&2
    return 1
  fi
  cp "$receipt_source" "$RECEIPT_DIR/${UBUNTU_VERSION}-${label}.json"
}

smoke() {
  if [[ ! -f "$CHECKSUMS" ]]; then
    echo "Missing Linux checksum manifest" >&2
    exit 1
  fi
  (
    cd "$DIST"
    sha256sum --check "$(basename "$CHECKSUMS")"
  )

  # shellcheck disable=SC1091
  source /etc/os-release
  if [[ "${ID:-}" != "ubuntu" || ! "${VERSION_ID:-}" =~ ^(22\.04|24\.04)$ ]]; then
    echo "Linux smoke supports only Ubuntu 22.04 or 24.04" >&2
    exit 1
  fi
  UBUNTU_VERSION="$VERSION_ID"
  RECEIPT_DIR="$DIST/linux-receipts"
  mkdir -p "$RECEIPT_DIR"
  chmod 755 "$APPIMAGE"
  run_smoke appimage "$APPIMAGE"

  local installed_executable=''
  DEB_PACKAGE="$(dpkg-deb --field "$DEB" Package)"
  cleanup_deb() {
    if [[ -n "$DEB_PACKAGE" ]] && dpkg-query -W "$DEB_PACKAGE" >/dev/null 2>&1; then
      sudo apt-get remove --yes "$DEB_PACKAGE" || true
    fi
  }
  trap cleanup_deb EXIT
  sudo env DEBIAN_FRONTEND=noninteractive apt-get install --yes "$DEB"
  while IFS= read -r candidate; do
    if [[ -f "$candidate" && -x "$candidate" && "$(basename "$candidate")" == 'emperor-agent' ]]; then
      installed_executable="$candidate"
      break
    fi
  done < <(dpkg -L "$DEB_PACKAGE")
  if [[ -z "$installed_executable" ]]; then
    echo "Installed Emperor Agent executable was not found in the DEB file list" >&2
    exit 1
  fi
  run_smoke deb "$installed_executable"
  sudo apt-get remove --yes "$DEB_PACKAGE"
  trap - EXIT
  if dpkg-query -W -f='${db:Status-Status}' "$DEB_PACKAGE" 2>/dev/null \
    | grep -qx 'installed'; then
    echo "DEB package remained installed after removal" >&2
    exit 1
  fi
  local commit="${EMPEROR_RELEASE_COMMIT:-${GITHUB_SHA:-$(git -C "$ROOT" rev-parse HEAD)}}"
  RECEIPT_PATH="$RECEIPT_DIR/${UBUNTU_VERSION}-lifecycle.json" \
  COMMIT="$commit" UBUNTU_VERSION="$UBUNTU_VERSION" node <<'NODE'
const fs = require('node:fs')
const receipt = {
  schemaVersion: 1,
  commit: process.env.COMMIT,
  platform: 'linux',
  arch: 'x64',
  ubuntuVersion: process.env.UBUNTU_VERSION,
  appImageSmoke: true,
  debInstall: true,
  debSmoke: true,
  debRemove: true,
}
fs.writeFileSync(process.env.RECEIPT_PATH, `${JSON.stringify(receipt, null, 2)}\n`)
NODE
}

case "$MODE" in
  prepare) prepare ;;
  smoke) smoke ;;
  *)
    echo "Usage: $0 prepare|smoke" >&2
    exit 2
    ;;
esac
