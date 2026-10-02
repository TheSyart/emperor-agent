import Foundation

/// An on-screen window, as the virtual pointer needs it (front to back).
public struct ScreenWindow: Equatable {
    public let id: UInt32
    public let pid: Int32
    public let layer: Int
    public let frame: Rect
    public let alpha: Double
    /// Dock's non-rectangular surface may have screen-sized bounds even
    /// where the underlying application remains visible and hit-testable.
    public let dockSurface: Bool

    public init(id: UInt32, pid: Int32, layer: Int, frame: Rect, alpha: Double, dockSurface: Bool = false) {
        self.id = id; self.pid = pid; self.layer = layer; self.frame = frame; self.alpha = alpha
        self.dockSurface = dockSurface
    }
}

/// Whether the user can see where the Agent acts: the frontmost on-screen
/// window at that point is the target window. Emperor's own floating
/// overlays (the pointer, the control bar) do not count; its main window
/// does, because it would hide the target.
public enum PointerVisibility {
    public static func visible(at point: Point, windows frontToBack: [ScreenWindow],
                               targetWindowID: UInt32?, targetPID: Int32, mainPID: Int32?,
                               pointOwnerPID: Int32? = nil) -> Bool {
        for window in frontToBack {
            if window.alpha <= 0.01 { continue }
            if let mainPID, window.pid == mainPID, window.layer != 0 { continue }
            guard contains(window.frame, point) else { continue }
            // Dock reports a screen-sized rectangle with alpha 1 even at
            // clear points. Only a successful system AX hit on another
            // process lets us look through that non-rectangular surface.
            if window.dockSurface, let pointOwnerPID, pointOwnerPID != window.pid { continue }
            if let targetWindowID { return window.id == targetWindowID }
            return window.pid == targetPID
        }
        return false
    }

    static func contains(_ rect: Rect, _ point: Point) -> Bool {
        point.x >= rect.x && point.y >= rect.y &&
            point.x < rect.x + rect.width && point.y < rect.y + rect.height
    }
}

/// The `act.dispatched` pointer: where the action lands (global screen
/// points), whether the user can see it there, where a drag ends, and the
/// target window's frame in the same space, so the conversation preview can
/// place the point on the window's picture even while the window is covered.
/// Main accepts only a positive, finite frame; any other is left out.
public enum PointerPayload {
    public static func make(at point: Point, to end: Point?, visible: Bool, window: Rect?) -> [String: Any] {
        var payload: [String: Any] = ["x": point.x, "y": point.y, "visible": visible]
        if let end { payload["to"] = ["x": end.x, "y": end.y] }
        if let window, usable(window) {
            payload["window"] = ["x": window.x, "y": window.y, "width": window.width, "height": window.height]
        }
        return payload
    }

    static func usable(_ frame: Rect) -> Bool {
        [frame.x, frame.y, frame.width, frame.height].allSatisfy(\.isFinite) &&
            frame.width > 0 && frame.height > 0
    }
}
