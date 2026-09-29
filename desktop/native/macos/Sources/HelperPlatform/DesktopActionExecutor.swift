import AppKit
import ApplicationServices
import Carbon
import CoreGraphics
import Foundation
import HelperCore

enum MenuActionPostcondition {
    static func popupParent(of menu: AXUIElement) -> AXUIElement? {
        guard let value = DesktopCatalog.attribute(menu, "AXParent"),
              CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
        let parent = value as! AXUIElement
        return DesktopCatalog.text(parent, "AXRole") == "AXPopUpButton" ? parent : nil
    }

    static func childRoles(of element: AXUIElement) -> [String]? {
        guard let children = DesktopCatalog.attribute(element, "AXChildren") as? [AXUIElement] else {
            return nil
        }
        return children.map { DesktopCatalog.text($0, "AXRole") }
    }

    static func opened(before: [String]?, after: [String]?) -> Bool {
        guard let before, let after else { return false }
        return !before.contains("AXMenu") && after.contains("AXMenu")
    }

    static func closed(before: [String]?, after: [String]?) -> Bool {
        guard let before, let after else { return false }
        return before.contains("AXMenu") && !after.contains("AXMenu")
    }
}

enum ForegroundPreflight {
    enum InputKind { case keyboard, pointer }

    static func shouldRaiseWindow(for kind: InputKind, targetIsFrontmost: Bool,
                                  focusedWindowIsBound: Bool, orphanTextFocus: Bool) -> Bool {
        if kind == .pointer { return true }
        // AXRaise dismisses Finder's inline rename editor. Leave an orphan
        // text focus in place; the later physical-window checks decide whether
        // this particular Finder editor belongs to the bound window.
        return !targetIsFrontmost || !(focusedWindowIsBound || orphanTextFocus)
    }
}

/// Some text areas (Terminal's) post no AX notification for typed text
/// within the confirmation window. A changed character count on the element
/// that received the keystrokes is direct evidence; only counts are compared.
/// Text appended through AX: the field now ends with it and grew by its
/// length, so nothing else in the document changed.
enum AppendedTextEvidence {
    static func confirmed(before: String, after: String, appended: String) -> Bool {
        after == before + appended
    }
}

/// Typed text whose field grew by less than half of what was sent did not
/// all arrive (a dropped key event); the result then carries a warning.
enum TypedTextEvidence {
    static func shortfall(expected: Int, delta: Int) -> Bool {
        expected >= 4 && delta * 2 < expected
    }
}

enum TextLengthPostcondition {
    static func changed(before: Int?, after: Int?) -> Bool {
        guard let before, let after else { return false }
        return before != after
    }
}

/// E-M6b: keys go to the target's process in the background, except for apps
/// whose keyboard safety net was only proven on the foreground path (Finder's
/// inline rename editor check).
enum KeyboardDeliveryPolicy {
    static let foregroundOnly: Set<String> = ["com.apple.finder"]

    static func background(bundleID: String) -> Bool {
        !foregroundOnly.contains(bundleID)
    }

    /// Chromium and Electron drop keys that reach a window which is not key,
    /// so they take keys only while the app is active (VS Code, 2026-09-28).
    static func deliverable(chromium: Bool, targetActive: Bool) -> Bool {
        !chromium || targetActive
    }
}

/// After an unconfirmed background key delivery, the next keyboard action
/// looks at the same field: unchanged means the keys were dropped (the app
/// ignores background keys), changed means they arrived late.
enum UnconfirmedEffect {
    static let message = "Action dispatched but effect is unconfirmed"
}

enum BackgroundDeliveryEvidence {
    enum Verdict: Equatable { case delivered, dropped, unknown }

    static func verdict(lengthAtMiss: Int, lengthNow: Int?) -> Verdict {
        guard let lengthNow else { return .unknown }
        return lengthNow == lengthAtMiss ? .dropped : .delivered
    }
}

/// Keys never reach a secure text field. System secure input (a password
/// prompt, Terminal's Secure Keyboard Entry) blocks keys only when the target
/// itself turned it on or is in front; another app's secure input in the
/// background does not see keys posted to the target. When the system does
/// not say which app turned it on, keys are refused.
enum SecureKeyboardPolicy {
    static func refuses(focusedIsSecure: Bool, secureInputOn: Bool, ownerPID: pid_t?,
                        targetPID: pid_t, targetActive: Bool) -> Bool {
        if focusedIsSecure { return true }
        guard secureInputOn else { return false }
        return ownerPID == nil || ownerPID == targetPID || targetActive
    }
}

/// Whether some app has turned on secure keyboard input, and which one.
enum SecureInputState {
    static func current() -> (on: Bool, ownerPID: pid_t?) {
        guard IsSecureEventInputEnabled() else { return (false, nil) }
        let session = CGSessionCopyCurrentDictionary() as? [String: Any]
        let owner = (session?["kCGSSessionSecureInputPID"] as? NSNumber)?.int32Value
        return (true, owner.map { pid_t($0) })
    }
}

/// The helper never activates an app on its own: only an `activate` action,
/// or an action Core sends with `bringForward` because the user's mode
/// allows it, may bring one forward.
enum ForegroundConsent {
    static func allows(activationRequested: Bool, targetActive: Bool) -> Bool {
        activationRequested || targetActive
    }
}

/// A menu command, picked by path or by its shortcut, that the app may grey
/// out while in the background: Chromium and Electron grey every command,
/// AppKit greys the ones that act on the key window (Undo, Close, Select
/// All). Pressing a greyed item does nothing, so it runs in front when Core
/// allows bringing the window forward; otherwise nothing is sent.
enum GreyedCommandPolicy {
    enum Decision: Equatable { case run, bringForward, needsFront, disabled }

    static func decide(enabled: Bool, targetActive: Bool, bringForward: Bool) -> Decision {
        if enabled { return .run }
        if targetActive { return .disabled }
        return bringForward ? .bringForward : .needsFront
    }
}

/// After a command run in front only because the app greys it out in the
/// background, the front goes back at once, unless the app is Chromium (its
/// transient UI closes without the front) or the command opened a text
/// field for input, such as a new item's inline name editor.
enum FrontReturnPolicy {
    static func returnsFront(chromium: Bool, openedTextField: Bool) -> Bool {
        !chromium && !openedTextField
    }
}

/// Elements a native app pages on PageDown / PageUp posted to its process:
/// documents and lists, never a single-line field.
enum PagedScroll {
    static let pageableRoles: Set<String> = ["AXTextArea", "AXTable", "AXOutline", "AXList"]
}

/// AX actions that scroll an element without the pointer, most specific
/// first. AppKit scroll areas offer the page actions; there is no line one.
enum ScrollActions {
    static func candidates(direction: String, unit: String) -> [String] {
        guard let side = ["up": "Up", "down": "Down", "left": "Left", "right": "Right"][direction] else {
            return []
        }
        return unit == "page" ? ["AXScroll\(side)ByPage", "AXScroll\(side)"] : ["AXScroll\(side)"]
    }
}

/// At the task's end the front goes back to the app that had it before the
/// first `activate`, but only while the target still holds the front (a user
/// who moved on keeps their choice), and never to a protected app other than
/// Emperor itself.
enum FrontRestorePolicy {
    static func shouldRestore(targetActive: Bool, previousRunning: Bool,
                              previousProtected: Bool, previousIsMain: Bool) -> Bool {
        targetActive && previousRunning && (!previousProtected || previousIsMain)
    }

    static func restore(_ target: BoundTarget, mainPID: pid_t?) -> Bool {
        defer { target.previousFrontPID = nil }
        guard let previous = target.previousFrontPID else { return false }
        let app = NSRunningApplication(processIdentifier: previous)
        let protected = app.map {
            ProtectedTargets.contains(bundleID: $0.bundleIdentifier ?? "",
                                      executablePath: $0.executableURL?.path)
        } ?? true
        guard shouldRestore(targetActive: LiveWorkspace.isActive(target.pid),
                            previousRunning: app.map { !$0.isTerminated } ?? false,
                            previousProtected: protected, previousIsMain: previous == mainPID) else {
            return false
        }
        return AXUIElementSetAttributeValue(AXUIElementCreateApplication(previous),
                                            "AXFrontmost" as CFString, kCFBooleanTrue) == .success
    }
}

enum TextEntryPreflight {
    /// Terminal emulators take typed input in a text area that AX reports as
    /// read-only; their keystrokes go to the shell, never to a selection.
    static let terminalEmulators: Set<String> = [
        "com.apple.Terminal", "com.googlecode.iterm2", "dev.warp.Warp-Stable", "com.mitchellh.ghostty",
    ]

