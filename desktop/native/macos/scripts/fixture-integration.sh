#!/bin/bash
set -euo pipefail

native_dir="$(cd "$(dirname "$0")/.." && pwd)"
arch="$(uname -m)"
"$native_dir/scripts/assemble-app.sh" "$arch" >/dev/null
if [[ "${EMPEROR_FIXTURE_ELECTRON_APP_MODE_ONLY:-}" == "1" || "${EMPEROR_FIXTURE_FINDER_FOCUS_ONLY:-}" == "1" || "${EMPEROR_FIXTURE_FINDER_CREATE_ONLY:-}" == "1" ]]; then
  fixture_app=""
elif [[ "${EMPEROR_FIXTURE_SCREENSHOT_ONLY:-}" == "1" || "${EMPEROR_FIXTURE_PREFLIGHT_ONLY:-}" == "1" ]]; then
  fixture_app="$native_dir/build/$arch/EmperorAXFixture.app"
else
  fixture_app="$("$native_dir/scripts/assemble-fixture.sh" "$arch" | tail -1)"
fi
if [[ -n "$fixture_app" ]]; then test -d "$fixture_app"; fi
genuine_fixture="$fixture_app"
if [[ "${EMPEROR_FIXTURE_CREDENTIAL_MISMATCH_ONLY:-}" == "1" ]]; then
  # Same bundle ID, but ad-hoc signed (no Team ID): a look-alike app that must
  # never receive a credential bound to the genuine fixture.
  mismatch_dir="$native_dir/build/$arch/credential-mismatch"
  rm -rf "$mismatch_dir"
  mkdir -p "$mismatch_dir"
  fixture_app="$mismatch_dir/EmperorAXFixture.app"
  ditto "$genuine_fixture" "$fixture_app"
  # Ad-hoc by default (no Team ID); EMPEROR_FIXTURE_MISMATCH_IDENTITY signs
  # the copy with a certificate of another team instead.
  codesign --force --deep --timestamp=none \
    --sign "${EMPEROR_FIXTURE_MISMATCH_IDENTITY:--}" "$fixture_app" >/dev/null 2>&1
  codesign --verify --deep --strict "$fixture_app"
  mismatch_team="$(codesign -dv --verbose=4 "$fixture_app" 2>&1 | sed -n 's/^TeamIdentifier=//p')"
  echo "credential-mismatch copy TeamIdentifier=${mismatch_team:-none}"
fi
main_fixture="$native_dir/build/$arch/fixture-harness"
socket_dir="$(mktemp -d /tmp/emperor-ax-fixture.XXXXXX)"
trap 'rm -rf "$socket_dir"' EXIT
main_app="$main_fixture/Emperor Agent.app"
helper_app="$main_app/Contents/Library/Helpers/Emperor Computer Helper.app"
launch_helper="$helper_app"
mkdir -p "$main_app/Contents/MacOS" "$(dirname "$helper_app")"
rm -rf "$helper_app"
cp -R "$native_dir/build/$arch/Emperor Computer Helper.app" "$helper_app"
swiftc -swift-version 6 -O -target "$arch-apple-macos14.0" \
  "$native_dir/Fixtures/EmperorAXFixture/IntegrationRunner.swift" \
  -o "$main_app/Contents/MacOS/Emperor Agent"
if [[ -n "${EMPEROR_DEV_SIGN_IDENTITY:-}" ]]; then
  # macOS attributes screen recording from a nested helper to its containing
  # app. Use the same signed helper as a standalone App for TCC acceptance.
  launch_helper="${EMPEROR_FIXTURE_HELPER_APP:-$native_dir/build/$arch/Emperor Computer Helper.app}"
  cat > "$main_app/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>com.emperor.agent.desktop</string>
  <key>CFBundleName</key><string>Emperor Agent</string>
  <key>CFBundleExecutable</key><string>Emperor Agent</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1</string>
</dict></plist>
PLIST
  codesign --force --options runtime --timestamp=none --sign "$EMPEROR_DEV_SIGN_IDENTITY" "$main_app"
  codesign --verify --deep --strict "$main_app"
