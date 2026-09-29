import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import HelperCore

public struct NativeWindow {
    public let ref: String
    public let pid: pid_t
    public let bundleID: String
    public let appName: String
    public let title: String
    public let frame: Rect?
    public let minimized: Bool
    public let main: Bool
    public let order: Int
    public let element: AXUIElement
    public let executablePath: String?
}

enum WindowReferenceMatcher {
    static func reusableRef(for candidate: NativeWindow, prior: [NativeWindow],
                            used: Set<String>) -> String? {
        let matches = prior.filter { old in
            !used.contains(old.ref) && old.pid == candidate.pid &&
                old.bundleID == candidate.bundleID &&
                old.executablePath == candidate.executablePath &&
                old.title == candidate.title && old.frame == candidate.frame &&
                CFEqual(old.element, candidate.element)
        }
        return matches.count == 1 ? matches[0].ref : nil
    }
}

public struct ScreenshotBinding {
    public let id: String
    public let revision: Int
    public let generation: Int
    public let frame: Rect
    public let scale: Double
}

public final class BoundTarget {
    public let id: String
    public let pid: pid_t
    public let bundleID: String
    public let executablePath: String?
    public let element: AXUIElement
    public let order: Int
    public let initialTitle: String
    public var generation = 1
    public var revision = 0
    public var title: String
    public var frame: Rect?
    public var lastObservedRevision: Int?
    public var lastObservedRefs: [String] = []
    public var revisionRegistration: AXRevisionRegistration?
    public var displaySignature: String
    public var refElements: [String: AXUIElement] = [:]
    public var lastScreenshot: ScreenshotBinding?
    public var cgWindowID: UInt32?
    /// Chrome, Edge or an Electron app: focus is under-reported through AX
    /// (VS Code never reports its command palette input as focused).
    public var chromiumAccessibility = false
    /// The app that was in front before an explicit `activate`; the task end
    /// hands the front back to it (`front.restore`).
    public var previousFrontPID: pid_t?
    /// A background key delivery that could not be confirmed: the field that
    /// should have received the text and its length then. The next keyboard
    /// action compares it, instead of replaying the keys.
    public var keyMiss: (element: AXUIElement, length: Int)?
    /// Keys proved not to reach this window in the background; they go
    /// through the front instead (activation is asked for as usual).
    public var keysNeedFront = false

    init(window: NativeWindow) {
        id = "t-" + UUID().uuidString
        pid = window.pid
        bundleID = window.bundleID
        executablePath = window.executablePath
        element = window.element
        order = window.order
        initialTitle = window.title
        title = window.title
        frame = window.frame
        displaySignature = DesktopCatalog.displaySignature()
    }
}

public final class DesktopCatalog {
    private struct AXAppMode {
        let pid: pid_t
        let application: AXUIElement
        let attribute: String
        let original: Bool
        var references: Int
    }
    private var windowRefs: [String: NativeWindow] = [:]
    private var knownWindows: [String: NativeWindow] = [:]
    private var targets: [String: BoundTarget] = [:]
    private var pendingEvents: [[String: Any]] = []
    private var appModes: [pid_t: AXAppMode] = [:]
    private var lastProcessCheck = ContinuousClock.now

    /// Emperor's verified main process: never listed or bound (00 §6.5).
    private let mainPID: pid_t?

    public init(mainPID: pid_t? = nil) { self.mainPID = mainPID }
    deinit {
        for target in targets.values { target.revisionRegistration?.stop() }
        for mode in appModes.values { restore(mode) }
    }
    public var targetCount: Int { targets.count }

    public func pollEvents() -> [[String: Any]] {
        if lastProcessCheck.duration(to: .now) >= .seconds(2) {
            lastProcessCheck = .now
            let exited = targets.compactMap { id, target in
                Self.runningApp(pid: target.pid, bundleID: target.bundleID,
                                executablePath: target.executablePath) == nil ? id : nil
            }
            for id in exited {
                guard let target = targets.removeValue(forKey: id) else { continue }
                target.revisionRegistration?.stop()
                releaseAppMode(pid: target.pid)
                pendingEvents.append(["type": "event", "name": "target.lost",
                                      "data": ["targetId": id, "reason": "Application exited"]])
            }
        }
        for target in targets.values { consumeRevisionChanges(target) }
        let events = pendingEvents
        pendingEvents.removeAll()
        return events
    }

