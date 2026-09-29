import CoreGraphics
import Foundation
import HelperCore

/// Orders synthetic down events and emergency releases on one lock. In
/// particular, cancel must never post an up event before a concurrent down.
final class HeldInputGate: @unchecked Sendable {
    private let lock = NSLock()
    private var keysDown = Set<CGKeyCode>()
    private var mouseDown: CGMouseButton?
    private var cancelled = false

    func begin() {
        lock.lock(); cancelled = false; lock.unlock()
    }

    func checkCancellation() throws {
        lock.lock(); let stopped = cancelled; lock.unlock()
        if stopped { throw NativeError.denied(code: "USER_TAKEOVER", message: "Action cancelled") }
    }

    func postKeyDown(_ key: CGKeyCode, post: () -> Void) throws {
        lock.lock(); defer { lock.unlock() }
        try requireRunning()
        post()
        keysDown.insert(key)
    }

    /// Posts events that are never left held (a down/up pair sent to one
    /// process). Refused once cancelled, so nothing is sent after a stop.
    func postUnheld(_ post: () -> Void) throws {
        lock.lock(); defer { lock.unlock() }
        try requireRunning()
        post()
    }

    func finishKey(_ key: CGKeyCode) {
        lock.lock(); keysDown.remove(key); lock.unlock()
    }

    func postMouseDown(_ button: CGMouseButton, post: () -> Void) throws {
        lock.lock(); defer { lock.unlock() }
        try requireRunning()
        post()
        mouseDown = button
    }

    func finishMouse() {
        lock.lock(); mouseDown = nil; lock.unlock()
    }

    func cancel(keyUp: (CGKeyCode) -> Void, mouseUp: (CGMouseButton) -> Void) {
        lock.lock(); defer { lock.unlock() }
        cancelled = true
        releaseLocked(keyUp: keyUp, mouseUp: mouseUp)
    }

    func releaseAll(keyUp: (CGKeyCode) -> Void, mouseUp: (CGMouseButton) -> Void) {
        lock.lock(); defer { lock.unlock() }
        releaseLocked(keyUp: keyUp, mouseUp: mouseUp)
    }

    private func requireRunning() throws {
        if cancelled { throw NativeError.denied(code: "USER_TAKEOVER", message: "Action cancelled") }
    }

    private func releaseLocked(keyUp: (CGKeyCode) -> Void, mouseUp: (CGMouseButton) -> Void) {
        for key in keysDown { keyUp(key) }
        keysDown.removeAll()
        if let button = mouseDown { mouseUp(button) }
        mouseDown = nil
    }
}
