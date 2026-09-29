#!/bin/bash
set -euo pipefail

native_dir="$(cd "$(dirname "$0")" && pwd)"
arch="${1:-$(uname -m)}"
mode="${2:-release}"

if [[ "$arch" != "arm64" && "$arch" != "x86_64" ]]; then
  echo 'usage: build.sh [arm64|x86_64] [release|fixture]' >&2
  exit 2
fi
if [[ "$mode" != "release" && "$mode" != "fixture" ]]; then
  echo 'usage: build.sh [arm64|x86_64] [release|fixture]' >&2
  exit 2
fi

output_dir="$native_dir/build/$arch/$mode"
mkdir -p "$output_dir"
output="$output_dir/emperor-nm-host"
flags=(-O -warnings-as-errors -target "$arch-apple-macosx14.0" -framework Security)
if [[ "$mode" == "fixture" ]]; then
  flags+=(-D NM_TESTING)
fi

xcrun swiftc "${flags[@]}" "$native_dir/main.swift" -o "$output"
codesign --force --sign - --timestamp=none "$output" >/dev/null
codesign --verify --strict "$output"
printf '%s\n' "$output"
