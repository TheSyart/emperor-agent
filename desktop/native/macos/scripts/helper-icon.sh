#!/bin/bash
set -euo pipefail

# Emperor's icon as an .icns for a helper bundle (RV-07). Without one, the
# helpers show a blank icon in macOS permission prompts and in
# System Settings › Privacy & Security. Made from desktop/build/icon.png
# (1024px) with sips and iconutil; a missing or broken image stops the
# build instead of leaving a helper without an icon.

if [[ $# -ne 1 && $# -ne 2 ]]; then
  echo 'usage: helper-icon.sh <output.icns> [source.png]' >&2
  exit 2
fi

native_dir="$(cd "$(dirname "$0")/.." && pwd)"
output="$1"
source_png="${2:-$native_dir/../../build/icon.png}"
fail() {
  echo "helper-icon.sh: $*" >&2
  exit 1
}

[[ -s "$source_png" ]] || fail "no image at $source_png"
work="$(mktemp -d "${TMPDIR:-/tmp}/emperor-helper-icon.XXXXXX")"
trap 'rm -rf "$work"' EXIT
iconset="$work/icon.iconset"
mkdir "$iconset"
for size in 16 32 128 256 512; do
  for scale in 1 2; do
    pixels=$((size * scale))
    name="icon_${size}x${size}"
    if [[ $scale -eq 2 ]]; then name="${name}@2x"; fi
    # sips skips an unreadable file with a warning and exits 0: check the result.
    sips -z "$pixels" "$pixels" "$source_png" --out "$iconset/$name.png" >/dev/null ||
      fail "sips could not read $source_png"
    [[ -s "$iconset/$name.png" ]] || fail "sips could not read $source_png"
  done
done
iconutil --convert icns --output "$work/icon.icns" "$iconset" ||
  fail "iconutil could not make an icon from $source_png"
[[ "$(head -c 4 "$work/icon.icns")" == "icns" ]] || fail "iconutil made no icon"
mkdir -p "$(dirname "$output")"
mv "$work/icon.icns" "$output"
