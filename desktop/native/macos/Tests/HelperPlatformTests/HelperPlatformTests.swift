import ApplicationServices
import CoreGraphics
import Foundation
import HelperCore
@testable import HelperPlatform
import XCTest

final class HelperPlatformTests: XCTestCase {
    func testTypingRequiresAnEditableFocusedTextControl() {
        XCTAssertFalse(TextEntryPreflight.allowsTyping(role: "AXList", valueSettable: false),
                       "Finder type-to-select must not count as text entry")
        XCTAssertFalse(TextEntryPreflight.allowsTyping(role: "AXTextField", valueSettable: false),
                       "A read-only field cannot receive typed text")
        XCTAssertTrue(TextEntryPreflight.allowsTyping(role: "AXTextField", valueSettable: true))
        XCTAssertTrue(TextEntryPreflight.allowsTyping(role: "AXTextArea", valueSettable: true))
        XCTAssertFalse(TextEntryPreflight.allowsTyping(role: "AXSecureTextField", valueSettable: true))
    }

    func testTypedTextIsConfirmedByAChangedCharacterCount() {
        XCTAssertTrue(TextLengthPostcondition.changed(before: 120, after: 143))
        XCTAssertFalse(TextLengthPostcondition.changed(before: 120, after: 120))
        XCTAssertFalse(TextLengthPostcondition.changed(before: 120, after: nil),
                       "An unreadable count after typing is not evidence")
        XCTAssertFalse(TextLengthPostcondition.changed(before: nil, after: 143))
    }

    func testProcessTargetedKeysStopAtTheKillSwitch() throws {
        let gate = HeldInputGate()
        gate.begin()
        var posted = 0
        try gate.postUnheld { posted += 1 }
        gate.cancel(keyUp: { _ in XCTFail("nothing is held") }, mouseUp: { _ in XCTFail("nothing is held") })
        XCTAssertThrowsError(try gate.postUnheld { posted += 1 }) { error in
            XCTAssertEqual((error as? NativeError)?.code, "USER_TAKEOVER")
        }
        XCTAssertEqual(posted, 1, "no event may leave after the stop")
        gate.begin()
        try gate.postUnheld { posted += 1 }
        XCTAssertEqual(posted, 2)
    }

    func testKeysGoToTheBackgroundExceptWhereOnlyTheForegroundPathIsProven() {
        XCTAssertTrue(KeyboardDeliveryPolicy.background(bundleID: "com.apple.TextEdit"))
        XCTAssertTrue(KeyboardDeliveryPolicy.background(bundleID: "com.microsoft.VSCode"))
        XCTAssertTrue(KeyboardDeliveryPolicy.background(bundleID: "com.apple.Terminal"))
        XCTAssertFalse(KeyboardDeliveryPolicy.background(bundleID: "com.apple.finder"))
    }

    func testChromiumTakesKeysOnlyWhileActive() {
        XCTAssertTrue(KeyboardDeliveryPolicy.deliverable(chromium: false, targetActive: false))
        XCTAssertTrue(KeyboardDeliveryPolicy.deliverable(chromium: true, targetActive: true))
        XCTAssertFalse(KeyboardDeliveryPolicy.deliverable(chromium: true, targetActive: false))
    }

    func testOnlyAnExplicitActivationBringsABackgroundAppForward() {
        XCTAssertFalse(ForegroundConsent.allows(activationRequested: false, targetActive: false))
        XCTAssertTrue(ForegroundConsent.allows(activationRequested: false, targetActive: true))
        XCTAssertTrue(ForegroundConsent.allows(activationRequested: true, targetActive: false))
    }

    func testAGreyedCommandRunsInFrontOnlyWithLeave() {
        XCTAssertEqual(GreyedCommandPolicy.decide(enabled: true, targetActive: false, bringForward: false), .run)
        XCTAssertEqual(GreyedCommandPolicy.decide(enabled: true, targetActive: true, bringForward: false), .run)
        XCTAssertEqual(GreyedCommandPolicy.decide(enabled: false, targetActive: false, bringForward: true),
                       .bringForward)
        XCTAssertEqual(GreyedCommandPolicy.decide(enabled: false, targetActive: false, bringForward: false),
                       .needsFront)
        // In front, a greyed command really is unavailable.
        XCTAssertEqual(GreyedCommandPolicy.decide(enabled: false, targetActive: true, bringForward: true),
                       .disabled)
    }

