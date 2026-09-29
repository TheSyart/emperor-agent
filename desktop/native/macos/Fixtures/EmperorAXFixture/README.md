# Emperor AX Fixture

`scripts/assemble-fixture.sh arm64` builds the AppKit fixture at
`build/arm64/EmperorAXFixture.app`. The app contains a button, username field,
secure password field, popup, table, scrollable text with a visible scroll
status, a painted view with no
accessibility children, a menu and context menu, a sheet button, and a window
movement button. The painted view reports `Status: canvas clicked` for a click
and `Status: canvas dragged` while dragging; the long content reports
`Status: scrolled` when its clip origin moves.
Text is typed into the fixture's process with `CGEventPostToPid` (E-M6b);
the system clipboard is never used.

Run `scripts/fixture-integration.sh` from `desktop/native/macos/`. It assembles
the fixture and helper, launches both, and saves the runner output to a unique
`build/<arch>/fixture-runs/<timestamp>-<pid>-<mode>.log` file. The latest runner
output is also copied to `build/<arch>/fixture-integration-output.txt` for
quick inspection. Set `EMPEROR_FIXTURE_LOG_DIR` to retain the unique logs in
another directory. Exit 0 means the automated
assertions passed. Exit 77 means the helper reported missing Accessibility or
Screen Recording permission; no AX or input assertion has run. Any other exit
code is a failure. The fixture remains open for inspection.

With a display left of the main one, set `EMPEROR_FIXTURE_LEFT_DISPLAY=1` to
open the fixture window there. Its global coordinates are negative, so the
screenshot-point click and the drag run at negative coordinates on that
display's scale; the log prints the window origin and the screenshot scale.
Without such a display the window stays on the main one and the log says the
check is not applicable.

On the first run, the script makes **Emperor Computer Helper** request Screen
Recording and Accessibility from macOS. If the script exits 77, enable the
helper in both System Settings lists and rerun it. If Screen Recording does not
list the Helper, use its “+” button to add the actual App path printed by the
script. A status check alone does not create an entry. Ad hoc runs launch the
nested helper at
`build/<arch>/fixture-harness/Emperor Agent.app/Contents/Library/Helpers/Emperor Computer Helper.app`;
ad hoc builds may need the grants repeated after binary changes.
For repeated development runs, set `EMPEROR_DEV_SIGN_IDENTITY` to a valid
Apple code-signing identity. The script signs both the helper and its fixture
parent with that identity and launches the standalone copy at
`build/<arch>/Emperor Computer Helper.app`. On macOS 26.4.1, a nested signed
helper with a granted Screen Recording TCC record still reports `denied`, while
the same standalone App reports `granted`. A stable certificate requirement
avoids rebinding TCC to each ad hoc binary hash.
If System Settings shows the helper enabled but `permissions.status` still says
`denied` after an ad hoc rebuild, the Accessibility record may still bind the
previous binary hash. Check the current helper's `codesign -dv --verbose=4`
`CandidateCDHash` against the Accessibility `csreq` in the system TCC database
before changing anything. If they differ, run
`tccutil reset Accessibility com.emperor.agent.desktop.computer-helper`, rerun
this script to register the current helper, and enable **only** its Accessibility
switch again. Do not reset Screen Recording when it is already granted.
The script checks AX roles, redaction of secure fields, a PNG screenshot, AX
button press, the background routes (with Finder in front: the fixture's menus
are listed without the Apple menu, `Fixture > Menu Action` runs without
activating the fixture, a drag is refused before dispatch, only an explicit
`activate` brings the fixture forward, and `front.restore` hands the front back
to Finder), keyboard focus, mixed Unicode typing, long background typing read back
exactly, a stop between typing chunks that leaves a strict prefix, cancellation after the
painted canvas receives a real mouse down and confirmation of mouse up, painted-view coordinate
click, username/password AX-only credential fill, stale screenshot rejection
after window movement, and `input.releaseAll`. It uses dummy fixture values and
does not print the dummy password.

For E-M6, set `EMPEROR_FIXTURE_MODIFIER_ONLY=1` with the signed Helper identity.
The runner focuses the disposable Username field, posts a synthetic Shift down
from a separate HID-state event source, verifies the combined session sees
Shift, then asks the Helper to press unmodified `A`. The fixture records the
received key event flags and character; the runner requires `shift=false`,
`characters=a`, and the AX field value `a`. It always posts Shift up, including
on failure. This tests an externally posted modifier, not a person's physical
key held down.

Set `EMPEROR_FIXTURE_POST_TO_PID_ONLY=1` for the other E-M6 experiment. The
runner makes its own small probe window frontmost, confirms the fixture is
background, and posts an unmodified `A` key down/up directly to the fixture
PID. It records whether the fixture's event monitor received the key. This is
an AppKit fixture observation only; the production Helper still uses HID
delivery and requires a foreground target.

