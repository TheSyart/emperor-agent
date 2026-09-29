import Foundation

/// The identity obtained from the live target process, never from a model or
/// an AX attribute. Ad hoc signatures have no Team ID and use the weaker path
/// binding required for development builds.
public enum AppCodeSignature: Equatable {
    case signed(bundleID: String, teamID: String, executablePath: String)
    case unsigned(bundleID: String, executablePath: String)
}

public struct AppCredentialBinding: Equatable {
    public let bundleID: String
    public let teamID: String?
    public let path: String?

    public init(bundleID: String, teamID: String?, path: String?) {
        self.bundleID = bundleID
        self.teamID = teamID
        self.path = path
    }
}

public enum AppBindingPolicy {
    public static func matches(signature: AppCodeSignature, expected: AppCredentialBinding) -> Bool {
        switch signature {
        case .signed(let bundleID, let teamID, let path):
            return !bundleID.isEmpty && !teamID.isEmpty && !path.isEmpty &&
                expected.bundleID == bundleID && expected.teamID == teamID &&
                (expected.path == nil || expected.path == path)
        case .unsigned(let bundleID, let path):
            return !bundleID.isEmpty && !path.isEmpty &&
                expected.bundleID == bundleID && expected.teamID == nil && expected.path == path
        }
    }
}

public enum SecretFieldPolicy {
    public static func accepts(field: String, role: String, subrole: String) -> Bool {
        let secure = role == "AXSecureTextField" || subrole == "AXSecureTextField"
        let text = role == "AXTextField" || role == "AXTextArea" || secure
        switch field {
        case "username": return text && !secure
        case "password": return secure
        case "totp": return text
        default: return false
        }
    }
}