    func testTheFrontReturnsAfterAGreyedCommandUnlessInputFollows() {
        XCTAssertTrue(FrontReturnPolicy.returnsFront(chromium: false, openedTextField: false))
        // A new item's inline name editor closes without the front.
        XCTAssertFalse(FrontReturnPolicy.returnsFront(chromium: false, openedTextField: true))
        // Chromium keeps it until the task ends.
        XCTAssertFalse(FrontReturnPolicy.returnsFront(chromium: true, openedTextField: false))
    }

    func testPageKeysScrollDocumentsAndListsButNeverASingleLineField() {
        XCTAssertTrue(PagedScroll.pageableRoles.contains("AXTextArea"))
        XCTAssertTrue(PagedScroll.pageableRoles.contains("AXTable"))
        XCTAssertFalse(PagedScroll.pageableRoles.contains("AXTextField"))
        XCTAssertNotNil(try? KeyChord.parse("PageDown"))
        XCTAssertNotNil(try? KeyChord.parse("PageUp"))
    }

    func testScrollingPrefersActionsThatNeedNoPointer() {
        XCTAssertEqual(ScrollActions.candidates(direction: "down", unit: "page"),
                       ["AXScrollDownByPage", "AXScrollDown"])
        XCTAssertEqual(ScrollActions.candidates(direction: "left", unit: "line"), ["AXScrollLeft"])
        XCTAssertEqual(ScrollActions.candidates(direction: "sideways", unit: "page"), [])
    }

    func testAnUnchangedFieldProvesBackgroundKeysWereDropped() {
        XCTAssertEqual(BackgroundDeliveryEvidence.verdict(lengthAtMiss: 3, lengthNow: 3), .dropped)
        XCTAssertEqual(BackgroundDeliveryEvidence.verdict(lengthAtMiss: 3, lengthNow: 9), .delivered)
        XCTAssertEqual(BackgroundDeliveryEvidence.verdict(lengthAtMiss: 3, lengthNow: 0), .delivered)
        XCTAssertEqual(BackgroundDeliveryEvidence.verdict(lengthAtMiss: 3, lengthNow: nil), .unknown)
    }

    func testSecureInputBlocksKeysOnlyWhereItCanSeeThem() {
        let target: pid_t = 42
        // A focused secure field always refuses.
        XCTAssertTrue(SecureKeyboardPolicy.refuses(focusedIsSecure: true, secureInputOn: false,
                                                   ownerPID: nil, targetPID: target, targetActive: false))
        // No system secure input: keys go.
        XCTAssertFalse(SecureKeyboardPolicy.refuses(focusedIsSecure: false, secureInputOn: false,
                                                    ownerPID: nil, targetPID: target, targetActive: true))
        // Turned on by the target, or the target is in front: refuse.
        XCTAssertTrue(SecureKeyboardPolicy.refuses(focusedIsSecure: false, secureInputOn: true,
                                                   ownerPID: target, targetPID: target, targetActive: false))
        XCTAssertTrue(SecureKeyboardPolicy.refuses(focusedIsSecure: false, secureInputOn: true,
                                                   ownerPID: 7, targetPID: target, targetActive: true))
        // Another app in the background turned it on: keys still reach the target.
        XCTAssertFalse(SecureKeyboardPolicy.refuses(focusedIsSecure: false, secureInputOn: true,
                                                    ownerPID: 7, targetPID: target, targetActive: false))
        // Unknown owner: fail closed.
        XCTAssertTrue(SecureKeyboardPolicy.refuses(focusedIsSecure: false, secureInputOn: true,
                                                   ownerPID: nil, targetPID: target, targetActive: false))
    }