fi
if [[ "${EMPEROR_FIXTURE_SCREENSHOT_ONLY:-}" == "1" || "${EMPEROR_FIXTURE_PREFLIGHT_ONLY:-}" == "1" || "${EMPEROR_FIXTURE_APP_MODE_ONLY:-}" == "1" || "${EMPEROR_FIXTURE_ELECTRON_APP_MODE_ONLY:-}" == "1" || "${EMPEROR_FIXTURE_FINDER_FOCUS_ONLY:-}" == "1" || "${EMPEROR_FIXTURE_FINDER_CREATE_ONLY:-}" == "1" ]]; then
  if [[ "${EMPEROR_FIXTURE_APP_MODE_ONLY:-}" != "1" && "${EMPEROR_FIXTURE_ELECTRON_APP_MODE_ONLY:-}" != "1" && "${EMPEROR_FIXTURE_FINDER_FOCUS_ONLY:-}" != "1" && "${EMPEROR_FIXTURE_FINDER_CREATE_ONLY:-}" != "1" ]]; then
    pgrep -x EmperorAXFixture >/dev/null
  fi
else
  pkill -x EmperorAXFixture >/dev/null 2>&1 || true
  for _ in {1..50}; do
    if ! pgrep -x EmperorAXFixture >/dev/null 2>&1; then break; fi
    sleep 0.1
  done
  fixture_args=(--pointer-file "$socket_dir/fixture.sock.pointer" --key-event-file "$socket_dir/fixture.sock.keys")
  # The leftmost display, for screenshot points at negative coordinates.
  if [[ "${EMPEROR_FIXTURE_LEFT_DISPLAY:-}" == "1" ]]; then fixture_args+=(--left-display); fi
  open -a "$fixture_app" --args "${fixture_args[@]}"
  sleep 2
fi
nonce="0123456789abcdef0123456789abcdef"
echo "TCC permission subject: $launch_helper"
log_dir="${EMPEROR_FIXTURE_LOG_DIR:-$native_dir/build/$arch/fixture-runs}"
mkdir -p "$log_dir"
if [[ "${EMPEROR_FIXTURE_APP_MODE_ONLY:-}" == "1" ]]; then
  run_mode="app-mode"
elif [[ "${EMPEROR_FIXTURE_ELECTRON_APP_MODE_ONLY:-}" == "1" ]]; then
  run_mode="electron-app-mode"
elif [[ "${EMPEROR_FIXTURE_SCREENSHOT_ONLY:-}" == "1" ]]; then
  run_mode="screenshot"
elif [[ "${EMPEROR_FIXTURE_PREFLIGHT_ONLY:-}" == "1" ]]; then
  run_mode="preflight"
elif [[ "${EMPEROR_FIXTURE_PROTECTED_ONLY:-}" == "1" ]]; then
  run_mode="protected"
elif [[ "${EMPEROR_FIXTURE_MODIFIER_ONLY:-}" == "1" ]]; then
  run_mode="modifier"
elif [[ "${EMPEROR_FIXTURE_POST_TO_PID_ONLY:-}" == "1" ]]; then
  run_mode="post-to-pid"
elif [[ "${EMPEROR_FIXTURE_FINDER_FOCUS_ONLY:-}" == "1" ]]; then
  run_mode="finder-focus"
elif [[ "${EMPEROR_FIXTURE_FINDER_CREATE_ONLY:-}" == "1" ]]; then
  run_mode="finder-create"
elif [[ "${EMPEROR_FIXTURE_CREDENTIAL_MISMATCH_ONLY:-}" == "1" ]]; then
  run_mode="credential-mismatch"
else
  run_mode="full"
fi
run_output="$log_dir/$(date -u '+%Y%m%dT%H%M%SZ')-$$-$run_mode.log"
fixture_executable="${fixture_app:+$fixture_app/Contents/MacOS/EmperorAXFixture}"
runner_args=("$launch_helper" "$socket_dir/fixture.sock" "$nonce" "${fixture_executable:-/dev/null}")
if [[ -n "${EMPEROR_DEV_SIGN_IDENTITY:-}" && -n "$fixture_app" ]]; then
  # The expected Team ID is always the genuine fixture's (a look-alike copy
  # in the mismatch mode has none).
  team_id="$(codesign -dv --verbose=4 "$genuine_fixture" 2>&1 | sed -n 's/^TeamIdentifier=//p')"
  test -n "$team_id"
  runner_args+=("$team_id")
fi
set +e
"$main_app/Contents/MacOS/Emperor Agent" "${runner_args[@]}" \
  2>&1 | tee "$run_output" "$native_dir/build/$arch/fixture-integration-output.txt"
run_status=("${PIPESTATUS[@]}")
status="${run_status[0]}"
if (( status == 0 && run_status[1] != 0 )); then
  status="${run_status[1]}"
fi
set -e
echo "Fixture run log: $run_output"
exit "$status"
