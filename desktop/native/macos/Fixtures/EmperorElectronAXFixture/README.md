# Electron AX mode fixture

This disposable local Electron app has one window with an input and a button.
It is used only to test `AXManualAccessibility` discovery and restoration; it
does not load a remote page or user files.

Launch the repository's installed Electron **executable directly** with the
absolute path of this directory as its app argument:

```sh
desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron \
  "$PWD/desktop/native/macos/Fixtures/EmperorElectronAXFixture"
```

The optional `--force-accessibility` flag calls Electron's
`app.setAccessibilitySupportEnabled(true)` before the window opens. Close the
fixture window after the experiment.

With the signed macOS Helper already authorized for Accessibility and Screen
Recording, run `scripts/fixture-integration.sh` with
`EMPEROR_FIXTURE_ELECTRON_APP_MODE_ONLY=1`,
`EMPEROR_FIXTURE_APP_MODE_ACTIVATE=1`, and the Helper signing identity. The
runner targets only the exact `Emperor Electron AX Fixture` window in the
`com.github.Electron` process. It logs the pre-bind status of
`AXManualAccessibility` and `AXWindows`, then asks the Helper to list, bind,
observe, and release that window. Set `EMPEROR_FIXTURE_HELPER_STDERR` to an
absolute test log path to inspect `APP_MODE` enable/restore diagnostics.

On 2026-09-26 macOS 26.4.1, `open -na Electron.app --args ...` launched a
process whose application AX attributes returned `-25204`; the Helper refused
window discovery. Directly launching the executable produced a visible window
and readable `AXManualAccessibility=false`. The signed Helper then bound and
observed the fixture, recorded `enabled original=false` on bind and
`restored writeSucceeded=true matchesOriginal=true` on release. The runner
independently read the original mode again after release. Use the direct
executable launch for this experiment. The cause of the LaunchServices path
difference remains unverified.