    func testTheFrontGoesBackOnlyWhileTheTargetStillHoldsIt() {
        XCTAssertTrue(FrontRestorePolicy.shouldRestore(
            targetActive: true, previousRunning: true, previousProtected: false, previousIsMain: false))
        XCTAssertTrue(FrontRestorePolicy.shouldRestore(
            targetActive: true, previousRunning: true, previousProtected: true, previousIsMain: true))
        XCTAssertFalse(FrontRestorePolicy.shouldRestore(
            targetActive: false, previousRunning: true, previousProtected: false, previousIsMain: false))
        XCTAssertFalse(FrontRestorePolicy.shouldRestore(
            targetActive: true, previousRunning: false, previousProtected: false, previousIsMain: false))
        XCTAssertFalse(FrontRestorePolicy.shouldRestore(
            targetActive: true, previousRunning: true, previousProtected: true, previousIsMain: false))
    }

    func testTerminalEmulatorsTypeIntoTheirReadOnlyTextArea() {
        XCTAssertTrue(TextEntryPreflight.allowsTyping(
            role: "AXTextArea", valueSettable: false, bundleID: "com.apple.Terminal"))
        XCTAssertTrue(TextEntryPreflight.allowsTyping(
            role: "AXTextArea", valueSettable: false, bundleID: "com.googlecode.iterm2"))
        XCTAssertFalse(TextEntryPreflight.allowsTyping(
            role: "AXList", valueSettable: false, bundleID: "com.apple.Terminal"))
        XCTAssertFalse(TextEntryPreflight.allowsTyping(
            role: "AXTextArea", valueSettable: false, bundleID: "com.apple.finder"))
        XCTAssertFalse(TextEntryPreflight.allowsTyping(
            role: "AXTextField", valueSettable: false, bundleID: "com.apple.Terminal"))
    }

    func testKeyboardPreflightPreservesAnActiveInlineEditor() {
        XCTAssertFalse(ForegroundPreflight.shouldRaiseWindow(
            for: .keyboard, targetIsFrontmost: true,
            focusedWindowIsBound: true, orphanTextFocus: false))
        XCTAssertFalse(ForegroundPreflight.shouldRaiseWindow(
            for: .keyboard, targetIsFrontmost: true,
            focusedWindowIsBound: false, orphanTextFocus: true))
        XCTAssertTrue(ForegroundPreflight.shouldRaiseWindow(
            for: .keyboard, targetIsFrontmost: false,
            focusedWindowIsBound: false, orphanTextFocus: false))
        XCTAssertTrue(ForegroundPreflight.shouldRaiseWindow(
            for: .keyboard, targetIsFrontmost: true,
            focusedWindowIsBound: false, orphanTextFocus: false))
        XCTAssertTrue(ForegroundPreflight.shouldRaiseWindow(
            for: .pointer, targetIsFrontmost: true,
            focusedWindowIsBound: true, orphanTextFocus: true))
    }

    func testFinderOrphanEditorRequiresIndependentWindowAndFocusEvidence() {
        var evidence = FinderOrphanFocusEvidence(
            bundleID: "com.apple.finder", role: "AXTextField",
            focusedWindowMissing: true, focusedPIDMatches: true,
            elementFocused: true, valueSettable: true,
            frameInside: true, hitSameElement: true, hitPIDMatches: true,
            topLevelCompatible: true, boundCGWindowUnique: true,
            frontCGWindowMatches: true)
        XCTAssertTrue(evidence.allowsKeyboard)
        evidence.frontCGWindowMatches = false
        XCTAssertFalse(evidence.allowsKeyboard, "Another window over the field must block input")
        evidence.frontCGWindowMatches = true
        evidence.boundCGWindowUnique = false
        XCTAssertFalse(evidence.allowsKeyboard, "An ambiguous physical window must block input")
        evidence.boundCGWindowUnique = true
        evidence.hitSameElement = false
        XCTAssertFalse(evidence.allowsKeyboard, "A stale focused element must block input")
        evidence.hitSameElement = true
        evidence.topLevelCompatible = false
        XCTAssertFalse(evidence.allowsKeyboard, "A different AX top-level window must block input")
        evidence.topLevelCompatible = true
        evidence.bundleID = "com.example.other"
        XCTAssertFalse(evidence.allowsKeyboard, "Only Finder's observed AX behavior may use this fallback")

        evidence.bundleID = "com.apple.finder"
        evidence.hitSameElement = false
        evidence.hitPIDMatches = false
        XCTAssertTrue(evidence.inputPointUnverified,
                      "A different AX owner at an otherwise verified Finder editor needs a distinct denial")
        evidence.frontCGWindowMatches = false
        XCTAssertFalse(evidence.inputPointUnverified,
                       "Ambiguous physical ownership must keep the generic window denial")
    }