    private func markChanged(_ target: BoundTarget) {
        target.revision += 1
        target.refElements.removeAll()
        target.lastScreenshot = nil
        pendingEvents.append(["type": "event", "name": "target.changed",
                              "data": ["targetId": target.id, "revision": target.revision]])
    }

    func confirmSemanticChange(id: String, generation: Int, before: Int) throws -> BoundTarget {
        let current = try target(id: id, generation: generation)
        if current.revision <= before { markChanged(current) }
        return current
    }

    private func consumeRevisionChanges(_ target: BoundTarget) {
        guard let changes = target.revisionRegistration?.takeChanges() else { return }
        if changes.semantic { markChanged(target) }
        else if changes.screenshotOnly { target.lastScreenshot = nil }
    }

    public func apps() -> [[String: Any]] {
        NSWorkspace.shared.runningApplications.compactMap { app in
            guard app.activationPolicy == .regular,
                  let id = app.bundleIdentifier, !id.isEmpty,
                  app.processIdentifier > 0,
                  !ProtectedTargets.forbidsTarget(bundleID: id,
                                                  executablePath: app.executableURL?.path,
                                                  pid: app.processIdentifier,
                                                  mainPID: mainPID) else { return nil }
            return [
                "appId": String(id.prefix(256)),
                "name": String((app.localizedName ?? id).prefix(256)),
                "pid": Int(app.processIdentifier),
                "frontmost": LiveWorkspace.isActive(app.processIdentifier),
                "hidden": app.isHidden,
            ] as [String: Any]
        }
    }