    static func allowsTyping(role: String, valueSettable: Bool, bundleID: String = "") -> Bool {
        if role == "AXTextArea", terminalEmulators.contains(bundleID) { return true }
        return (role == "AXTextField" || role == "AXTextArea") && valueSettable
    }
}

/// Finder can report a focused inline editor with no AXFocusedWindow or AX
/// top-level window. Require independent AX hit-test and on-screen CG window
/// identity before treating that editor as part of the bound window.
struct FinderOrphanFocusEvidence {
    var bundleID: String
    var role: String
    var focusedWindowMissing: Bool
    var focusedPIDMatches: Bool
    var elementFocused: Bool
    var valueSettable: Bool
    var frameInside: Bool
    var hitSameElement: Bool
    var hitPIDMatches: Bool
    var topLevelCompatible: Bool
    var boundCGWindowUnique: Bool
    var frontCGWindowMatches: Bool

    private var keyboardContextVerifiedExceptHit: Bool {
        bundleID == "com.apple.finder" &&
            (role == "AXTextField" || role == "AXTextArea") &&
            focusedWindowMissing && focusedPIDMatches && elementFocused && valueSettable &&
            frameInside && topLevelCompatible && boundCGWindowUnique && frontCGWindowMatches
    }

    var allowsKeyboard: Bool {
        keyboardContextVerifiedExceptHit && hitSameElement && hitPIDMatches
    }

    var inputPointUnverified: Bool {
        keyboardContextVerifiedExceptHit && (!hitSameElement || !hitPIDMatches)
    }
}

public final class DesktopActionExecutor {
    private let catalog: DesktopCatalog
    private let verifiedMainPID: pid_t?
    private let input = InputController.shared
    private var dispatchedOperations = Set<String>()

    public init(catalog: DesktopCatalog, verifiedMainPID: pid_t? = nil) {
        self.catalog = catalog
        self.verifiedMainPID = verifiedMainPID
    }