    func testMenuPostconditionRequiresAClosedToOpenTransitionOnTheActionElement() {
        XCTAssertTrue(MenuActionPostcondition.opened(before: [], after: ["AXMenu"]))
        XCTAssertFalse(MenuActionPostcondition.opened(before: ["AXMenu"], after: ["AXMenu"]))
        XCTAssertFalse(MenuActionPostcondition.opened(before: [], after: ["AXGroup"]))
        XCTAssertFalse(MenuActionPostcondition.opened(before: nil, after: ["AXMenu"]))
        XCTAssertFalse(MenuActionPostcondition.opened(before: [], after: nil))
    }

    func testMenuCancelPostconditionRequiresAnOpenToClosedTransitionOnTheParent() {
        XCTAssertTrue(MenuActionPostcondition.closed(before: ["AXMenu"], after: []))
        XCTAssertFalse(MenuActionPostcondition.closed(before: ["AXMenu"], after: ["AXMenu"]))
        XCTAssertFalse(MenuActionPostcondition.closed(before: ["AXGroup"], after: []))
        XCTAssertFalse(MenuActionPostcondition.closed(before: nil, after: []))
        XCTAssertFalse(MenuActionPostcondition.closed(before: ["AXMenu"], after: nil))
    }

    func testFinderImageValueChangesInvalidatePixelsWithoutInvalidatingSemanticReferences() {
        XCTAssertEqual(
            RevisionNotificationImpact.classify(
                bundleID: "com.apple.finder", notification: "AXValueChanged", role: "AXImage"),
            .screenshotOnly)
        XCTAssertEqual(
            RevisionNotificationImpact.classify(
                bundleID: "com.apple.finder", notification: "AXValueChanged", role: "AXTextField"),
            .semantic)
        XCTAssertEqual(
            RevisionNotificationImpact.classify(
                bundleID: "com.apple.finder", notification: "AXCreated", role: "AXImage"),
            .semantic)
        XCTAssertEqual(
            RevisionNotificationImpact.classify(
                bundleID: "com.example.other", notification: "AXValueChanged", role: "AXImage"),
            .semantic)
    }

    func testActivationAndOtherWindowsInvalidatePixelsButNotBoundReferences() {
        // Terminal on every activation: a hidden window is destroyed and
        // recreated, and the unchanged focused element is re-announced.
        XCTAssertEqual(
            RevisionNotificationImpact.classify(
                bundleID: "com.apple.Terminal", notification: "AXCreated", role: "AXWindow",
                scope: .otherWindow),
            .screenshotOnly)
        XCTAssertEqual(
            RevisionNotificationImpact.classify(
                bundleID: "com.apple.Terminal", notification: "AXUIElementDestroyed", role: nil,
                scope: .otherWindow),
            .screenshotOnly)
        XCTAssertEqual(
            RevisionNotificationImpact.classify(
                bundleID: "com.apple.Terminal", notification: "AXFocusedUIElementChanged",
                role: "AXWindow", scope: .boundWindow, focusUnchanged: true),
            .screenshotOnly)
        // Real changes in or near the bound window still invalidate references.
        XCTAssertEqual(
            RevisionNotificationImpact.classify(
                bundleID: "com.apple.Terminal", notification: "AXFocusedUIElementChanged",
                role: "AXTextArea", scope: .boundWindow, focusUnchanged: false),
            .semantic)
        XCTAssertEqual(
            RevisionNotificationImpact.classify(
                bundleID: "com.apple.Terminal", notification: "AXValueChanged", role: "AXTextArea",
                scope: .boundWindow),
            .semantic)
        XCTAssertEqual(
            RevisionNotificationImpact.classify(
                bundleID: "com.apple.Terminal", notification: "AXUIElementDestroyed", role: nil,
                scope: .unknown),
            .semantic, "An element whose window cannot be told apart counts as the bound window's")
    }

    func testLiveWorkspaceDoesNotReportThisTestProcessAsActive() {
        XCTAssertFalse(LiveWorkspace.isActive(getpid()))
        XCTAssertFalse(LiveWorkspace.isActive(-1))
    }

