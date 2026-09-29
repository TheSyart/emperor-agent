import ApplicationServices
import Foundation

private func revisionCallback(
    _ observer: AXObserver, _ element: AXUIElement,
    _ notification: CFString, _ refcon: UnsafeMutableRawPointer?
) {
    guard let refcon else { return }
    Unmanaged<AXRevisionRegistration>.fromOpaque(refcon).takeUnretainedValue()
        .note(notification: notification as String, element: element)
}

/// Where a notification's element sits relative to the bound window.
enum RevisionNotificationScope: Equatable {
    case boundWindow
    /// Another window of the same app, or an element inside one.
    case otherWindow
    /// Not determinable (a destroyed element, or no AXWindow); counted as bound.
    case unknown
}

enum RevisionNotificationImpact: Equatable {
    case semantic
    case screenshotOnly

    static func classify(bundleID: String, notification: String, role: String?,
                         scope: RevisionNotificationScope = .unknown,
                         focusUnchanged: Bool = false) -> Self {
        // App activation re-announces the same focused element. The element
        // tree is unchanged; only pixels (title bar, caret) are.
        if notification == "AXFocusedUIElementChanged", focusUnchanged {
            return .screenshotOnly
        }
        // Other windows cannot change the bound window's elements. Terminal,
        // for one, recreates a hidden window on every activation. Keyboard
        // and pointer preflights still check focus and hit targets.
        if scope == .otherWindow {
            return .screenshotOnly
        }
        // Finder emits AXImage value changes while its icon nodes are read.
        // SemanticObserver does not include image pixel values. The change
        // invalidates old pixels, but does not alter semantic element identity.
        if bundleID == "com.apple.finder", notification == "AXValueChanged",
           role == "AXImage" {
            return .screenshotOnly
        }
        return .semantic
    }
}

struct AXRevisionChanges {
    let semantic: Bool
    let screenshotOnly: Bool
}

/// AX callbacks run on a dedicated CFRunLoop. They only flip a locked flag;
/// the socket loop owns the revision counter and sends events on its thread.
public final class AXRevisionRegistration: @unchecked Sendable {
    private let lock = NSLock()
    private var changed = false
    private var screenshotChanged = false
    private var stopped = false
    private let pid: pid_t
    private let bundleID: String
    private let window: AXUIElement
    // Touched only on the observer thread (callbacks and `run`).
    private var lastFocused: CFTypeRef?
    private var otherWindows: [AXUIElement] = []

    public init(pid: pid_t, bundleID: String, window: AXUIElement) {
        self.pid = pid
        self.bundleID = bundleID
        self.window = window
        Thread { [self] in run() }.start()
    }

    func note(notification: String, element: AXUIElement) {
        let role = Self.attribute(element, "AXRole") as? String
        let scope = scope(of: element, role: role, notification: notification)
        var focusUnchanged = false
        if notification == "AXFocusedUIElementChanged" {
            let focused = Self.attribute(AXUIElementCreateApplication(pid), "AXFocusedUIElement")
            focusUnchanged = focused != nil && lastFocused != nil && CFEqual(focused, lastFocused)
            lastFocused = focused
        }
        let impact = RevisionNotificationImpact.classify(
            bundleID: bundleID, notification: notification, role: role,
            scope: scope, focusUnchanged: focusUnchanged)
        lock.lock()
        if impact == .screenshotOnly { screenshotChanged = true }
        else { changed = true }
        lock.unlock()
    }

    /// A destroyed element has no attributes left, so windows seen being
    /// created elsewhere are remembered to recognise their destruction.
    private func scope(of element: AXUIElement, role: String?,
                       notification: String) -> RevisionNotificationScope {
        if CFEqual(element, window) { return .boundWindow }
        if notification == "AXUIElementDestroyed" {
            guard let index = otherWindows.firstIndex(where: { CFEqual($0, element) }) else { return .unknown }
            otherWindows.remove(at: index)
            return .otherWindow
        }
        if role == "AXWindow" {
            if notification == "AXCreated" {
                if otherWindows.count >= 64 { otherWindows.removeFirst() }
                otherWindows.append(element)
            }
            return .otherWindow
        }
        guard let owner = Self.attribute(element, "AXWindow"),
              CFGetTypeID(owner) == AXUIElementGetTypeID() else { return .unknown }
        return CFEqual(owner, window) ? .boundWindow : .otherWindow
    }

    private static func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
        var value: CFTypeRef?
        return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
    }

    func takeChanges() -> AXRevisionChanges {
        lock.lock()
        defer { lock.unlock() }
        let value = AXRevisionChanges(semantic: changed, screenshotOnly: screenshotChanged)
        changed = false
        screenshotChanged = false
        return value
    }

    public func stop() {
        lock.lock()
        stopped = true
        lock.unlock()
    }

    private func shouldStop() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return stopped
    }

    private func run() {
        var observer: AXObserver?
        guard AXObserverCreate(pid, revisionCallback, &observer) == .success,
              let observer else { return }
        let application = AXUIElementCreateApplication(pid)
        lastFocused = Self.attribute(application, "AXFocusedUIElement")
        let context = Unmanaged.passUnretained(self).toOpaque()
        let notifications = [
            "AXValueChanged", "AXFocusedUIElementChanged", "AXUIElementDestroyed",
            "AXWindowMoved", "AXWindowResized", "AXTitleChanged", "AXCreated",
        ]
        for name in notifications {
            _ = AXObserverAddNotification(observer, window, name as CFString, context)
            _ = AXObserverAddNotification(observer, application, name as CFString, context)
        }
        let source = AXObserverGetRunLoopSource(observer)
        CFRunLoopAddSource(CFRunLoopGetCurrent(), source, .defaultMode)
        while !shouldStop() {
            _ = CFRunLoopRunInMode(.defaultMode, 0.1, true)
        }
        CFRunLoopRemoveSource(CFRunLoopGetCurrent(), source, .defaultMode)
        for name in notifications {
            _ = AXObserverRemoveNotification(observer, window, name as CFString)
            _ = AXObserverRemoveNotification(observer, application, name as CFString)
        }
    }
}