    public func windows(appID: String?) throws -> [[String: Any]] {
        try DesktopPermissions.requireAccessibility()
        windowRefs.removeAll()
        let prior = Array(knownWindows.values)
        var nextKnown = appID == nil ? [:] : knownWindows.filter { $0.value.bundleID != appID }
        var result: [[String: Any]] = []
        var filteredPID: pid_t?
        for app in NSWorkspace.shared.runningApplications where app.activationPolicy == .regular {
            guard let id = app.bundleIdentifier, !id.isEmpty,
                  app.processIdentifier > 0,
                  appID == nil || appID == id,
                  !ProtectedTargets.forbidsTarget(bundleID: id, executablePath: app.executableURL?.path,
                                                  pid: app.processIdentifier,
                                                  mainPID: mainPID) else { continue }
            let pid = app.processIdentifier
            if appID != nil { filteredPID = pid }
            let application = AXUIElementCreateApplication(pid)
            AXUIElementSetMessagingTimeout(application, 0.5)
            let windows: [AXUIElement]
            do {
                windows = try Self.axWindows(application)
            } catch {
                // A global listing is best effort across apps. A filtered
                // listing must not turn an AX transport failure into zero
                // windows for the requested app.
                if appID != nil { throw error }
                continue
            }
            for (index, element) in windows.enumerated() {
                AXUIElementSetMessagingTimeout(element, 0.5)
                let title = String(Self.text(element, "AXTitle").prefix(1_024))
                let frame = Self.frame(element)
                let proposed = NativeWindow(
                    ref: "w-" + UUID().uuidString, pid: pid, bundleID: id,
                    appName: String((app.localizedName ?? id).prefix(256)),
                    title: title, frame: frame,
                    minimized: Self.bool(element, "AXMinimized"),
                    main: Self.bool(element, "AXMain"), order: index,
                    element: element, executablePath: app.executableURL?.standardizedFileURL.path)
                let ref = WindowReferenceMatcher.reusableRef(
                    for: proposed, prior: prior, used: Set(nextKnown.keys)) ?? proposed.ref
                let window = NativeWindow(
                    ref: ref, pid: proposed.pid, bundleID: proposed.bundleID,
                    appName: proposed.appName, title: proposed.title, frame: proposed.frame,
                    minimized: proposed.minimized, main: proposed.main, order: proposed.order,
                    element: proposed.element, executablePath: proposed.executablePath)
                windowRefs[ref] = window
                nextKnown[ref] = window
                var item: [String: Any] = [
                    "windowRef": ref, "appId": id, "appName": window.appName,
                    "pid": Int(pid), "title": title, "minimized": window.minimized,
                    "main": window.main,
                ]
                if let frame {
                    item["bounds"] = ["x": frame.x, "y": frame.y,
                                      "width": frame.width, "height": frame.height]
                }
                result.append(item)
            }
        }
        if (appID == "com.google.Chrome" || appID == "com.microsoft.edgemac"),
           result.isEmpty, let filteredPID {
            // An empty AXWindows result can mean no window or an inaccessible
            // window. This count-only CG comparison and AX mode flag provide
            // a diagnosis without writing title, URL, or page content.
            let cgCount = CGWindowInventory.current().filter { $0.pid == filteredPID }.count
            let onScreenRows = CGWindowListCopyWindowInfo(
                [.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
            let onScreenCount = CGWindowInventory.candidates(rows: onScreenRows)
                .filter { $0.pid == filteredPID }.count
            let application = AXUIElementCreateApplication(filteredPID)
            AXUIElementSetMessagingTimeout(application, 0.5)
            var rawWindows: CFTypeRef?
            let axStatus = AXUIElementCopyAttributeValue(application, "AXWindows" as CFString,
                                                        &rawWindows)
            let axReadCount = (rawWindows as? [AXUIElement]).map { String($0.count) } ?? "unreadable"
            let modeRead = (Self.attribute(application, "AXEnhancedUserInterface") as? Bool)
                .map { String($0) } ?? "unreadable"
            HelperDiagnostic.emit("WINDOW_DISCOVERY", [
                "pid": String(filteredPID), "ax": "0", "cg": String(cgCount),
                "cgOnScreen": String(onScreenCount), "axStatus": String(axStatus.rawValue),
                "axReadCount": axReadCount,
                "modeRead": modeRead,
            ])
        }
        knownWindows = nextKnown
        return result
    }

    public func bind(windowRef: String) throws -> [String: Any] {
        try DesktopPermissions.requireAccessibility()
        guard let window = windowRefs.removeValue(forKey: windowRef) else {
            throw NativeError.denied(code: "STALE_TARGET", message: "Window reference is no longer current")
        }
        guard !ProtectedTargets.forbidsTarget(bundleID: window.bundleID, executablePath: window.executablePath,
                                              pid: window.pid, mainPID: mainPID) else {
            throw NativeError.denied(code: "TARGET_FORBIDDEN", message: "Protected application")
        }
        guard Self.runningApp(pid: window.pid, bundleID: window.bundleID,
                              executablePath: window.executablePath) != nil else {
            throw NativeError.denied(code: "STALE_TARGET", message: "Window identity changed")
        }
        guard try Self.windowStillExists(window.element, pid: window.pid),
              Self.text(window.element, "AXTitle") == window.title,
              Self.frame(window.element) == window.frame else {
            throw NativeError.denied(code: "STALE_TARGET", message: "Window identity changed")
        }
        enableAppModeIfNeeded(pid: window.pid, bundleID: window.bundleID)
        let application = AXUIElementCreateApplication(window.pid)
        AXUIElementSetMessagingTimeout(application, 0.5)
        let refreshed: [AXUIElement]
        do {
            refreshed = try Self.axWindows(application)
        } catch {
            releaseAppMode(pid: window.pid)
            throw error
        }
        let sameElement = refreshed.filter { CFEqual($0, window.element) }
        let sameFingerprint = refreshed.filter {
            Self.text($0, "AXTitle") == window.title && Self.frame($0) == window.frame
        }
        guard let element = sameElement.count == 1 ? sameElement.first :
                (sameFingerprint.count == 1 ? sameFingerprint.first : nil) else {
            releaseAppMode(pid: window.pid)
            throw NativeError.denied(code: "STALE_TARGET", message: "Window identity changed while binding")
        }
        guard Self.text(element, "AXTitle") == window.title,
              Self.frame(element) == window.frame else {
            releaseAppMode(pid: window.pid)
            throw NativeError.denied(code: "STALE_TARGET", message: "Window changed while binding")
        }
        let currentWindow = NativeWindow(
            ref: window.ref, pid: window.pid, bundleID: window.bundleID,
            appName: window.appName, title: window.title, frame: window.frame,
            minimized: window.minimized, main: window.main, order: window.order,
            element: element, executablePath: window.executablePath)
        // A fresh windowRef can name a window that is already bound. Retire
        // its old target before minting another ID, so two leases cannot act
        // on the same physical AX window through different target IDs.
        let replacedIDs = targets.compactMap { id, target in
            target.pid == window.pid && CFEqual(target.element, element) ? id : nil
        }
        for id in replacedIDs {
            targets.removeValue(forKey: id)?.revisionRegistration?.stop()
            releaseAppMode(pid: window.pid)
            pendingEvents.append(["type": "event", "name": "target.lost",
                                  "data": ["targetId": id, "reason": "Window rebound"]])
        }
        let target = BoundTarget(window: currentWindow)
        target.chromiumAccessibility = Self.chromiumModeAttribute(pid: window.pid, bundleID: window.bundleID) != nil
        if let frame = target.frame {
            target.cgWindowID = WindowMatcher.uniqueMatch(
                ax: WindowFingerprint(pid: target.pid, title: target.title, frame: frame),
                candidates: CGWindowInventory.current())
        }
        target.revisionRegistration = AXRevisionRegistration(
            pid: target.pid, bundleID: target.bundleID, window: target.element)
        targets[target.id] = target
        return ["targetId": target.id, "generation": target.generation,
                "revision": target.revision, "appId": target.bundleID, "title": target.title]
    }

    public func release(targetID: String) throws {
        guard let target = targets.removeValue(forKey: targetID) else {
            throw NativeError.denied(code: "STALE_TARGET", message: "Target no longer exists")
        }
        target.revisionRegistration?.stop()
        releaseAppMode(pid: target.pid)
    }

    public func target(id: String, generation: Int) throws -> BoundTarget {
        try DesktopPermissions.requireAccessibility()
        guard let target = targets[id], target.generation == generation else {
            throw NativeError.denied(code: "STALE_TARGET", message: "Target generation is stale")
        }
        guard !ProtectedTargets.contains(bundleID: target.bundleID, executablePath: target.executablePath) else {
            throw NativeError.denied(code: "TARGET_FORBIDDEN", message: "Protected application")
        }
        // AppKit can remove a minimized window from AXWindows while its AX
        // element is still alive. Keep that target bound so screenshot can
        // report TARGET_NOT_VISIBLE and the same target can recover when the
        // person restores the window. A closed window has no readable role or
        // minimized attribute and still becomes stale below.
        let addressableMinimizedWindow = Self.minimizedWindowStillAddressable(
            target.element, pid: target.pid)
        guard Self.runningApp(pid: target.pid, bundleID: target.bundleID,
                              executablePath: target.executablePath) != nil else {
            HelperDiagnostic.emit("TARGET_INVALIDATED", ["reason": "app-exited"])
            targets.removeValue(forKey: id)?.revisionRegistration?.stop()
            releaseAppMode(pid: target.pid)
            pendingEvents.append(["type": "event", "name": "target.lost",
                                  "data": ["targetId": id, "reason": "Window identity changed"]])
            throw NativeError.denied(code: "STALE_TARGET", message: "Window identity changed")
        }
        // A window the user moved to another Space, or that an app briefly
        // drops from AXWindows while switching Spaces, keeps a live AX
        // element; only a closed window loses it (reading its role fails).
        let inAXWindows = try addressableMinimizedWindow ||
            Self.windowStillExists(target.element, pid: target.pid) ||
            Self.windowElementAlive(target.element, pid: target.pid)
        // macOS 26 can omit a live window from AXWindows when it moves to
        // another Space. Keep the existing target only when its original CG
        // window ID remains a unique match for the bound pid/title/frame.
        let offSpaceWindow: Bool
        if !inAXWindows, let windowID = target.cgWindowID, let frame = target.frame {
            offSpaceWindow = WindowMatcher.matchesBoundWindow(
                id: windowID,
                ax: WindowFingerprint(pid: target.pid, title: target.title, frame: frame),
                candidates: CGWindowInventory.current())
        } else {
            offSpaceWindow = false
        }
        guard inAXWindows || offSpaceWindow else {
            HelperDiagnostic.emit("TARGET_INVALIDATED", ["reason": "window-missing"])
            targets.removeValue(forKey: id)?.revisionRegistration?.stop()
            releaseAppMode(pid: target.pid)
            pendingEvents.append(["type": "event", "name": "target.lost",
                                  "data": ["targetId": id, "reason": "Window identity changed"]])
            throw NativeError.denied(code: "STALE_TARGET", message: "Window identity changed")
        }
        consumeRevisionChanges(target)
        let displaySignature = Self.displaySignature()
        if displaySignature != target.displaySignature {
            HelperDiagnostic.emit("TARGET_INVALIDATED", ["reason": "display-changed"])
            target.displaySignature = displaySignature
            target.generation += 1
            markChanged(target)
            throw NativeError.denied(code: "STALE_TARGET", message: "Display configuration changed")
        }
        // Off the current Space an app may not report its frame or title;
        // keep the last known ones rather than mistaking that for a change.
        let currentFrame = offSpaceWindow ? target.frame : (Self.frame(target.element) ?? target.frame)
        if currentFrame != target.frame {
            HelperDiagnostic.emit("TARGET_INVALIDATED", ["reason": "geometry-changed"])
            target.frame = currentFrame
            target.generation += 1
            markChanged(target)
            throw NativeError.denied(code: "STALE_TARGET", message: "Window geometry changed")
        }
        let readTitle = Self.text(target.element, "AXTitle")
        let title = offSpaceWindow || readTitle.isEmpty ? target.title : readTitle
        if title != target.title {
            target.title = String(title.prefix(1_024))
            markChanged(target)
        }
        return target
    }

    public static func axWindows(_ application: AXUIElement) throws -> [AXUIElement] {
        var value: CFTypeRef?
        let status = AXUIElementCopyAttributeValue(application, "AXWindows" as CFString, &value)
        if status == .noValue { return [] }
        guard status == .success, let windows = value as? [AXUIElement] else {
            throw NativeError.denied(code: "DRIVER_UNAVAILABLE", message: "Cannot inspect application windows")
        }
        return windows
    }

    public static func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
        return value
    }

    public static func text(_ element: AXUIElement, _ name: String) -> String {
        attribute(element, name) as? String ?? ""
    }

    public static func bool(_ element: AXUIElement, _ name: String) -> Bool {
        attribute(element, name) as? Bool ?? false
    }

    public static func frame(_ element: AXUIElement) -> Rect? {
        guard let rawPosition = attribute(element, "AXPosition"),
              let rawSize = attribute(element, "AXSize"),
              CFGetTypeID(rawPosition) == AXValueGetTypeID(),
              CFGetTypeID(rawSize) == AXValueGetTypeID() else { return nil }
        let positionValue = unsafeDowncast(rawPosition, to: AXValue.self)
        let sizeValue = unsafeDowncast(rawSize, to: AXValue.self)
        var point = CGPoint.zero, size = CGSize.zero
        guard AXValueGetValue(positionValue, .cgPoint, &point), AXValueGetValue(sizeValue, .cgSize, &size),
              [point.x, point.y, size.width, size.height].allSatisfy(\.isFinite),
              size.width >= 0, size.height >= 0 else { return nil }
        return Rect(x: point.x, y: point.y, width: size.width, height: size.height)
    }

    private static func runningApp(pid: pid_t, bundleID: String, executablePath: String?) -> NSRunningApplication? {
        guard let app = NSRunningApplication(processIdentifier: pid),
              app.bundleIdentifier == bundleID,
              app.activationPolicy == .regular,
              app.executableURL?.standardizedFileURL.path == executablePath else { return nil }
        return app
    }

    private static func windowStillExists(_ element: AXUIElement, pid: pid_t) throws -> Bool {
        let application = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(application, 0.5)
        return try axWindows(application).contains { CFEqual($0, element) }
    }

    private static func windowElementAlive(_ element: AXUIElement, pid: pid_t) -> Bool {
        var actualPID: pid_t = 0
        return AXUIElementGetPid(element, &actualPID) == .success && actualPID == pid &&
            text(element, "AXRole") == "AXWindow"
    }

    private static func minimizedWindowStillAddressable(_ element: AXUIElement, pid: pid_t) -> Bool {
        var actualPID: pid_t = 0
        return AXUIElementGetPid(element, &actualPID) == .success && actualPID == pid &&
            text(element, "AXRole") == "AXWindow" && bool(element, "AXMinimized")
    }

    public static func displaySignature() -> String {
        var displays = [CGDirectDisplayID](repeating: 0, count: 32)
        var count: UInt32 = 0
        guard CGGetActiveDisplayList(UInt32(displays.count), &displays, &count) == .success else {
            return "unavailable"
        }
        return displays.prefix(Int(count)).sorted().map { id in
            let bounds = CGDisplayBounds(id)
            guard let mode = CGDisplayCopyDisplayMode(id) else { return "\(id):missing" }
            return "\(id):\(bounds.minX),\(bounds.minY),\(bounds.width),\(bounds.height):" +
                   "\(mode.width),\(mode.height),\(mode.pixelWidth),\(mode.pixelHeight)"
        }.joined(separator: "|")
    }

    static func enableKnownAppMode(read: () -> Any?, write: (Bool) -> Bool,
                                   diagnose: (String) -> Void = { _ in }) -> Bool? {
        guard let original = read() as? Bool else {
            diagnose("original-unreadable")
            return nil
        }
        // Chrome treats AXEnhancedUserInterface writes as counted requests.
        // A second true write followed by another true does not release ours.
        // The same no-op rule avoids modifying an Electron app that is already
        // exposing its accessibility tree.
        guard !original else {
            diagnose("already-enabled")
            return nil
        }
        // Chrome applies AXEnhancedUserInterface yet reports
        // kAXErrorNotImplemented (-25208) for every write. A value that now
        // reads as set is ours to restore, whatever the status said; trusting
        // the status alone left Chrome's mode on after release.
        guard write(true) || (read() as? Bool) == true else {
            diagnose("write-failed")
            return nil
        }
        return original
    }

    private func enableAppModeIfNeeded(pid: pid_t, bundleID: String) {
        if var existing = appModes[pid] {
            existing.references += 1
            appModes[pid] = existing
            return
        }
        guard let attribute = Self.chromiumModeAttribute(pid: pid, bundleID: bundleID) else { return }
        let application = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(application, 0.5)
        guard let original = Self.enableKnownAppMode(
            read: { Self.attribute(application, attribute) },
            write: { enabled in
                AXUIElementSetAttributeValue(application, attribute as CFString,
                                             NSNumber(value: enabled)) == .success
            }, diagnose: { reason in
                HelperDiagnostic.emit("APP_MODE", ["event": "unchanged", "pid": String(pid),
                                                   "attribute": attribute, "reason": reason])
            }) else {
            return
        }
        HelperDiagnostic.emit("APP_MODE", ["event": "enabled", "pid": String(pid),
                                           "attribute": attribute, "original": String(original)])
        appModes[pid] = AXAppMode(pid: pid, application: application, attribute: attribute,
                                 original: original, references: 1)
    }

    /// The attribute that makes a Chromium-based app expose its web content:
    /// AXEnhancedUserInterface for Chrome and Edge, AXManualAccessibility for
    /// Electron apps; nil for everything else.
    static func chromiumModeAttribute(pid: pid_t, bundleID: String) -> String? {
        if bundleID == "com.google.Chrome" || bundleID == "com.microsoft.edgemac" {
            return "AXEnhancedUserInterface"
        }
        guard let bundle = NSRunningApplication(processIdentifier: pid)?.bundleURL,
              FileManager.default.fileExists(atPath: bundle.appendingPathComponent(
                "Contents/Frameworks/Electron Framework.framework").path) else { return nil }
        return "AXManualAccessibility"
    }

    private func releaseAppMode(pid: pid_t) {
        guard var mode = appModes[pid] else { return }
        mode.references -= 1
        if mode.references > 0 {
            appModes[pid] = mode
        } else {
            appModes.removeValue(forKey: pid)
            restore(mode)
        }
    }

    private func restore(_ mode: AXAppMode) {
        let written = AXUIElementSetAttributeValue(mode.application, mode.attribute as CFString,
                                                    NSNumber(value: mode.original)) == .success
        let observed = Self.attribute(mode.application, mode.attribute) as? Bool
        HelperDiagnostic.emit("APP_MODE", ["event": "restored", "pid": String(mode.pid),
                                           "attribute": mode.attribute,
                                           "writeSucceeded": String(written),
                                           "matchesOriginal": String(observed == mode.original)])
    }
}