    public func execute(params: [String: Any],
                        beforeSideEffect: (String, [String: Any]?) throws -> Void) throws -> [String: Any] {
        guard let operationID = params["operationId"] as? String,
              !operationID.isEmpty, operationID.utf8.count <= 256,
              let targetID = params["targetId"] as? String,
              !targetID.isEmpty, targetID.utf8.count <= 256,
              let generation = Self.integer(params["generation"]), generation > 0,
              let expectedRevision = Self.integer(params["expectedRevision"]), expectedRevision >= 0,
              let action = params["action"] as? [String: Any],
              let kind = action["kind"] as? String else { throw invalid("Invalid action request") }
        let target = try catalog.target(id: targetID, generation: generation)
        guard target.revision == expectedRevision else {
            throw NativeError.denied(code: "STALE_TARGET", message: "Target revision is stale")
        }
        input.begin()
        // A native app brought forward only for a command it greys out in the
        // background gives the front back as soon as the command has run.
        // Chromium keeps it until the task ends: its transient UI, such as a
        // command palette, closes once the app loses the front.
        var returnFrontAfter = false
        var focusBeforeCommand: AXUIElement?
        defer {
            if returnFrontAfter,
               FrontReturnPolicy.returnsFront(
                   chromium: target.chromiumAccessibility,
                   openedTextField: Self.openedTextField(pid: target.pid, before: focusBeforeCommand)) {
                _ = FrontRestorePolicy.restore(target, mainPID: verifiedMainPID)
            }
        }
        defer { input.releaseAll() }
        // Only system-wide (HID) input can reach whatever is in front, so only
        // those paths require an unprotected foreground. AX actions and events
        // posted to the target's process never leave the target (E-M6b).
        var usesGlobalInput = false
        var dispatched = false
        var actionRevision = expectedRevision
        var observationBaseline = expectedRevision
        var confirmedPostcondition: (() -> Bool)?
        // Posted keys are handled asynchronously; long text needs longer to show.
        var settleMilliseconds = 700
        var warnings: [String] = []
        // Where the action lands, for the on-screen virtual pointer.
        var pointerPoint: (at: CGPoint, to: CGPoint?)?
        func pointAt(_ element: AXUIElement) {
            if let center = try? Self.center(element) { pointerPoint = (center, nil) }
        }
        // The field background-typed text should land in, and its length then.
        var backgroundReceiver: (element: AXUIElement, length: Int)?
        var useBackgroundKeys: Bool {
            KeyboardDeliveryPolicy.background(bundleID: target.bundleID) && !target.keysNeedFront
        }
        /// Judge an earlier unconfirmed delivery before sending more keys.
        func settleKeyMiss() {
            guard let miss = target.keyMiss else { return }
            target.keyMiss = nil
            if BackgroundDeliveryEvidence.verdict(
                lengthAtMiss: miss.length, lengthNow: Self.textLength(miss.element)) == .dropped {
                target.keysNeedFront = true
                HelperDiagnostic.emit("BACKGROUND_KEYS_DROPPED")
                warnings.append("Keys did not reach this app in the background; it now takes keys only in front.")
            }
        }
        func dispatch() throws {
            try input.checkCancellation()
            let current = try catalog.target(id: targetID, generation: generation)
            guard current.revision == actionRevision else {
                throw NativeError.denied(code: "STALE_TARGET", message: "Target revision changed before action")
            }
            if usesGlobalInput { try Self.requireUnprotectedForeground(verifiedMainPID: verifiedMainPID) }
            if !dispatched {
                guard dispatchedOperations.count < 10_000,
                      !dispatchedOperations.contains(operationID) else {
                    throw NativeError.denied(code: "INVALID_REQUEST", message: "Operation ID was already dispatched")
                }
                try beforeSideEffect(operationID, pointerPoint.map {
                    pointerPayload(at: $0.at, to: $0.to, target: target)
                })
                dispatchedOperations.insert(operationID)
                dispatched = true
            }
        }
        // The user already let this window come forward during this task.
        let bringForward = params["bringForward"] as? Bool ?? false
        func foreground(_ kind: ForegroundPreflight.InputKind = .pointer) throws {
            usesGlobalInput = true
            try ensureForeground(target, for: kind, activationRequested: bringForward)
        }
        /// Brings the app forward for a menu command it greys out in the
        /// background (see `GreyedCommandPolicy`), or refuses before anything
        /// is sent. With `requireEnabled`, the command must be enabled in front.
        func frontForGreyedCommand(_ item: AXUIElement, for inputKind: ForegroundPreflight.InputKind,
                                   requireEnabled: Bool) throws {
            switch GreyedCommandPolicy.decide(enabled: DesktopCatalog.bool(item, "AXEnabled"),
                                              targetActive: LiveWorkspace.isActive(target.pid),
                                              bringForward: bringForward) {
            case .run:
                return
            case .disabled:
                throw NativeError.denied(code: "INVALID_REQUEST", message: "Menu item is disabled")
            case .needsFront:
                throw NativeError.denied(code: "TARGET_NOT_VISIBLE", message: "Menu needs the app in front")
            case .bringForward:
                returnFrontAfter = true
                focusBeforeCommand = Self.focusedElement(pid: target.pid)
                try ensureForeground(target, for: inputKind, activationRequested: true)
                guard requireEnabled else { return }
                // The app validates its menus again once in front.
                let deadline = ContinuousClock.now.advanced(by: .milliseconds(800))
                while !DesktopCatalog.bool(item, "AXEnabled") && ContinuousClock.now < deadline {
                    Thread.sleep(forTimeInterval: 0.05)
                }
                guard DesktopCatalog.bool(item, "AXEnabled") else {
                    throw NativeError.denied(code: "INVALID_REQUEST", message: "Menu item is disabled")
                }
            }
        }
        func absorbOwnFocus(_ element: AXUIElement?, verify: Bool = true, settle: Bool = false) throws {
            let current = settle ? try settledTarget(id: targetID, generation: generation)
                                 : try catalog.target(id: targetID, generation: generation)
            if let element, verify {
                var pid: pid_t = 0
                guard AXUIElementGetPid(element, &pid) == .success, pid == current.pid,
                      Self.belongsToWindow(element, target: current),
                      DesktopCatalog.bool(element, "AXFocused") else {
                    throw NativeError.denied(code: "OUTCOME_UNKNOWN", message: "Focus outcome is unknown")
                }
            }
            actionRevision = current.revision
            observationBaseline = current.revision
        }
        // The field typed text goes into, its length before, and how much it
        // should grow (the text minus any selection it replaces).
        var typedEvidence: (element: AXUIElement, before: Int, expected: Int)?
        // For appended text: the field ends with exactly that text.
        var appendCheck: (() -> Bool)?
        func expectGrowth(of receiver: AXUIElement?, by text: String) {
            guard let receiver, let before = Self.textLength(receiver) else { return }
            let sent = InputController.unicodeChunks(text).reduce(0) { $0 + $1.count }
            typedEvidence = (receiver, before, sent - Self.selectedLength(receiver))
        }
        func watchLength(of receiver: AXUIElement?) {
            if let receiver, let lengthBefore = Self.textLength(receiver) {
                confirmedPostcondition = {
                    TextLengthPostcondition.changed(before: lengthBefore, after: Self.textLength(receiver))
                }
            }
        }
        /// Text into `element` (nil: the focused element). Background by
        /// default (E-M6b); apps in `KeyboardDeliveryPolicy.foregroundOnly`
        /// keep the proven foreground HID path.
        func typeKeys(_ text: String, into element: AXUIElement?,
                      foregroundRequiresEditableFocus: Bool) throws {
            settleKeyMiss()
            if useBackgroundKeys {
                try prepareBackgroundKeyboard(target, element: element, bringForward: bringForward)
                try absorbOwnFocus(element, verify: !target.chromiumAccessibility, settle: true)
                try Self.requireNonSecureBackgroundFocus(target)
                if element == nil {
                    try Self.requireNonSecureKeyboardTarget(target, requireEditableText: true)
                }
                let receiver = element ?? Self.focusedElement(of: target)
                watchLength(of: receiver)
                expectGrowth(of: receiver, by: text)
                if let receiver, let length = Self.textLength(receiver) {
                    backgroundReceiver = (receiver, length)
                }
                try dispatch()
                try input.typeUnicode(text, toProcess: target.pid)
            } else {
                try foreground(.keyboard)
                try absorbOwnFocus(nil)
                if let element {
                    guard AXUIElementSetAttributeValue(element, "AXFocused" as CFString,
                                                      NSNumber(value: true)) == .success else {
                        throw NativeError.denied(code: "DRIVER_UNAVAILABLE", message: "Cannot focus text element")
                    }
                    try absorbOwnFocus(element)
                }
                try InputController.requireKeyboardAvailable()
                try Self.requireNonSecureKeyboardTarget(target,
                                                        requireEditableText: foregroundRequiresEditableFocus)
                watchLength(of: element ?? Self.focusedElement(of: target))
                expectGrowth(of: element ?? Self.focusedElement(of: target), by: text)
                try dispatch()
                try input.typeUnicode(text)
            }
            settleMilliseconds = min(3_000, 700 + 3 * InputController.unicodeChunks(text).count)
        }

        switch kind {
        case "click":
            try Self.keys(action, required: ["kind", "ref"], optional: ["button", "count"])
            let element = try self.element(action, target: target)
            let button = try Self.button(action["button"])
            let count = try Self.clickCount(action["count"])
            pointAt(element)
            if button == .left && count == 1 && Self.actionNames(element).contains("AXPress") {
                try dispatch()
                try Self.perform(element, "AXPress")
            } else {
                let point = try Self.center(element)
                try foreground()
                try hitTest(point, target: target)
                try dispatch()
                try input.click(point: point, button: button, count: count)
            }
        case "clickPoint":
            try Self.keys(action, required: ["kind", "point"], optional: ["button", "count"])
            let point = try self.point(action["point"], target: target)
            let button = try Self.button(action["button"])
            let count = try Self.clickCount(action["count"])
            pointerPoint = (point, nil)
            try foreground()
            try hitTest(point, target: target)
            try dispatch()
            try input.click(point: point, button: button, count: count)
        case "appendText":
            try Self.keys(action, required: ["kind", "ref", "text"])
            guard let text = action["text"] as? String, !text.isEmpty, text.count <= 10_000 else {
                throw invalid("Invalid text")
            }
            let element = try self.element(action, target: target)
            pointAt(element)
            guard !Self.isSecure(element) else {
                throw NativeError.denied(code: "SECURE_INPUT_ACTIVE", message: "Use the credential-fill path for secure fields")
            }
            // Insert at the end of the text through AX: the caret range, then
            // the selected text. The rest of the document, and its formatting,
            // stays as it is; all of it works with the app in the background.
            guard Self.settable(element, "AXSelectedTextRange"), Self.settable(element, "AXSelectedText"),
                  let before = DesktopCatalog.attribute(element, "AXValue") as? String else {
                throw NativeError.denied(code: "CAPABILITY_DISABLED", message: "Field cannot insert text")
            }
            var end = CFRange(location: before.utf16.count, length: 0)
            guard let range = AXValueCreate(.cfRange, &end) else { throw invalid("Invalid text range") }
            try dispatch()
            guard AXUIElementSetAttributeValue(element, "AXSelectedTextRange" as CFString, range) == .success,
                  AXUIElementSetAttributeValue(element, "AXSelectedText" as CFString, text as CFString) == .success else {
                throw NativeError.denied(code: "OUTCOME_UNKNOWN", message: "Text insertion was not confirmed")
            }
            let appended = {
                AppendedTextEvidence.confirmed(
                    before: before, after: DesktopCatalog.attribute(element, "AXValue") as? String ?? "",
                    appended: text)
            }
            confirmedPostcondition = appended
            appendCheck = appended
        case "fill", "select":
            let textKey = kind == "fill" ? "text" : "option"
            try Self.keys(action, required: ["kind", "ref", textKey])
            guard let text = action[textKey] as? String,
                  text.count <= (kind == "fill" ? 10_000 : 500),
                  (kind == "fill" || !text.isEmpty) else { throw invalid("Invalid text") }
            let element = try self.element(action, target: target)
            pointAt(element)
            guard !Self.isSecure(element) else {
                throw NativeError.denied(code: "SECURE_INPUT_ACTIVE", message: "Use the credential-fill path for secure fields")
            }
            if kind == "select", DesktopCatalog.text(element, "AXRole") == "AXPopUpButton" {
                let actions = Self.actionNames(element)
                guard let openAction = actions.contains("AXShowMenu") ? "AXShowMenu" :
                    (actions.contains("AXPress") ? "AXPress" : nil) else {
                    throw NativeError.denied(code: "CAPABILITY_DISABLED", message: "Popup has no semantic menu action")
                }
                try dispatch()
                try Self.perform(element, openAction)
                let deadline = ContinuousClock.now.advanced(by: .milliseconds(500))
                var option: AXUIElement?
                while ContinuousClock.now < deadline {
                    try input.checkCancellation()
                    option = Self.popupOption(text, in: element)
                    if option != nil { break }
                    Thread.sleep(forTimeInterval: 0.02)
                }
                guard let option else {
                    throw NativeError.denied(code: "OUTCOME_UNKNOWN", message: "Popup option is unavailable after opening")
                }
                let current = try catalog.target(id: targetID, generation: generation)
                guard current.pid == target.pid, Self.belongsToWindow(element, target: current) else {
                    throw NativeError.denied(code: "OUTCOME_UNKNOWN", message: "Popup target changed after opening")
                }
                try Self.requireUnprotectedForeground(verifiedMainPID: verifiedMainPID)
                try input.checkCancellation()
                guard let currentOption = Self.popupOption(text, in: element),
                      CFEqual(currentOption, option) else {
                    throw NativeError.denied(code: "OUTCOME_UNKNOWN", message: "Popup option changed before selection")
                }
                try Self.perform(option, "AXPress")
                let selectionDeadline = ContinuousClock.now.advanced(by: .milliseconds(700))
                while ContinuousClock.now < selectionDeadline &&
                    DesktopCatalog.text(element, "AXValue") != text {
                    try input.checkCancellation()
                    Thread.sleep(forTimeInterval: 0.02)
                }
                guard DesktopCatalog.text(element, "AXValue") == text else {
                    throw NativeError.denied(code: "OUTCOME_UNKNOWN", message: "Popup selection outcome is unknown")
                }
                return try observedResult(target: target, generation: generation, before: expectedRevision,
                                          directValueConfirmed: true)
            }
            var settable: DarwinBoolean = false
            let canSet = AXUIElementIsAttributeSettable(element, "AXValue" as CFString, &settable) == .success && settable.boolValue
            if canSet {
                try dispatch()
                let status = AXUIElementSetAttributeValue(element, "AXValue" as CFString, text as CFString)
                if status == .success {
                    guard DesktopCatalog.text(element, "AXValue") == text else {
                        throw NativeError.denied(code: "OUTCOME_UNKNOWN", message: "AX value changed without confirmation")
                    }
                    return try observedResult(target: target, generation: generation, before: expectedRevision,
                                              directValueConfirmed: true)
                }
                // A write was attempted. Some apps apply it despite an AX
                // timeout, so a keyboard fallback would be an unsafe replay.
                throw NativeError.denied(code: "OUTCOME_UNKNOWN", message: "AX value write outcome is unknown")
            }
            // Not settable: type it into this element instead.
            guard TextEntryPreflight.allowsTyping(
                role: DesktopCatalog.text(element, "AXRole"), valueSettable: false,
                bundleID: target.bundleID) || DesktopCatalog.text(element, "AXRole") == "AXTextField" else {
                throw NativeError.denied(code: "TARGET_NOT_VISIBLE",
                                         message: "Focused element is not an editable text control")
            }
            try typeKeys(text, into: element, foregroundRequiresEditableFocus: false)
        case "typeText":
            try Self.keys(action, required: ["kind", "text"], optional: ["ref"])
            guard let text = action["text"] as? String, !text.isEmpty, text.count <= 2_000 else {
                throw invalid("Invalid text")
            }
            let textElement = try action["ref"] == nil ? nil : self.element(action, target: target)
            if let textElement { pointAt(textElement) }
            if let textElement, Self.isSecure(textElement) {
                throw NativeError.denied(code: "SECURE_INPUT_ACTIVE", message: "Secure field requires user input")
            }
            if let textElement {
                // Chromium apps do not report the element as the app's focused
                // element; judge the element the model named instead.
                var settable: DarwinBoolean = false
                let valueSettable = AXUIElementIsAttributeSettable(
                    textElement, "AXValue" as CFString, &settable) == .success && settable.boolValue
                guard TextEntryPreflight.allowsTyping(
                    role: DesktopCatalog.text(textElement, "AXRole"), valueSettable: valueSettable,
                    bundleID: target.bundleID) else {
                    throw NativeError.denied(code: "TARGET_NOT_VISIBLE",
                                             message: "Focused element is not an editable text control")
                }
            }
            try typeKeys(text, into: textElement, foregroundRequiresEditableFocus: true)
        case "press":
            try Self.keys(action, required: ["kind", "key"], optional: ["ref"])
            guard let key = action["key"] as? String, (1...64).contains(key.utf8.count) else {
                throw invalid("Invalid key")
            }
            guard let chord = try? KeyChord.parse(key) else { throw invalid("Unknown key chord") }
            let keyElement = try action["ref"] == nil ? nil : self.element(action, target: target)
            if let keyElement { pointAt(keyElement) }
            if let keyElement, Self.isSecure(keyElement) {
                throw NativeError.denied(code: "SECURE_INPUT_ACTIVE", message: "Secure field requires the credential-fill path")
            }
            settleKeyMiss()
            // An app in the background does not see key equivalents; run the
            // menu command a Command shortcut stands for instead.
            let shortcutItem = useBackgroundKeys && keyElement == nil && chord.modifiers.contains("command")
                && !LiveWorkspace.isActive(target.pid)
                ? KeyMapper.character(forVirtualKey: chord.virtualKey).flatMap {
                    MenuBarAccess.item(forShortcut: $0, modifiers: chord.modifiers, pid: target.pid)
                }
                : nil
            if let item = shortcutItem, DesktopCatalog.bool(item, "AXEnabled") {
                try dispatch()
                try Self.perform(item, "AXPress")
            } else if useBackgroundKeys {
                if let item = shortcutItem {
                    // Greyed out in the background: the key works only in front.
                    try frontForGreyedCommand(item, for: .keyboard, requireEnabled: false)
                }
                try prepareBackgroundKeyboard(target, element: keyElement, bringForward: bringForward)
                try absorbOwnFocus(keyElement, verify: !target.chromiumAccessibility, settle: true)
                try Self.requireNonSecureBackgroundFocus(target)
                try dispatch()
                try input.press(chord, toProcess: target.pid)
            } else {
                try foreground(.keyboard)
                try absorbOwnFocus(nil)
                if let keyElement {
                    guard AXUIElementSetAttributeValue(keyElement, "AXFocused" as CFString,
                                                      NSNumber(value: true)) == .success else {
                        throw NativeError.denied(code: "DRIVER_UNAVAILABLE", message: "Cannot focus element")
                    }
                    try absorbOwnFocus(keyElement)
                }
                try InputController.requireKeyboardAvailable()
                try Self.requireNonSecureKeyboardTarget(target)
                try dispatch()
                try input.press(chord)
            }
        case "scroll":
            try Self.keys(action, required: ["kind", "direction", "amount", "unit"], optional: ["ref"])
            guard let direction = action["direction"] as? String,
                  ["up", "down", "left", "right"].contains(direction),
                  let amount = Self.integer(action["amount"]), (1...20).contains(amount),
                  let unit = action["unit"] as? String, ["page", "line"].contains(unit) else {
                throw invalid("Invalid scroll")
            }
            let element = try action["ref"] == nil ? target.element : self.element(action, target: target)
            if action["ref"] != nil { pointAt(element) }
            // A scroll area's own page action runs in the background, but
            // AppKit can offer it and do nothing (TextEdit, 2026-09-29): only
            // a scroll bar that moves proves it, else the wheel below runs.
            var scrolledInBackground = false
            if let (scroller, axName) = Self.backgroundScroll(from: element, direction: direction, unit: unit),
               let bar = Self.scrollBar(of: scroller, vertical: direction == "up" || direction == "down"),
               let before = Self.scrollPosition(bar) {
                try dispatch()
                _ = try? Self.perform(scroller, axName)
                let deadline = ContinuousClock.now.advanced(by: .milliseconds(250))
                while Self.scrollPosition(bar) == before && ContinuousClock.now < deadline {
                    Thread.sleep(forTimeInterval: 0.03)
                }
                if Self.scrollPosition(bar) != before {
                    scrolledInBackground = true
                    confirmedPostcondition = { Self.scrollPosition(bar) != before }
                    for _ in 1..<amount { try input.checkCancellation(); try Self.perform(scroller, axName) }
                }
            }
            // A native app pages its document or list on PageDown / PageUp
            // posted to its process, still in the background (2026-09-29).
            if !scrolledInBackground, unit == "page", direction == "up" || direction == "down",
               useBackgroundKeys, !target.chromiumAccessibility,
               let document = Self.pagedDocument(for: element),
               let chord = try? KeyChord.parse(direction == "down" ? "PageDown" : "PageUp") {
                try prepareBackgroundKeyboard(target, element: document, bringForward: false)
                try absorbOwnFocus(document, verify: true, settle: true)
                try Self.requireNonSecureBackgroundFocus(target)
                if let area = Self.parentScrollArea(of: document),
                   let bar = Self.scrollBar(of: area, vertical: true),
                   let before = Self.scrollPosition(bar) {
                    confirmedPostcondition = { Self.scrollPosition(bar) != before }
                }
                try dispatch()
                for _ in 0..<amount { try input.press(chord, toProcess: target.pid) }
                scrolledInBackground = true
            }
            if !scrolledInBackground {
                let point = try Self.center(element)
                try foreground()
                try hitTest(point, target: target)
                let pageSize = Int(max(1, min(100_000, (target.frame?.height ?? 500) * 0.9)))
                let distance = Int32(min(Int(Int32.max), amount * (unit == "page" ? pageSize : 40)))
                let vertical: Int32 = direction == "up" ? distance : direction == "down" ? -distance : 0
                let horizontal: Int32 = direction == "left" ? distance : direction == "right" ? -distance : 0
                try dispatch()
                try input.scroll(point: point, vertical: vertical, horizontal: horizontal)
            }
        case "drag":
            try Self.keys(action, required: ["kind", "from", "to"])
            let start = try resolvePoint(action["from"], target: target)
            let end = try resolvePoint(action["to"], target: target)
            pointerPoint = (start, end)
            try foreground()
            try hitTest(start, target: target)
            try hitTest(end, target: target)
            try dispatch()
            try input.drag(from: start, to: end)
        case "secondary":
            try Self.keys(action, required: ["kind", "ref", "action"])
            guard let name = action["action"] as? String, !name.isEmpty, name.utf8.count <= 64 else {
                throw invalid("Invalid AX action")
            }
            let element = try self.element(action, target: target)
            pointAt(element)
            guard Self.actionNames(element).contains(name) else {
                throw NativeError.denied(code: "INVALID_REQUEST", message: "AX action is not offered by element")
            }
            // Some AppKit pop-up menus appear without an AXObserver revision.
            // A new AXMenu child on the exact action element is an observable
            // postcondition; an already-open menu is not evidence of this act.
            if name == "AXRaise" {
                // Raising a background app's window puts it over the user's work.
                guard ForegroundConsent.allows(activationRequested: false,
                                               targetActive: LiveWorkspace.isActive(target.pid)) else {
                    throw NativeError.denied(code: "TARGET_NOT_VISIBLE", message: "Target app is in the background")
                }
                // Raising the window that is already in front changes nothing
                // the observer sees; being the main window is the goal state.
                confirmedPostcondition = { DesktopCatalog.bool(element, "AXMain") }
            } else if name == "AXShowMenu" && DesktopCatalog.text(element, "AXRole") == "AXPopUpButton" {
                let before = MenuActionPostcondition.childRoles(of: element)
                confirmedPostcondition = {
                    MenuActionPostcondition.opened(
                        before: before,
                        after: MenuActionPostcondition.childRoles(of: element))
                }
            } else if name == "AXCancel", DesktopCatalog.text(element, "AXRole") == "AXMenu",
                      let parent = MenuActionPostcondition.popupParent(of: element) {
                let before = MenuActionPostcondition.childRoles(of: parent)
                confirmedPostcondition = {
                    MenuActionPostcondition.closed(
                        before: before,
                        after: MenuActionPostcondition.childRoles(of: parent))
                }
            }
            try dispatch()
            try Self.perform(element, name)
        case "menu":
            try Self.keys(action, required: ["kind", "path"])
            guard let path = action["path"] as? [String], MenuPath.isValid(path) else {
                throw invalid("Invalid menu path")
            }
            let item = try MenuBarAccess.resolve(path: path, pid: target.pid)
            guard MenuBarAccess.submenu(of: item) == nil else {
                throw NativeError.denied(code: "INVALID_REQUEST", message: "Menu path names a menu, not a command")
            }
            guard Self.actionNames(item).contains("AXPress") else {
                throw NativeError.denied(code: "CAPABILITY_DISABLED", message: "Menu item has no press action")
            }
            try frontForGreyedCommand(item, for: .pointer, requireEnabled: true)
            try dispatch()
            try Self.perform(item, "AXPress")
        case "activate":
            try Self.keys(action, required: ["kind"])
            confirmedPostcondition = { LiveWorkspace.isActive(target.pid) }
            try dispatch()
            // Bring a minimized window back; the user agreed to see it.
            if DesktopCatalog.bool(target.element, "AXMinimized") {
                _ = AXUIElementSetAttributeValue(target.element, "AXMinimized" as CFString, kCFBooleanFalse)
                Thread.sleep(forTimeInterval: 0.3)
            }
            try ensureForeground(target, for: .pointer, activationRequested: true)
        default:
            throw invalid("Unsupported desktop action")
        }
        guard dispatched else { throw invalid("No action dispatched") }
        do {
            var result = try observedResult(target: target, generation: generation, before: observationBaseline,
                                             directValueConfirmed: false,
                                             confirmedPostcondition: confirmedPostcondition,
                                             timeoutMilliseconds: settleMilliseconds)
            if let typed = typedEvidence, let after = Self.textLength(typed.element),
               TypedTextEvidence.shortfall(expected: typed.expected, delta: after - typed.before) {
                warnings.append("Only \(max(0, after - typed.before)) of \(typed.expected) characters reached the field; observe it before continuing.")
            }
            if let appendCheck, !appendCheck() {
                warnings.append("The field does not end with the appended text; observe it before continuing.")
            }
            if !warnings.isEmpty { result["warnings"] = warnings }
            return result
        } catch let error as NativeError
                    where error.code == "OUTCOME_UNKNOWN" && error.message == UnconfirmedEffect.message {
            // Never replayed: the next keyboard action checks this field.
            guard let receiver = backgroundReceiver else { throw error }
            target.keyMiss = receiver
            throw NativeError.denied(code: "OUTCOME_UNKNOWN", message: "Background key delivery unconfirmed")
        }
    }

