import Foundation

public struct WindowFingerprint: Equatable {
    public let pid: Int32
    public let title: String
    public let frame: Rect
    public init(pid: Int32, title: String, frame: Rect) {
        self.pid = pid; self.title = title; self.frame = frame
    }
}

public struct ScreenshotWindow: Equatable {
    public let id: UInt32
    public let pid: Int32
    public let title: String
    public let frame: Rect
    public init(id: UInt32, pid: Int32, title: String, frame: Rect) {
        self.id = id; self.pid = pid; self.title = title; self.frame = frame
    }
}

public enum WindowMatcher {
    /// Public APIs expose no AX-to-CGWindowID bridge. Never guess if the
    /// pid/title/frame tuple yields zero or multiple screenshot windows.
    public static func uniqueMatch(ax: WindowFingerprint, candidates: [ScreenshotWindow]) -> UInt32? {
        let matches = candidates.filter { candidate in
            candidate.pid == ax.pid && candidate.title == ax.title &&
            abs(candidate.frame.x - ax.frame.x) <= 1 &&
            abs(candidate.frame.y - ax.frame.y) <= 1 &&
            abs(candidate.frame.width - ax.frame.width) <= 1 &&
            abs(candidate.frame.height - ax.frame.height) <= 1
        }
        return matches.count == 1 ? matches[0].id : nil
    }


    /// The window to capture: the one CoreGraphics tied to this pid, title
    /// and frame at bind time, while it still does uniquely; otherwise the
    /// unique match among ScreenCaptureKit's own windows, whose frames can
    /// differ from CoreGraphics' by a few points.
    public static func screenshotWindowID(ax: WindowFingerprint, boundID: UInt32?,
                                          cgCandidates: [ScreenshotWindow],
                                          scCandidates: [ScreenshotWindow]) -> UInt32? {
        if let boundID, matchesBoundWindow(id: boundID, ax: ax, candidates: cgCandidates) {
            return boundID
        }
        return uniqueMatch(ax: ax, candidates: scCandidates)
    }

    /// When AXWindows omits an off-Space window, retain a bound target only
    /// while the original CG window ID still matches the same unique window.
    public static func matchesBoundWindow(id: UInt32, ax: WindowFingerprint,
                                          candidates: [ScreenshotWindow]) -> Bool {
        uniqueMatch(ax: ax, candidates: candidates) == id
    }
}
