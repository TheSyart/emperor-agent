#!/usr/bin/env bash
# The macOS PR gate (REL-04, MAIN-29); ci.yml runs it, and so can you:
#
#   scripts/ci/pr-gate.sh                make check, package:verify, unsealed probes
#   scripts/ci/pr-gate.sh --build-only   desktop build instead of make check (Intel job)
#   scripts/ci/pr-gate.sh --app <.app>   only the packaged smoke, on a build you have
#   scripts/ci/pr-gate.sh --dry-run      print the steps, run nothing
#
# package:verify packs the unsigned, ad-hoc sealed app (desktop/dist) and runs
# the packaged smoke on it: the seal, hardened runtime, fuses, secrets without
# the Keychain, the helpers, the Native Messaging host, CSP, refused protocol
# traversal, closing and reopening the window, a clean quit, and a
# 0.1.0-preview.4 Emperor Home. The unsealed probes then prove the same gate
# fails on copies whose seal, runtime or fuses were taken away.
set -euo pipefail

usage() {
  echo "usage: scripts/ci/pr-gate.sh [--build-only] [--app <Emperor Agent.app>] [--dry-run]" >&2
  exit 2
}

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
mode=full
app=""
dry_run=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --build-only) mode=build ;;
    --app)
      [ "$#" -ge 2 ] || usage
      app="$2"
      shift
      ;;
    --dry-run) dry_run=1 ;;
    *) usage ;;
  esac
  shift
done

step() {
  echo "pr-gate: $*"
  if [ "$dry_run" = 0 ]; then
    (cd "$ROOT" && "$@")
  fi
}

if [ -n "$app" ]; then
  app="${app%/}"
  step node desktop/scripts/run-packaged-smoke.cjs --app "$app/Contents/MacOS/Emperor Agent"
  exit 0
fi

if [ "$mode" = full ]; then
  step ./scripts/check.sh
else
  step npm --prefix desktop run build
fi
step npm --prefix desktop run package:verify
step node scripts/ci/gate-negative-probe.mjs
