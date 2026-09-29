#!/bin/bash
set -euo pipefail

usage() {
  echo 'usage: manifest.sh generate <host-binary> <extension-id> [output-json]' >&2
  echo '       manifest.sh install <browser> <host-binary> <extension-id>' >&2
  echo '       manifest.sh uninstall <browser> <host-binary>' >&2
  echo 'browsers: chrome chrome-beta chrome-dev chrome-canary chrome-for-testing chromium edge' >&2
  exit 2
}

[[ $# -ge 1 ]] || usage
mode="$1"
shift

case "$mode" in
  generate)
    [[ $# -eq 2 || $# -eq 3 ]] || usage
    host="$1"
    extension_id="$2"
    if [[ $# -eq 3 ]]; then
      "$host" --manifest --host-path "$host" --extension-id "$extension_id" > "$3"
    else
      "$host" --manifest --host-path "$host" --extension-id "$extension_id"
    fi
    ;;
  install)
    [[ $# -eq 3 ]] || usage
    browser="$1"
    host="$2"
    extension_id="$3"
    "$host" --install --browser "$browser" --host-path "$host" --extension-id "$extension_id"
    ;;
  uninstall)
    [[ $# -eq 2 ]] || usage
    browser="$1"
    host="$2"
    "$host" --uninstall --browser "$browser"
    ;;
  *) usage ;;
esac