    /// The `act.dispatched` pointer: where the action lands, and whether the
    /// user can see that point (the target window is frontmost there).
    private func pointerPayload(at point: CGPoint, to end: CGPoint?, target: BoundTarget) -> [String: Any] {
        let visible = PointerVisibility.visible(
            at: Point(x: point.x, y: point.y), windows: CGWindowInventory.onScreen(),
            targetWindowID: target.cgWindowID, targetPID: target.pid, mainPID: verifiedMainPID)
        var payload: [String: Any] = ["x": Double(point.x), "y": Double(point.y), "visible": visible]
        if let end { payload["to"] = ["x": Double(end.x), "y": Double(end.y)] }
        return payload
    }

    private func observedResult(target: BoundTarget, generation: Int, before: Int,
                                directValueConfirmed: Bool,
                                confirmedPostcondition: (() -> Bool)? = nil,
                                timeoutMilliseconds: Int = 700) throws -> [String: Any] {
        let deadline = ContinuousClock.now.advanced(by: .milliseconds(timeoutMilliseconds))
        while ContinuousClock.now < deadline {
            try input.checkCancellation()
            do {
                let current = try catalog.target(id: target.id, generation: generation)
                if current.revision > before || directValueConfirmed {
                    return ["outcome": "observed", "afterRevision": current.revision,
                            "title": current.title]
                }
                if confirmedPostcondition?() == true {
                    let confirmed = try catalog.confirmSemanticChange(id: target.id,
                                                                       generation: generation,
                                                                       before: before)
                    return ["outcome": "observed", "afterRevision": confirmed.revision,
                            "title": confirmed.title]
                }
            } catch let error as NativeError where error.code == "STALE_TARGET" && error.message == "Window identity changed" {
                // The window (or its app) is gone: typically the action closed
                // or quit it. Still unconfirmed, but say what happened.
                HelperDiagnostic.emit("POST_DISPATCH_TARGET_CLOSED")
                throw NativeError.denied(code: "OUTCOME_UNKNOWN", message: "Target window closed after dispatch")
            } catch let error as NativeError {
                HelperDiagnostic.emit("POST_DISPATCH_RECHECK_FAILED", ["code": error.code])
                throw NativeError.denied(code: "OUTCOME_UNKNOWN", message: "Target changed after dispatch")
            } catch {
                HelperDiagnostic.emit("POST_DISPATCH_RECHECK_FAILED", ["code": "UNEXPECTED"])
                throw NativeError.denied(code: "OUTCOME_UNKNOWN", message: "Target changed after dispatch")
            }
            Thread.sleep(forTimeInterval: 0.05)
        }
        HelperDiagnostic.emit("POST_DISPATCH_NO_REVISION")
        throw NativeError.denied(code: "OUTCOME_UNKNOWN", message: UnconfirmedEffect.message)
    }

