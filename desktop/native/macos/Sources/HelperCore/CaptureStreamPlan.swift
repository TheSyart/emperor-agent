import Foundation

/// Pure rules for the low-rate stream kept on each agent-controlled window
/// (E-M16): macOS badges a streamed window and lists the helper as sharing,
/// which shows the user which window is controlled and lets them stop it.
public enum CaptureStreamPlan {
    public static let framesPerSecond = 2
    public static let maxEdge = 640

    /// Frame size with the longest edge at most `maxEdge`, even and at least 2.
    public static func size(width: Double, height: Double, maxEdge: Int = maxEdge) -> (width: Int, height: Int) {
        guard width.isFinite, height.isFinite, width > 0, height > 0 else { return (2, 2) }
        let scale = min(1, Double(maxEdge) / max(width, height))
        func even(_ value: Double) -> Int { max(2, Int((value * scale / 2).rounded(.down)) * 2) }
        return (even(width), even(height))
    }

    /// Seconds to wait before the next start after `failures` failed starts.
    public static func retryDelay(failures: Int) -> Int {
        guard failures > 0 else { return 0 }
        return min(30, 1 << min(failures, 5))
    }

    /// `SCStreamError.userStopped` (-3817) is the menu-bar "Stop Sharing".
    public static func stopReason(domain: String, code: Int) -> String {
        domain == "com.apple.ScreenCaptureKit.SCStreamErrorDomain" && code == -3817 ? "user" : "error"
    }
}