    func testWindowReferenceReuseRequiresTheSamePhysicalAndDocumentIdentity() {
        let firstAX = AXUIElementCreateApplication(123)
        let sameAX = AXUIElementCreateApplication(123)
        let otherAX = AXUIElementCreateApplication(124)
        let frame = Rect(x: 10, y: 20, width: 300, height: 200)
        func window(ref: String = "w-original", pid: pid_t = 123,
                    title: String = "Draft", bounds: Rect? = frame,
                    element: AXUIElement = firstAX,
                    path: String = "/tmp/Fixture.app/Contents/MacOS/Fixture") -> NativeWindow {
            NativeWindow(ref: ref, pid: pid, bundleID: "com.example.fixture",
                         appName: "Fixture", title: title, frame: bounds,
                         minimized: false, main: true, order: 0, element: element,
                         executablePath: path)
        }
        let prior = window()
        XCTAssertEqual(WindowReferenceMatcher.reusableRef(for: window(ref: "w-new", element: sameAX),
                                                          prior: [prior], used: []), "w-original")
        XCTAssertNil(WindowReferenceMatcher.reusableRef(for: window(ref: "w-new", element: otherAX),
                                                        prior: [prior], used: []))
        XCTAssertNil(WindowReferenceMatcher.reusableRef(for: window(ref: "w-new", pid: 124),
                                                        prior: [prior], used: []))
        XCTAssertNil(WindowReferenceMatcher.reusableRef(for: window(ref: "w-new", path: "/tmp/Other"),
                                                        prior: [prior], used: []))
        XCTAssertNil(WindowReferenceMatcher.reusableRef(for: window(ref: "w-new", title: "Secret"),
                                                        prior: [prior], used: []))
        XCTAssertNil(WindowReferenceMatcher.reusableRef(
            for: window(ref: "w-new", bounds: Rect(x: 11, y: 20, width: 300, height: 200)),
            prior: [prior], used: []))
        XCTAssertNil(WindowReferenceMatcher.reusableRef(for: window(ref: "w-new"),
                                                        prior: [prior], used: ["w-original"]))
        XCTAssertNil(WindowReferenceMatcher.reusableRef(for: window(ref: "w-new"),
                                                        prior: [prior, window(ref: "w-duplicate")], used: []))
    }

    func testCGWindowInventoryKeepsOnlyNamedNormalWindowsWithValidIdentity() {
        let bounds: [String: Any] = ["X": 10, "Y": 20, "Width": 300, "Height": 200]
        func row(id: Int, pid: Int = 42, title: String = "Fixture", layer: Int = 0,
                 frame: [String: Any] = bounds) -> [String: Any] {
            [kCGWindowNumber as String: id, kCGWindowOwnerPID as String: pid,
             kCGWindowName as String: title, kCGWindowLayer as String: layer,
             kCGWindowBounds as String: frame]
        }
        let candidates = CGWindowInventory.candidates(rows: [
            row(id: 17), row(id: 18, title: ""), row(id: 19, layer: 3),
            row(id: 20, frame: ["X": 10, "Y": 20, "Width": 0, "Height": 200]),
            row(id: 21, pid: 0),
        ])
        XCTAssertEqual(candidates, [ScreenshotWindow(id: 17, pid: 42, title: "Fixture",
                                                      frame: Rect(x: 10, y: 20, width: 300, height: 200))])
    }

    func testAXWindowQueryFailureDoesNotLookLikeAnEmptyWindowList() {
        let nonexistentApp = AXUIElementCreateApplication(pid_t(Int32.max))
        AXUIElementSetMessagingTimeout(nonexistentApp, 0.1)
        XCTAssertThrowsError(try DesktopCatalog.axWindows(nonexistentApp)) { error in
            XCTAssertEqual((error as? NativeError)?.code, "DRIVER_UNAVAILABLE")
        }
    }

    func testUnsupportedAXWindowsAttributeIsNotAnEmptyWindowList() {
        let system = AXUIElementCreateSystemWide()
        XCTAssertThrowsError(try DesktopCatalog.axWindows(system)) { error in
            XCTAssertEqual((error as? NativeError)?.code, "DRIVER_UNAVAILABLE")
        }
    }

