import Foundation

/// An on-screen window, as the virtual pointer needs it (front to back).
public struct ScreenWindow: Equatable {
    public let id: UInt32
    public let pid: Int32
    public let layer: Int
    public let frame: Rect
    public let alpha: Double

    public init(id: UInt32, pid: Int32, layer: Int, frame: Rect, alpha: Double) {
        self.id = id; self.pid = pid; self.layer = layer; self.frame = frame; self.alpha = alpha
    }
}

/// Whether the user can see where the Agent acts: the frontmost on-screen
/// window at that point is the target window. Emperor's own floating
/// overlays (the pointer, the control bar) do not count; its main window
/// does, because it would hide the target.
public enum PointerVisibility {
    public static func visible(at point: Point, windows frontToBack: [ScreenWindow],
                               targetWindowID: UInt32?, targetPID: Int32, mainPID: Int32?) -> Bool {
        for window in frontToBack {
            if window.alpha <= 0.01 { continue }
            if let mainPID, window.pid == mainPID, window.layer != 0 { continue }
            guard contains(window.frame, point) else { continue }
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