    private func element(_ action: [String: Any], target: BoundTarget) throws -> AXUIElement {
        try Self.resolveElement(ref: action["ref"] as? String, target: target)
    }

    static func resolveElement(ref: String?, target: BoundTarget) throws -> AXUIElement {
        guard let ref, ElementReference.isCurrent(ref, revision: target.revision),
              let element = target.refElements[ref] else {
            throw NativeError.denied(code: "STALE_ELEMENT", message: "Element reference is stale")
        }
        var pid: pid_t = 0
        guard AXUIElementGetPid(element, &pid) == .success, pid == target.pid,
              DesktopCatalog.attribute(element, "AXRole") != nil else {
            throw NativeError.denied(code: "STALE_ELEMENT", message: "Element identity changed")
        }
        guard Self.belongsToWindow(element, target: target) else {
            throw NativeError.denied(code: "STALE_ELEMENT", message: "Element moved outside the bound window")
        }
        return element
    }

    private func resolvePoint(_ value: Any?, target: BoundTarget) throws -> CGPoint {
        if let ref = value as? String {
            return try Self.center(element(["ref": ref], target: target))
        }
        return try point(value, target: target)
    }

    private func point(_ value: Any?, target: BoundTarget) throws -> CGPoint {
        guard let raw = value as? [String: Any], Set(raw.keys) == ["screenshotId", "x", "y"],
              let id = raw["screenshotId"] as? String,
              let px = Self.finiteNumber(raw["x"]), let py = Self.finiteNumber(raw["y"]),
              px >= 0, py >= 0,
              let capture = target.lastScreenshot,
              capture.id == id, capture.revision == target.revision,
              capture.generation == target.generation, capture.frame == target.frame else {
            throw NativeError.denied(code: "STALE_TARGET", message: "Screenshot reference is stale")
        }
        guard let point = try? Coordinates.screenshotToGlobal(pixel: Point(x: px, y: py),
                                                              window: capture.frame, scale: capture.scale) else {
            throw invalid("Screenshot point is outside the image")
        }
        return CGPoint(x: point.x, y: point.y)
    }

