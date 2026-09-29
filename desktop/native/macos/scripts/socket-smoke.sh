#!/bin/bash
set -euo pipefail

# Protocol and socket checks only: no permission request, no TCC change and
# no synthetic keyboard or mouse input (act and act.fillSecret name a missing
# target; input.releaseAll has nothing held to release).
native_dir="$(cd "$(dirname "$0")/.." && pwd)"
arch="$(uname -m)"
mkdir -p "$native_dir/build/$arch"
fixture="$(mktemp -d "$native_dir/build/$arch/socket-smoke.XXXXXX")"
socket_dir="$(mktemp -d /tmp/emperor-cu-smoke.XXXXXX)"
trap 'rm -rf "$fixture" "$socket_dir"' EXIT
# Build into the fixture, so the development helper and its TCC grants stay.
"$native_dir/scripts/assemble-app.sh" "$arch" "$fixture/helper-build" >/dev/null
app="$fixture/Emperor Agent.app"
helper="$app/Contents/Library/Helpers/Emperor Computer Helper.app"
mkdir -p "$app/Contents/MacOS" "$(dirname "$helper")"
cp -R "$fixture/helper-build/Emperor Computer Helper.app" "$helper"
clang -Wall -Wextra -Werror "$native_dir/scripts/socket-smoke.c" -o "$app/Contents/MacOS/Emperor Agent"
nonce="0123456789abcdef0123456789abcdef"
"$app/Contents/MacOS/Emperor Agent" "$helper" "$socket_dir/bad.sock" "$nonce" --bad-nonce \
  | tee "$native_dir/build/$arch/socket-smoke-output.txt"
"$app/Contents/MacOS/Emperor Agent" "$helper" "$socket_dir/cu.sock" "$nonce" \
  | tee -a "$native_dir/build/$arch/socket-smoke-output.txt"
