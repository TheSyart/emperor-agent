import AppKit
import Carbon
import CoreGraphics
import Foundation
import HelperCore

/// Tracks every synthetic down event. The socket's cancel, timeout and
/// disconnect paths all call releaseAll; each compound action also defers it.
public final class InputController: @unchecked Sendable {
    public static let shared = InputController()
    private let gate = HeldInputGate()
    private let probeLock = NSLock()
    private var cancellationProbe: (() -> Void)?
    private let source = CGEventSource(stateID: .privateState)

    private init() {}

    public func begin() {
        gate.begin()
    }

    public func setCancellationProbe(_ probe: (() -> Void)?) {
        probeLock.lock(); cancellationProbe = probe; probeLock.unlock()
    }

    public func cancel() {
        gate.cancel(keyUp: postKeyUp, mouseUp: postMouseUp)
    }

    public func checkCancellation() throws {
        probeLock.lock(); let probe = cancellationProbe; probeLock.unlock()
        probe?()
        try gate.checkCancellation()
    }

    public func releaseAll() {
        gate.releaseAll(keyUp: postKeyUp, mouseUp: postMouseUp)
    }

    /// After main restarted a crashed helper (00 §12): also release keys and
    /// mouse buttons the session still reports as held, since this process
    /// never saw their down events.
    public func releaseAllAfterCrash() {
        releaseAll()
        let held = RecoveryRelease.stuckKeys(KeyMapper.recoveryKeys) { key in
            CGEventSource.keyState(.combinedSessionState, key: CGKeyCode(key))
        }
        for key in held { postKeyUp(CGKeyCode(key)) }
        for button in [CGMouseButton.left, .right, .center]
        where CGEventSource.buttonState(.combinedSessionState, button: button) {
            postMouseUp(button)
        }
    }

    private func postKeyUp(_ key: CGKeyCode) {
        CGEvent(keyboardEventSource: source, virtualKey: key, keyDown: false)?.post(tap: .cghidEventTap)
    }

    private func postMouseUp(_ button: CGMouseButton) {
        let kind: CGEventType = button == .right ? .rightMouseUp :
            (button == .center ? .otherMouseUp : .leftMouseUp)
        let location = CGEvent(source: source)?.location ?? .zero
        CGEvent(mouseEventSource: source, mouseType: kind,
                mouseCursorPosition: location, mouseButton: button)?.post(tap: .cghidEventTap)
    }

    public func press(_ chord: KeyChord) throws {
        try checkCancellation()
        try Self.requireKeyboardAvailable()
        let flags = Self.flags(chord.modifiers)
        guard let down = CGEvent(keyboardEventSource: source, virtualKey: chord.virtualKey, keyDown: true),
              let up = CGEvent(keyboardEventSource: source, virtualKey: chord.virtualKey, keyDown: false) else {
            throw NativeError.denied(code: "DRIVER_UNAVAILABLE", message: "Cannot synthesize key")
        }
        down.flags = flags
        up.flags = flags
        Self.attachText(chord.text, to: down, up)
        try gate.postKeyDown(chord.virtualKey) { down.post(tap: .cghidEventTap) }
        defer { releaseAll() }
        up.post(tap: .cghidEventTap)
        gate.finishKey(chord.virtualKey)
    }