    private static func center(_ element: AXUIElement) throws -> CGPoint {
        guard let frame = DesktopCatalog.frame(element), frame.width > 0, frame.height > 0 else {
            throw NativeError.denied(code: "STALE_ELEMENT", message: "Element has no current bounds")
        }
        return CGPoint(x: frame.x + frame.width / 2, y: frame.y + frame.height / 2)
    }

    private func hitTest(_ point: CGPoint, target: BoundTarget) throws {
        guard let frame = target.frame,
              point.x >= frame.x, point.y >= frame.y,
              point.x < frame.x + frame.width, point.y < frame.y + frame.height else {
            throw NativeError.denied(code: "STALE_TARGET", message: "Point is outside bound window")
        }
        let system = AXUIElementCreateSystemWide()
        var hit: AXUIElement?
        guard AXUIElementCopyElementAtPosition(system, Float(point.x), Float(point.y), &hit) == .success,
              let hit else { throw NativeError.denied(code: "STALE_TARGET", message: "Cannot hit test point") }
        var pid: pid_t = 0
        guard AXUIElementGetPid(hit, &pid) == .success, pid == target.pid else {
            throw NativeError.denied(code: "STALE_TARGET", message: "Point belongs to another application")
        }
        guard Self.belongsToWindow(hit, target: target) else {
            throw NativeError.denied(code: "STALE_TARGET", message: "Point belongs to another window")
        }
    }

    static func belongsToWindow(_ element: AXUIElement, target: BoundTarget) -> Bool {
        var cursor = element
        for _ in 0..<32 {
            if CFEqual(cursor, target.element) { return true }
            guard let rawParent = DesktopCatalog.attribute(cursor, "AXParent"),
                  CFGetTypeID(rawParent) == AXUIElementGetTypeID() else { return false }
            let parent = unsafeDowncast(rawParent, to: AXUIElement.self)
            cursor = parent
        }
        return false
    }