    func testSecretBufferProvidesCFStringAndZeroesItsOwnedBytes() throws {
        let secret = SecretBytes("fixture-only-密")
        XCTAssertFalse(secret.isZeroed)
        let length = try secret.withCFString { CFStringGetLength($0) }
        XCTAssertEqual(length, 14)
        secret.wipe()
        XCTAssertTrue(secret.isZeroed)
    }

    func testSecretFillRejectsInvalidTeamBindingBeforeDispatch() {
        let executor = SecretFillExecutor(catalog: DesktopCatalog())
        var dispatched = false
        let params: [String: Any] = [
            "operationId": "unit-secret", "targetId": "t-missing", "generation": 1,
            "expectedRevision": 0, "ref": "r0.1", "field": "password",
            "secret": "dummy-unit-secret",
            "binding": ["bundleId": "com.example.fixture", "teamId": "invalid-lowercase"],
        ]
        XCTAssertThrowsError(try executor.execute(params: params) { _, _ in dispatched = true }) { error in
            XCTAssertEqual((error as? NativeError)?.code, "INVALID_REQUEST")
            XCTAssertFalse(String(describing: error).contains("dummy-unit-secret"))
        }
        XCTAssertFalse(dispatched)
    }

    func testSecureCredentialWriteWithZeroReportedCharactersIsUnconfirmed() {
        XCTAssertThrowsError(try SecretFillPostcondition.confirm(
            expected: "dummy-secret", isSecure: true,
            observedValue: nil, observedCharacterCount: 0)) { error in
            XCTAssertEqual((error as? NativeError)?.code, "OUTCOME_UNKNOWN")
        }
    }

    func testPlainCredentialWriteDoesNotAcceptAnUnchangedNonemptyValue() {
        XCTAssertThrowsError(try SecretFillPostcondition.confirm(
            expected: "new-user", isSecure: false,
            observedValue: "old-user", observedCharacterCount: 8)) { error in
            XCTAssertEqual((error as? NativeError)?.code, "OUTCOME_UNKNOWN")
        }
    }

    func testCredentialWriteAcceptsOnlyAvailablePositiveEvidence() throws {
        XCTAssertTrue(try SecretFillPostcondition.confirm(
            expected: "new-user", isSecure: false,
            observedValue: "new-user", observedCharacterCount: nil))
        XCTAssertTrue(try SecretFillPostcondition.confirm(
            expected: "dummy-secret", isSecure: true,
            observedValue: nil, observedCharacterCount: 12))
    }

    func testUnicodeEventChunksKeepSurrogatePairsTogetherAtTheTwentyUnitBoundary() {
        let text = String(repeating: "A", count: 19) + "😀Z"
        let chunks = InputController.unicodeChunks(text)
        XCTAssertEqual(chunks, [Array(String(repeating: "A", count: 19).utf16), Array("😀Z".utf16)])
        XCTAssertTrue(chunks.allSatisfy { $0.count <= 20 })
    }

    func testControlCharactersTravelAloneSoAppKitKeepsTheTextAroundThem() {
        // AppKit read "\n你好…" as one newline and dropped the rest.
        let chunks = InputController.unicodeChunks("\n你好, Emperor. 标点测试; OK!")
        XCTAssertEqual(chunks.first, Array("\n".utf16))
        XCTAssertEqual(chunks.dropFirst().flatMap { $0 }, Array("你好, Emperor. 标点测试; OK!".utf16))
        XCTAssertEqual(InputController.unicodeChunks("a\r\nb\tc"),
                       [Array("a".utf16), Array("\n".utf16), Array("b".utf16), Array("\t".utf16), Array("c".utf16)])
        XCTAssertTrue(InputController.unicodeChunks(String(repeating: "字", count: 45)).allSatisfy { $0.count <= 20 })
    }

    func testAppendedTextLeavesTheRestOfTheFieldUntouched() {
        XCTAssertTrue(AppendedTextEvidence.confirmed(before: "第一行", after: "第一行\n新行", appended: "\n新行"))
        // Replaced instead of appended, or landed at the caret, fails.
        XCTAssertFalse(AppendedTextEvidence.confirmed(before: "第一行", after: "\n新行", appended: "\n新行"))
        XCTAssertFalse(AppendedTextEvidence.confirmed(before: "第一行", after: "\n新行第一行", appended: "\n新行"))
    }

