import AppKit
import Foundation
import HelperCore
import Security

/// Re-reads the live process signature immediately before a credential fill.
/// A bundle identifier by itself is never accepted as a credential binding.
public enum AppCodeIdentity {
    public static func inspect(pid: pid_t, bundleID: String, executablePath: String?) throws -> AppCodeSignature {
        guard let app = NSRunningApplication(processIdentifier: pid),
              app.activationPolicy == .regular,
              app.bundleIdentifier == bundleID,
              let path = app.executableURL?.standardizedFileURL.path,
              path == executablePath,
              !ProtectedTargets.contains(bundleID: bundleID, executablePath: path) else {
            throw NativeError.denied(code: "STALE_TARGET", message: "Application identity changed")
        }
        var code: SecCode?
        let attributes = [kSecGuestAttributePid as String: NSNumber(value: pid)] as CFDictionary
        let guestStatus = SecCodeCopyGuestWithAttributes(nil, attributes, [], &code)
        if guestStatus == errSecCSUnsigned {
            return .unsigned(bundleID: bundleID, executablePath: path)
        }
        guard guestStatus == errSecSuccess, let code,
              SecCodeCheckValidity(code, [], nil) == errSecSuccess else {
            throw NativeError.denied(code: "PERMISSION_DENIED", message: "Application code signature is invalid")
        }
        var staticCode: SecStaticCode?
        guard SecCodeCopyStaticCode(code, [], &staticCode) == errSecSuccess,
              let staticCode else {
            throw NativeError.denied(code: "PERMISSION_DENIED", message: "Application static code is unavailable")
        }
        var details: CFDictionary?
        guard SecCodeCopySigningInformation(staticCode,
                SecCSFlags(rawValue: kSecCSSigningInformation), &details) == errSecSuccess,
              let info = details as? [String: Any],
              let flags = info[kSecCodeInfoFlags as String] as? NSNumber else {
            throw NativeError.denied(code: "PERMISSION_DENIED", message: "Application signature cannot be inspected")
        }
        if flags.uint32Value & 0x2 != 0 {
            return .unsigned(bundleID: bundleID, executablePath: path)
        }
        guard let signedBundleID = info[kSecCodeInfoIdentifier as String] as? String,
              signedBundleID == bundleID,
              let teamID = info[kSecCodeInfoTeamIdentifier as String] as? String,
              !teamID.isEmpty else {
            throw NativeError.denied(code: "PERMISSION_DENIED", message: "Signed application identity does not match")
        }
        return .signed(bundleID: signedBundleID, teamID: teamID, executablePath: path)
    }

    public static func verify(pid: pid_t, bundleID: String, executablePath: String?,
                              binding: AppCredentialBinding) throws {
        let identity = try inspect(pid: pid, bundleID: bundleID, executablePath: executablePath)
        guard AppBindingPolicy.matches(signature: identity, expected: binding) else {
            throw NativeError.denied(code: "PERMISSION_DENIED", message: "Credential binding does not match")
        }
    }
}
