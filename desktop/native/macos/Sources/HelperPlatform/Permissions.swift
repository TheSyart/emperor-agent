import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

public enum NativeError: Error {
    case denied(code: String, message: String)

    public var code: String {
        if case .denied(let code, _) = self { return code }
        return "DRIVER_UNAVAILABLE"
    }
    public var message: String {
        if case .denied(_, let message) = self { return message }
        return "Native operation unavailable"
    }
}

public enum DesktopPermissions {
    public static func status() -> [String: String] {
        [
            "accessibility": AXIsProcessTrusted() ? "granted" : "denied",
            "screen-recording": CGPreflightScreenCaptureAccess() ? "granted" : "denied",
        ]
    }

    public static func requireAccessibility() throws {
        guard AXIsProcessTrusted() else {
            throw NativeError.denied(code: "PERMISSION_REQUIRED", message: "Accessibility permission is required")
        }
    }

    public static func requireScreenRecording() throws {
        guard CGPreflightScreenCaptureAccess() else {
            throw NativeError.denied(code: "PERMISSION_REQUIRED", message: "Screen recording permission is required")
        }
    }

    /// Returns whether the System Settings deep link was opened. This does
    /// not mean TCC granted the permission; status must be queried again.
    @MainActor public static func request(_ permission: String) throws -> Bool {
        let link: String
        switch permission {
        case "accessibility":
            let options = ["AXTrustedCheckOptionPrompt": true] as CFDictionary
            _ = AXIsProcessTrustedWithOptions(options)
            link = "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
        case "screen-recording":
            _ = CGRequestScreenCaptureAccess()
            link = "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
        default:
            throw NativeError.denied(code: "INVALID_REQUEST", message: "Unknown permission")
        }
        guard let url = URL(string: link) else { return false }
        return NSWorkspace.shared.open(url)
    }
}