    public func typeUnicode(_ text: String) throws {
        try Self.requireKeyboardAvailable()
        let previous = TISCopyCurrentKeyboardInputSource()?.takeRetainedValue()
        guard let ascii = TISCopyCurrentASCIICapableKeyboardInputSource()?.takeRetainedValue(),
              TISSelectInputSource(ascii) == noErr else {
            throw NativeError.denied(code: "DRIVER_UNAVAILABLE", message: "Cannot select ASCII input source")
        }
        defer { if let previous { _ = TISSelectInputSource(previous) }; releaseAll() }
        for chunk in Self.unicodeChunks(text) {
            try checkCancellation()
            try Self.requireKeyboardAvailable()
            guard let down = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true),
                  let up = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false) else {
                throw NativeError.denied(code: "DRIVER_UNAVAILABLE", message: "Cannot synthesize text")
            }
            chunk.withUnsafeBufferPointer { pointer in
                down.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: pointer.baseAddress!)
                up.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: pointer.baseAddress!)
            }
            down.flags = []
            up.flags = []
            try gate.postKeyDown(0) { down.post(tap: .cghidEventTap) }
            up.post(tap: .cghidEventTap)
            gate.finishKey(0)
        }
    }

    // Background delivery (E-M6b): events go to one process with postToPid,
    // so the target need not be frontmost, the user's own keyboard, pointer
    // and input source stay untouched, and no other app can receive them.
    // Each key goes down and up inside one gate call, so nothing is ever left
    // held and releaseAll has nothing of these to release; a stop refuses the
    // next pair.

    public func typeUnicode(_ text: String, toProcess pid: pid_t) throws {
        for chunk in Self.unicodeChunks(text) {
            try checkCancellation()
            guard let down = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true),
                  let up = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false) else {
                throw NativeError.denied(code: "DRIVER_UNAVAILABLE", message: "Cannot synthesize text")
            }
            chunk.withUnsafeBufferPointer { pointer in
                down.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: pointer.baseAddress!)
                up.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: pointer.baseAddress!)
            }
            down.flags = []
            up.flags = []
            try gate.postUnheld {
                down.postToPid(pid)
                up.postToPid(pid)
            }
            Thread.sleep(forTimeInterval: 0.005)
        }
    }

    public func press(_ chord: KeyChord, toProcess pid: pid_t) throws {
        try checkCancellation()
        let flags = Self.flags(chord.modifiers)
        guard let down = CGEvent(keyboardEventSource: source, virtualKey: chord.virtualKey, keyDown: true),
              let up = CGEvent(keyboardEventSource: source, virtualKey: chord.virtualKey, keyDown: false) else {
            throw NativeError.denied(code: "DRIVER_UNAVAILABLE", message: "Cannot synthesize key")
        }
        down.flags = flags
        up.flags = flags
        Self.attachText(chord.text, to: down, up)
        try gate.postUnheld {
            down.postToPid(pid)
            up.postToPid(pid)
        }
    }

    /// A printable key carries the character it types, so the app receives
    /// exactly that character whatever input source is active (E-M6c).
    private static func attachText(_ text: String?, to down: CGEvent, _ up: CGEvent) {
        guard let text else { return }
        let units = Array(text.utf16)
        units.withUnsafeBufferPointer { pointer in
            down.keyboardSetUnicodeString(stringLength: units.count, unicodeString: pointer.baseAddress!)
            up.keyboardSetUnicodeString(stringLength: units.count, unicodeString: pointer.baseAddress!)
        }
    }

    /// Text as key events of at most 20 UTF-16 units. A control character
    /// (a line break, a tab) travels alone: AppKit reads an event that starts
    /// with one as that single command and drops the rest of its text.
    static func unicodeChunks(_ text: String) -> [[UInt16]] {
        let units = Array(text.replacingOccurrences(of: "\r\n", with: "\n").utf16)
        var chunks: [[UInt16]] = []
        var run: [UInt16] = []
        func flush() {
            var offset = 0
            while offset < run.count {
                var end = min(offset + 20, run.count)
                if end < run.count && (0xD800...0xDBFF).contains(run[end - 1]) { end -= 1 }
                chunks.append(Array(run[offset..<end]))
                offset = end
            }
            run.removeAll()
        }
        for unit in units {
            if unit < 0x20 || unit == 0x7F {
                flush()
                chunks.append([unit])
            } else {
                run.append(unit)
            }
        }
        flush()
        return chunks
    }

    public func click(point: CGPoint, button: CGMouseButton = .left, count: Int = 1) throws {
        try checkCancellation()
        let (downKind, upKind): (CGEventType, CGEventType) = button == .right ?
            (.rightMouseDown, .rightMouseUp) : button == .center ?
            (.otherMouseDown, .otherMouseUp) : (.leftMouseDown, .leftMouseUp)
        for clickNumber in 1...count {
            guard let down = CGEvent(mouseEventSource: source, mouseType: downKind,
                                     mouseCursorPosition: point, mouseButton: button),
                  let up = CGEvent(mouseEventSource: source, mouseType: upKind,
                                   mouseCursorPosition: point, mouseButton: button) else {
                throw NativeError.denied(code: "DRIVER_UNAVAILABLE", message: "Cannot synthesize mouse event")
            }
            down.setIntegerValueField(.mouseEventClickState, value: Int64(clickNumber))
            up.setIntegerValueField(.mouseEventClickState, value: Int64(clickNumber))
            try gate.postMouseDown(button) { down.post(tap: .cghidEventTap) }
            defer { releaseAll() }
            up.post(tap: .cghidEventTap)
            gate.finishMouse()
        }
    }

    public func drag(from start: CGPoint, to end: CGPoint) throws {
        try checkCancellation()
        guard let down = CGEvent(mouseEventSource: source, mouseType: .leftMouseDown,
                                 mouseCursorPosition: start, mouseButton: .left) else {
            throw NativeError.denied(code: "DRIVER_UNAVAILABLE", message: "Cannot start drag")
        }
        try gate.postMouseDown(.left) { down.post(tap: .cghidEventTap) }
        defer { releaseAll() }
        for step in 1...10 {
            try checkCancellation()
            let ratio = CGFloat(step) / 10
            let point = CGPoint(x: start.x + (end.x - start.x) * ratio,
                                y: start.y + (end.y - start.y) * ratio)
            CGEvent(mouseEventSource: source, mouseType: .leftMouseDragged,
                    mouseCursorPosition: point, mouseButton: .left)?.post(tap: .cghidEventTap)
            Thread.sleep(forTimeInterval: 0.01)
        }
        CGEvent(mouseEventSource: source, mouseType: .leftMouseUp,
                mouseCursorPosition: end, mouseButton: .left)?.post(tap: .cghidEventTap)
        gate.finishMouse()
    }

    public func scroll(point: CGPoint, vertical: Int32, horizontal: Int32) throws {
        try checkCancellation()
        CGEvent(mouseEventSource: source, mouseType: .mouseMoved,
                mouseCursorPosition: point, mouseButton: .left)?.post(tap: .cghidEventTap)
        guard let event = CGEvent(scrollWheelEvent2Source: source, units: .pixel,
                                  wheelCount: 2, wheel1: vertical, wheel2: horizontal, wheel3: 0) else {
            throw NativeError.denied(code: "DRIVER_UNAVAILABLE", message: "Cannot synthesize scroll")
        }
        event.post(tap: .cghidEventTap)
    }

    public static func requireKeyboardAvailable() throws {
        guard !IsSecureEventInputEnabled() else {
            throw NativeError.denied(code: "SECURE_INPUT_ACTIVE", message: "Secure keyboard input is active")
        }
    }

    private static func flags(_ names: Set<String>) -> CGEventFlags {
        var flags: CGEventFlags = []
        if names.contains("command") { flags.insert(.maskCommand) }
        if names.contains("control") { flags.insert(.maskControl) }
        if names.contains("option") { flags.insert(.maskAlternate) }
        if names.contains("shift") { flags.insert(.maskShift) }
        return flags
    }
}