    func testAShortDeliveryIsFlaggedOnlyWhenMostTextIsMissing() {
        XCTAssertTrue(TypedTextEvidence.shortfall(expected: 23, delta: 4))
        XCTAssertFalse(TypedTextEvidence.shortfall(expected: 23, delta: 23))
        // Substitutions such as "..." → "…" shorten text a little.
        XCTAssertFalse(TypedTextEvidence.shortfall(expected: 23, delta: 21))
        XCTAssertFalse(TypedTextEvidence.shortfall(expected: 3, delta: 0))
    }

    func testCancelCannotReleaseMouseBeforeItsDownEventIsPosted() {
        final class EventLog: @unchecked Sendable {
            private let lock = NSLock()
            private var events: [String] = []
            func append(_ event: String) {
                lock.lock(); events.append(event); lock.unlock()
            }
            func snapshot() -> [String] {
                lock.lock(); defer { lock.unlock() }; return events
            }
        }
        let gate = HeldInputGate()
        let events = EventLog()
        let postingEntered = DispatchSemaphore(value: 0)
        let allowPost = DispatchSemaphore(value: 0)
        let postFinished = DispatchSemaphore(value: 0)
        let cancelStarted = DispatchSemaphore(value: 0)
        let cancelFinished = DispatchSemaphore(value: 0)
        gate.begin()
        DispatchQueue.global().async {
            do {
                try gate.postMouseDown(.left) {
                    postingEntered.signal()
                    _ = allowPost.wait(timeout: .now() + 2)
                    events.append("down")
                }
            } catch {
                events.append("post-failed")
            }
            postFinished.signal()
        }
        XCTAssertEqual(postingEntered.wait(timeout: .now() + 2), .success)
        DispatchQueue.global().async {
            cancelStarted.signal()
            gate.cancel(keyUp: { _ in }, mouseUp: { _ in events.append("up") })
            cancelFinished.signal()
        }
        XCTAssertEqual(cancelStarted.wait(timeout: .now() + 2), .success)
        XCTAssertEqual(cancelFinished.wait(timeout: .now() + .milliseconds(30)), .timedOut)
        allowPost.signal()
        XCTAssertEqual(postFinished.wait(timeout: .now() + 2), .success)
        XCTAssertEqual(cancelFinished.wait(timeout: .now() + 2), .success)
        XCTAssertEqual(events.snapshot(), ["down", "up"])
    }

    func testAXAppModeNeverChangesAnUnreadableOriginalValue() {
        var writes: [Bool] = []
        var reasons: [String] = []
        let unknown = DesktopCatalog.enableKnownAppMode(read: { nil }, write: { value in
            writes.append(value)
            return true
        }, diagnose: { reasons.append($0) })
        XCTAssertNil(unknown)
        XCTAssertTrue(writes.isEmpty)
        XCTAssertEqual(reasons, ["original-unreadable"])

        let originalTrue = DesktopCatalog.enableKnownAppMode(read: { true }, write: { value in
            writes.append(value)
            return true
        }, diagnose: { reasons.append($0) })
        XCTAssertNil(originalTrue)
        XCTAssertTrue(writes.isEmpty)
        XCTAssertEqual(reasons, ["original-unreadable", "already-enabled"])

        let originalFalse = DesktopCatalog.enableKnownAppMode(read: { false }, write: { value in
            writes.append(value)
            return true
        })
        XCTAssertEqual(originalFalse, false)
        XCTAssertEqual(writes, [true])

        let rejected = DesktopCatalog.enableKnownAppMode(read: { false }, write: { _ in false },
                                                         diagnose: { reasons.append($0) })
        XCTAssertNil(rejected)
        XCTAssertEqual(reasons, ["original-unreadable", "already-enabled", "write-failed"])

        // Chrome: every write reports -25208 but takes effect. The mode must
        // still be tracked, or release never restores it.
        var chromeValue = false
        let appliedDespiteError = DesktopCatalog.enableKnownAppMode(
            read: { chromeValue },
            write: { value in chromeValue = value; return false })
        XCTAssertEqual(appliedDespiteError, false)
        XCTAssertTrue(chromeValue)
    }
}