For a read-only protected-App check, set `EMPEROR_FIXTURE_PROTECTED_ONLY=1`
when running `scripts/fixture-integration.sh`. The runner checks every
protected bundle ID that is currently running: none may appear in `apps.list`
or its own `windows.list(appId)`. It then shuts down the helper without running
the action matrix. Include `EMPEROR_DEV_SIGN_IDENTITY` for the stable signed
Helper that has already been granted macOS permissions.

For a signed packaged-Helper comparison, set `EMPEROR_FIXTURE_HELPER_APP` to
the absolute path of the Helper App to launch. This overrides only the Helper
used by the fixture runner; it does not modify the package. Combine it with
`EMPEROR_FIXTURE_TEXTEDIT_DISCOVERY_ONLY=1` to check whether that exact signed
Helper can list an existing TextEdit window without binding or acting on it.

For a read-only screenshot check of an already running fixture window, set
`EMPEROR_FIXTURE_SCREENSHOT_ONLY=1`. This mode preserves the running fixture,
does not activate it, and reports its frontmost App, AX window bounds, and PNG
dimensions. It is useful after changing the window to full screen or another
desktop space. Use `EMPEROR_DEV_SIGN_IDENTITY` for the TCC-authorized Helper.

For the Finder inline-editor regression, create an empty `未命名文件夹` inside the
disposable `/tmp/emperor-cu-finder.hkkl9E` directory, open that directory in
Finder, and select only the folder. Set `EMPEROR_FIXTURE_FINDER_FOCUS_ONLY=1`
with the signed Helper identity. The runner binds only the Finder window titled
`emperor-cu-finder.hkkl9E`; it renames the selected folder, creates another
folder with Finder's keyboard shortcut, and renames that new folder. It checks
both resulting paths and leaves them in place for independent inspection.
After verification, remove only the newly created empty folder and rename the
original folder back. If the target window is in another desktop Space, the
runner stops before acting; bring it into the current Space and rerun.

Set `EMPEROR_FIXTURE_FINDER_CREATE_ONLY=1` to test only the new-folder flow.
Start with `external-change` and `未命名文件夹` in the same disposable directory;
the runner does not require an initial selection. It sends one
`Meta+Shift+N`, observes the selected new folder, types
`emperor-cu-created-fixture.hkkl9E`, observes again, presses Return, and checks
the resulting path. It leaves the new folder for independent inspection;
remove that exact empty folder after verification. Set
`EMPEROR_FIXTURE_HELPER_STDERR` to an absolute temporary path to capture the
Helper's content-free focus diagnostics when macOS overlays intercept an input
point.

For the foreground preflight regression, leave the fixture running, open its
**Show Sheet** button, then run with `EMPEROR_FIXTURE_PREFLIGHT_ONLY=1`. The
runner targets the underlying main window and requires `TARGET_NOT_VISIBLE`
without an `act.dispatched` event. Close the sheet after the check. This mode
also preserves the running fixture and does not activate it.

For the Chrome AX app-mode experiment, show the local test page in a Chrome
window titled `Emperor Chrome fixture - Google Chrome`, then run with
`EMPEROR_FIXTURE_APP_MODE_ONLY=1` and the signed Helper identity. This mode
does not launch or alter the AppKit fixture. It binds only that exact Chrome
window, observes the AX tree, releases the target, and reports whether its
window bounds changed. The Helper writes no log file or persistent unified
log; it reports `APP_MODE event=enabled|unchanged|restored` lines on stderr.
Set `EMPEROR_FIXTURE_HELPER_STDERR=/absolute/file` so the runner passes
`open --stderr` and inspect those lines to confirm whether
`AXEnhancedUserInterface` was enabled and its original value restored; the
runner's `PASS` alone does not establish either property.
For a foreground experiment, set `EMPEROR_FIXTURE_APP_MODE_WAIT_SECONDS=20`
and switch to the fixture window during that interval. The runner samples
`apps.list` again after the wait, so its `frontmost` report reflects the
window placement at the time of `windows.list`.
Set `EMPEROR_FIXTURE_APP_MODE_ACTIVATE=1` to have the fixture runner request
Chrome activation, run its AppKit event loop briefly, and record which App
actually became frontmost before window discovery. This mode still only binds
the exact local fixture window and never sends input to Chrome.
`EMPEROR_FIXTURE_ELECTRON_APP_MODE_ONLY=1` selects the separate minimal Electron
fixture described in `../EmperorElectronAXFixture/README.md`.

Manual checks after permission is available: open the popup, table, menu,
context menu, and sheet; scroll the long content; revoke Accessibility during
an action and confirm the next action is refused; stop the helper during an
input action and confirm no key or mouse button remains down; run once with a
different Team ID using a real development signature. These cases remain
unverified until they are actually performed and recorded.