    private static func finderOrphanFocusEvidence(app: AXUIElement,
                                                  target: BoundTarget) -> FinderOrphanFocusEvidence? {
        guard target.bundleID == "com.apple.finder",
              DesktopCatalog.attribute(app, "AXFocusedWindow") == nil,
              let rawFocused = DesktopCatalog.attribute(app, "AXFocusedUIElement"),
              CFGetTypeID(rawFocused) == AXUIElementGetTypeID() else { return nil }
        let focused = unsafeDowncast(rawFocused, to: AXUIElement.self)
        var focusedPID: pid_t = 0
        let focusedPIDMatches = AXUIElementGetPid(focused, &focusedPID) == .success && focusedPID == target.pid
        var settable: DarwinBoolean = false
        let valueSettable = AXUIElementIsAttributeSettable(focused, "AXValue" as CFString, &settable) == .success &&
            settable.boolValue
        let field = DesktopCatalog.frame(focused)
        let frameInside: Bool
        if let field, let window = target.frame, field.width > 0, field.height > 0 {
            frameInside = field.x >= window.x && field.y >= window.y &&
                field.x + field.width <= window.x + window.width &&
                field.y + field.height <= window.y + window.height
        } else {
            frameInside = false
        }
        var hit: AXUIElement?
        let hitStatus = field.map {
            AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(),
                Float($0.x + $0.width / 2), Float($0.y + $0.height / 2), &hit)
        }
        var hitPID: pid_t = 0
        let hitPIDMatches = hit.map { AXUIElementGetPid($0, &hitPID) == .success && hitPID == target.pid } == true
        let topLevel = DesktopCatalog.attribute(focused, "AXTopLevelUIElement")
        let topLevelCompatible = topLevel == nil ||
            (topLevel.map { CFGetTypeID($0) == AXUIElementGetTypeID() && CFEqual($0, target.element) } == true)
        let onScreenRows = CGWindowListCopyWindowInfo(
            [.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
        let candidates = CGWindowInventory.candidates(rows: onScreenRows)
        let boundWindowID = target.frame.flatMap {
            WindowMatcher.uniqueMatch(ax: WindowFingerprint(pid: target.pid, title: target.title, frame: $0),
                                      candidates: candidates)
        }
        let firstWindowAtPoint = field.flatMap { field in
            let x = field.x + field.width / 2, y = field.y + field.height / 2
            return candidates.first(where: {
                x >= $0.frame.x && y >= $0.frame.y &&
                    x < $0.frame.x + $0.frame.width && y < $0.frame.y + $0.frame.height
            })?.id
        }
        let evidence = FinderOrphanFocusEvidence(
            bundleID: target.bundleID, role: DesktopCatalog.text(focused, "AXRole"),
            focusedWindowMissing: true, focusedPIDMatches: focusedPIDMatches,
            elementFocused: DesktopCatalog.bool(focused, "AXFocused"), valueSettable: valueSettable,
            frameInside: frameInside, hitSameElement: hitStatus == .success &&
                hit.map { CFEqual($0, focused) } == true,
            hitPIDMatches: hitPIDMatches, topLevelCompatible: topLevelCompatible,
            boundCGWindowUnique: boundWindowID != nil,
            frontCGWindowMatches: boundWindowID != nil && firstWindowAtPoint == boundWindowID)
        HelperDiagnostic.emit("FINDER_ORPHAN_FOCUS", [
            "accepted": String(evidence.allowsKeyboard),
            "role": evidence.role,
            "hitStatus": String(hitStatus?.rawValue ?? -1),
            "hitRole": hit.map { DesktopCatalog.text($0, "AXRole") } ?? "missing",
            "hitPIDValue": String(hitPID),
            "frontmostPID": String(LiveWorkspace.activeApplication()?.processIdentifier ?? 0),
            "focusedPID": String(evidence.focusedPIDMatches),
            "elementFocused": String(evidence.elementFocused),
            "valueSettable": String(evidence.valueSettable),
            "frameInside": String(evidence.frameInside),
            "hitSameElement": String(evidence.hitSameElement),
            "hitPID": String(evidence.hitPIDMatches),
            "topLevel": String(evidence.topLevelCompatible),
            "boundCGWindow": String(evidence.boundCGWindowUnique),
            "frontCGWindow": String(evidence.frontCGWindowMatches),
        ])
        return evidence
    }

    /// Background keyboard delivery (E-M6b): make the bound window the app's
    /// main window and focus the named element, all without activating the
    /// app. Keys posted to the process go to that window; if the app still
    /// reports another window as focused (a dialog, say), refuse.
    private func prepareBackgroundKeyboard(_ target: BoundTarget, element: AXUIElement?,
                                           bringForward: Bool) throws {
        if !KeyboardDeliveryPolicy.deliverable(chromium: target.chromiumAccessibility,
                                               targetActive: LiveWorkspace.isActive(target.pid)) {
            // Chromium takes keys only in front: bring it forward when the
            // user allows that for this task, otherwise send nothing.
            guard bringForward else {
                throw NativeError.denied(code: "TARGET_NOT_VISIBLE", message: "Background keys are ignored by this app")
            }
            try ensureForeground(target, for: .keyboard, activationRequested: true)
        }
        // Writing AXMain can reorder the app's own windows; only when needed.
        // Chromium reads it as a focus change and closes transient UI such as
        // VS Code's command palette, so never for Chromium (it is active here).
        if !target.chromiumAccessibility, !DesktopCatalog.bool(target.element, "AXMain") {
            _ = AXUIElementSetAttributeValue(target.element, "AXMain" as CFString, kCFBooleanTrue)
        }
        if let element {
            let status = AXUIElementSetAttributeValue(element, "AXFocused" as CFString, kCFBooleanTrue)
            // Chromium accepts keys for an element it reports poorly; others must take focus.
            guard status == .success || target.chromiumAccessibility else {
                throw NativeError.denied(code: "DRIVER_UNAVAILABLE", message: "Cannot focus text element")
            }
        }
        Thread.sleep(forTimeInterval: 0.05)
        let app = AXUIElementCreateApplication(target.pid)
        if let focused = DesktopCatalog.attribute(app, "AXFocusedWindow"),
           CFGetTypeID(focused) == AXUIElementGetTypeID(), !CFEqual(focused, target.element) {
            throw NativeError.denied(code: "TARGET_NOT_VISIBLE", message: "Bring target window to the front")
        }
    }

    /// Our own focus writes post AX notifications a little later; wait until
    /// the revision has held for 100 ms (at most 300 ms) before absorbing it.
    private func settledTarget(id: String, generation: Int) throws -> BoundTarget {
        let deadline = ContinuousClock.now.advanced(by: .milliseconds(300))
        var current = try catalog.target(id: id, generation: generation)
        var stableSince = ContinuousClock.now
        while ContinuousClock.now < deadline {
            Thread.sleep(forTimeInterval: 0.02)
            let next = try catalog.target(id: id, generation: generation)
            if next.revision != current.revision {
                current = next
                stableSince = ContinuousClock.now
            } else if stableSince.duration(to: .now) >= .milliseconds(100) {
                break
            }
        }
        return current
    }

    /// Keys never go to a secure field. Chromium apps may report no focused
    /// element at all; the window check above already bounds where keys land.
    private static func requireNonSecureBackgroundFocus(_ target: BoundTarget) throws {
        let app = AXUIElementCreateApplication(target.pid)
        var focusedIsSecure = false
        if let raw = DesktopCatalog.attribute(app, "AXFocusedUIElement"),
           CFGetTypeID(raw) == AXUIElementGetTypeID() {
            focusedIsSecure = isSecure(unsafeDowncast(raw, to: AXUIElement.self))
        }
        if focusedIsSecure {
            throw NativeError.denied(code: "SECURE_INPUT_ACTIVE", message: "Secure field requires the credential-fill path")
        }
        let secure = SecureInputState.current()
        guard !SecureKeyboardPolicy.refuses(
            focusedIsSecure: false, secureInputOn: secure.on,
            ownerPID: secure.ownerPID, targetPID: target.pid,
            targetActive: LiveWorkspace.isActive(target.pid)) else {
            throw NativeError.denied(code: "SECURE_INPUT_ACTIVE", message: "Secure keyboard input is active")
        }
    }

    private func ensureForeground(_ target: BoundTarget,
                                  for inputKind: ForegroundPreflight.InputKind,
                                  activationRequested: Bool) throws {
        guard ForegroundConsent.allows(activationRequested: activationRequested,
                                       targetActive: LiveWorkspace.isActive(target.pid)) else {
            throw NativeError.denied(code: "TARGET_NOT_VISIBLE", message: "Target app is in the background")
        }
        // Whoever had the front before the first activation gets it back at
        // the end of the task (front.restore).
        if !LiveWorkspace.isActive(target.pid), target.previousFrontPID == nil,
           let previous = LiveWorkspace.activeApplication()?.processIdentifier, previous != target.pid {
            target.previousFrontPID = previous
        }
        var activationSucceeded = true
        if !LiveWorkspace.isActive(target.pid) {
            let app = AXUIElementCreateApplication(target.pid)
            activationSucceeded = AXUIElementSetAttributeValue(
                app, "AXFrontmost" as CFString, NSNumber(value: true)) == .success
        }
        // A background target may need raising to become the focused window.
        // Avoid raising an already focused keyboard target, and leave an
        // unbound transient text editor untouched so the check below can
        // reject it without destroying the user's edit state.
        let app = AXUIElementCreateApplication(target.pid)
        let priorWindow = DesktopCatalog.attribute(app, "AXFocusedWindow")
        let focusedWindowIsBound = priorWindow.map { CFEqual($0, target.element) } == true
        let focusedElement = DesktopCatalog.attribute(app, "AXFocusedUIElement")
        var focusedPID: pid_t = 0
        let focusedIsElement = focusedElement.map { CFGetTypeID($0) == AXUIElementGetTypeID() } == true
        let focusedRole = focusedIsElement
            ? DesktopCatalog.text(focusedElement as! AXUIElement, "AXRole") : ""
        if focusedIsElement { _ = AXUIElementGetPid(focusedElement as! AXUIElement, &focusedPID) }
        let orphanTextFocus = priorWindow == nil && focusedPID == target.pid &&
            (focusedRole == "AXTextField" || focusedRole == "AXTextArea")
        let raiseSucceeded = ForegroundPreflight.shouldRaiseWindow(
            for: inputKind,
            targetIsFrontmost: LiveWorkspace.isActive(target.pid),
            focusedWindowIsBound: focusedWindowIsBound,
            orphanTextFocus: orphanTextFocus)
            ? AXUIElementPerformAction(target.element, "AXRaise" as CFString) == .success
            : false
        Thread.sleep(forTimeInterval: 0.15)
        // Activation is asynchronous; give it a short, bounded settle.
        let settleDeadline = ContinuousClock.now.advanced(by: .milliseconds(500))
        while !LiveWorkspace.isActive(target.pid) && ContinuousClock.now < settleDeadline {
            Thread.sleep(forTimeInterval: 0.03)
        }
        try Self.requireUnprotectedForeground(verifiedMainPID: verifiedMainPID)
        guard LiveWorkspace.isActive(target.pid) else {
            let frontmostPID = LiveWorkspace.activeApplication()?.processIdentifier ?? 0
            HelperDiagnostic.emit("PREFLIGHT_FOREGROUND_MISMATCH", [
                "targetPID": String(target.pid), "frontmostPID": String(frontmostPID),
                "activationSucceeded": String(activationSucceeded),
                "raiseSucceeded": String(raiseSucceeded),
            ])
            throw NativeError.denied(code: "TARGET_NOT_VISIBLE", message: "Bring target window to the foreground")
        }
        // An app just brought forward settles its window focus a moment later
        // (Electron especially); allow that before judging the focused window.
        func focusedWindow() -> (isWindow: Bool, isBound: Bool) {
            let focused = DesktopCatalog.attribute(app, "AXFocusedWindow")
            let isWindow = focused.map { CFGetTypeID($0) == AXUIElementGetTypeID() } ?? false
            return (isWindow, isWindow && focused.map { CFEqual($0, target.element) } == true)
        }
        var (focusedIsWindow, focusedIsBound) = focusedWindow()
        let focusDeadline = ContinuousClock.now.advanced(by: .milliseconds(500))
        while !focusedIsBound && ContinuousClock.now < focusDeadline {
            Thread.sleep(forTimeInterval: 0.05)
            (focusedIsWindow, focusedIsBound) = focusedWindow()
        }
        let orphanEvidence = focusedIsBound ? nil : Self.finderOrphanFocusEvidence(app: app, target: target)
        let verifiedOrphan = orphanEvidence?.allowsKeyboard == true
        guard focusedIsBound || verifiedOrphan else {
            HelperDiagnostic.emit("PREFLIGHT_FOCUS_MISMATCH", [
                "targetPID": String(target.pid), "focusedIsWindow": String(focusedIsWindow),
                "focusedIsBound": String(focusedIsBound),
                "activationSucceeded": String(activationSucceeded),
                "raiseSucceeded": String(raiseSucceeded),
            ])
            let message = orphanEvidence?.inputPointUnverified == true
                ? "Finder input point could not be verified"
                : "Bring target window to the front"
            throw NativeError.denied(code: "TARGET_NOT_VISIBLE", message: message)
        }
    }

    static func requireUnprotectedForeground(verifiedMainPID: pid_t?) throws {
        // Never trust AppKit's cached frontmost app here (see LiveWorkspace):
        // a protected prompt that just came up must still block the action.
        guard let front = LiveWorkspace.activeApplication() else {
            HelperDiagnostic.emit("PROTECTED_FOREGROUND", ["workspacePID": "unknown"])
            throw NativeError.denied(code: "TARGET_NOT_VISIBLE", message: "Frontmost application could not be verified")
        }
        if ProtectedTargets.blocksForegroundAction(bundleID: front.bundleIdentifier ?? "",
                                                   executablePath: front.executableURL?.path,
                                                   pid: front.processIdentifier,
                                                   verifiedMainPID: verifiedMainPID) {
            HelperDiagnostic.emit("PROTECTED_FOREGROUND", ["workspacePID": String(front.processIdentifier)])
            throw NativeError.denied(code: "TARGET_FORBIDDEN", message: "Protected application is frontmost")
        }
    }

    static func isSecure(_ element: AXUIElement) -> Bool {
        let role = DesktopCatalog.text(element, "AXRole")
        let subrole = DesktopCatalog.text(element, "AXSubrole")
        return role == "AXSecureTextField" || subrole == "AXSecureTextField"
    }

    private static func requireNonSecureKeyboardTarget(_ target: BoundTarget,
                                                       requireEditableText: Bool = false) throws {
        let app = AXUIElementCreateApplication(target.pid)
        guard let raw = DesktopCatalog.attribute(app, "AXFocusedUIElement"),
              CFGetTypeID(raw) == AXUIElementGetTypeID() else {
            throw NativeError.denied(code: "DRIVER_UNAVAILABLE", message: "Focused keyboard target is unavailable")
        }
        let focused = unsafeDowncast(raw, to: AXUIElement.self)
        guard belongsToWindow(focused, target: target) ||
              finderOrphanFocusEvidence(app: app, target: target)?.allowsKeyboard == true else {
            throw NativeError.denied(code: "TARGET_NOT_VISIBLE", message: "Focused element is outside the bound window")
        }
        guard !isSecure(focused) else {
            throw NativeError.denied(code: "SECURE_INPUT_ACTIVE", message: "Secure field requires the credential-fill path")
        }
        if requireEditableText {
            var settable: DarwinBoolean = false
            let valueSettable = AXUIElementIsAttributeSettable(
                focused, "AXValue" as CFString, &settable) == .success && settable.boolValue
            guard TextEntryPreflight.allowsTyping(
                role: DesktopCatalog.text(focused, "AXRole"), valueSettable: valueSettable,
                bundleID: target.bundleID) else {
                throw NativeError.denied(code: "TARGET_NOT_VISIBLE",
                                         message: "Focused element is not an editable text control")
            }
        }
    }

    private static func focusedElement(of target: BoundTarget) -> AXUIElement? {
        guard let raw = DesktopCatalog.attribute(AXUIElementCreateApplication(target.pid), "AXFocusedUIElement"),
              CFGetTypeID(raw) == AXUIElementGetTypeID() else { return nil }
        return unsafeDowncast(raw, to: AXUIElement.self)
    }

    /// Character count only; the text itself is never kept or reported.
    private static func settable(_ element: AXUIElement, _ attribute: String) -> Bool {
        var settable: DarwinBoolean = false
        return AXUIElementIsAttributeSettable(element, attribute as CFString, &settable) == .success
            && settable.boolValue
    }

    /// The length of the selection typing would replace (0 when unreadable).
    private static func selectedLength(_ element: AXUIElement) -> Int {
        guard let raw = DesktopCatalog.attribute(element, "AXSelectedTextRange"),
              CFGetTypeID(raw) == AXValueGetTypeID() else { return 0 }
        var range = CFRange(location: 0, length: 0)
        guard AXValueGetValue(unsafeDowncast(raw, to: AXValue.self), .cfRange, &range) else { return 0 }
        return max(0, range.length)
    }

    private static func textLength(_ element: AXUIElement) -> Int? {
        if let count = DesktopCatalog.attribute(element, "AXNumberOfCharacters") as? NSNumber {
            return count.intValue
        }
        return (DesktopCatalog.attribute(element, "AXValue") as? String)?.utf16.count
    }

    private static func actionNames(_ element: AXUIElement) -> [String] {
        var raw: CFArray?
        guard AXUIElementCopyActionNames(element, &raw) == .success else { return [] }
        return raw as? [String] ?? []
    }

    private static func popupOption(_ title: String, in popup: AXUIElement) -> AXUIElement? {
        guard let children = DesktopCatalog.attribute(popup, "AXChildren") as? [AXUIElement] else {
            return nil
        }
        let menus = children.filter { DesktopCatalog.text($0, "AXRole") == "AXMenu" }
        guard menus.count == 1,
              let items = DesktopCatalog.attribute(menus[0], "AXChildren") as? [AXUIElement] else {
            return nil
        }
        let matches = items.filter {
            DesktopCatalog.text($0, "AXRole") == "AXMenuItem" &&
                DesktopCatalog.text($0, "AXTitle") == title &&
                DesktopCatalog.bool($0, "AXEnabled")
        }
        return matches.count == 1 ? matches[0] : nil
    }

    private static func focusedElement(pid: pid_t) -> AXUIElement? {
        guard let raw = DesktopCatalog.attribute(AXUIElementCreateApplication(pid), "AXFocusedUIElement"),
              CFGetTypeID(raw) == AXUIElementGetTypeID() else { return nil }
        return unsafeDowncast(raw, to: AXUIElement.self)
    }

    /// Whether focus moved to an editable single-line text field, as when a
    /// command opens an inline name editor.
    private static func openedTextField(pid: pid_t, before: AXUIElement?) -> Bool {
        guard let now = focusedElement(pid: pid), DesktopCatalog.text(now, "AXRole") == "AXTextField" else {
            return false
        }
        if let before, CFEqual(before, now) { return false }
        var settable: DarwinBoolean = false
        return AXUIElementIsAttributeSettable(now, "AXValue" as CFString, &settable) == .success && settable.boolValue
    }

    /// The named element, or its nearest enclosing scroll area within the
    /// window, when it offers to scroll itself: no pointer and no front.
    private static func backgroundScroll(from element: AXUIElement, direction: String,
                                         unit: String) -> (AXUIElement, String)? {
        let names = ScrollActions.candidates(direction: direction, unit: unit)
        var node = element
        for _ in 0..<8 {
            let offered = actionNames(node)
            if let name = names.first(where: offered.contains) { return (node, name) }
            let role = DesktopCatalog.text(node, "AXRole")
            // Never scroll an outer area for an inner one that cannot.
            guard role != "AXScrollArea", role != "AXWindow",
                  let raw = DesktopCatalog.attribute(node, "AXParent"),
                  CFGetTypeID(raw) == AXUIElementGetTypeID() else { return nil }
            node = unsafeDowncast(raw, to: AXUIElement.self)
        }
        return nil
    }

    /// The document or list that pages on PageDown: the element itself, or
    /// the content of the scroll area named.
    private static func pagedDocument(for element: AXUIElement) -> AXUIElement? {
        let role = DesktopCatalog.text(element, "AXRole")
        if PagedScroll.pageableRoles.contains(role) { return element }
        guard role == "AXScrollArea" else { return nil }
        let contents = DesktopCatalog.attribute(element, "AXContents") as? [AXUIElement]
            ?? DesktopCatalog.attribute(element, "AXChildren") as? [AXUIElement] ?? []
        return contents.first { PagedScroll.pageableRoles.contains(DesktopCatalog.text($0, "AXRole")) }
    }

    private static func parentScrollArea(of element: AXUIElement) -> AXUIElement? {
        guard let raw = DesktopCatalog.attribute(element, "AXParent"),
              CFGetTypeID(raw) == AXUIElementGetTypeID() else { return nil }
        let parent = unsafeDowncast(raw, to: AXUIElement.self)
        return DesktopCatalog.text(parent, "AXRole") == "AXScrollArea" ? parent : nil
    }

    private static func scrollBar(of element: AXUIElement, vertical: Bool) -> AXUIElement? {
        guard let raw = DesktopCatalog.attribute(element, vertical ? "AXVerticalScrollBar" : "AXHorizontalScrollBar"),
              CFGetTypeID(raw) == AXUIElementGetTypeID() else { return nil }
        return unsafeDowncast(raw, to: AXUIElement.self)
    }

    private static func scrollPosition(_ bar: AXUIElement) -> Double? {
        (DesktopCatalog.attribute(bar, "AXValue") as? NSNumber)?.doubleValue
    }

    private static func perform(_ element: AXUIElement, _ action: String) throws {
        guard actionNames(element).contains(action) else {
            throw NativeError.denied(code: "STALE_ELEMENT", message: "AX action disappeared")
        }
        guard AXUIElementPerformAction(element, action as CFString) == .success else {
            throw NativeError.denied(code: "OUTCOME_UNKNOWN", message: "AX action outcome is unknown")
        }
    }

    private static func button(_ value: Any?) throws -> CGMouseButton {
        guard let value else { return .left }
        guard let text = value as? String else { throw invalid("Invalid mouse button") }
        switch text {
        case "left": return .left
        case "right": return .right
        case "middle": return .center
        default: throw invalid("Invalid mouse button")
        }
    }

    private static func clickCount(_ value: Any?) throws -> Int {
        guard let value else { return 1 }
        guard let count = integer(value), count == 1 || count == 2 else { throw invalid("Invalid click count") }
        return count
    }

    private static func keys(_ object: [String: Any], required: Set<String>, optional: Set<String> = []) throws {
        guard required.isSubset(of: Set(object.keys)),
              Set(object.keys).isSubset(of: required.union(optional)) else { throw invalid("Invalid action fields") }
    }

    private static func integer(_ value: Any?) -> Int? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
        return Int(number.stringValue)
    }

    private static func finiteNumber(_ value: Any?) -> Double? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
              number.doubleValue.isFinite else { return nil }
        return number.doubleValue
    }

    private static func invalid(_ message: String) -> NativeError {
        .denied(code: "INVALID_REQUEST", message: message)
    }

    private func invalid(_ message: String) -> NativeError { Self.invalid(message) }
}
