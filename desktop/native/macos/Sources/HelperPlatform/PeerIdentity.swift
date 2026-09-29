import Darwin
import Foundation
import Security

public enum PeerError: Error { case peerPID, identity, bundleLayout }

public enum PeerIdentity {
    private enum OwnSignature {
        case team(String)
        case adHocPreview(executable: String, cdHash: String)
        case adHocNested
        case invalid
    }

    public static func verify(fd: Int32, expectedPID: pid_t) throws {
        var actualPID: pid_t = 0
        var size = socklen_t(MemoryLayout<pid_t>.size)
        guard getsockopt(fd, SOL_LOCAL, LOCAL_PEERPID, &actualPID, &size) == 0,
              size == MemoryLayout<pid_t>.size, actualPID == expectedPID else {
            throw PeerError.peerPID
        }
        switch ownSignature() {
        case .team(let teamID):
            guard validSignedPeer(pid: actualPID, teamID: teamID) else { throw PeerError.identity }
        case .adHocPreview(let executable, let cdHash):
            guard let actual = executablePath(pid: actualPID),
                  URL(fileURLWithPath: actual).resolvingSymlinksInPath().path == executable,
                  validAdHocPeer(pid: actualPID, cdHash: cdHash) else {
                throw PeerError.identity
            }
        case .adHocNested:
            guard let expected = installedMainExecutable(),
                  let actual = executablePath(pid: actualPID),
                  URL(fileURLWithPath: actual).resolvingSymlinksInPath().path == expected else {
                throw PeerError.identity
            }
        case .invalid:
            throw PeerError.identity
        }
    }

    private static func ownSignature() -> OwnSignature {
        var selfCode: SecCode?
        guard SecCodeCopySelf([], &selfCode) == errSecSuccess, let selfCode else { return .invalid }
        var staticCode: SecStaticCode?
        guard SecCodeCopyStaticCode(selfCode, [], &staticCode) == errSecSuccess,
              let staticCode else { return .invalid }
        var details: CFDictionary?
        guard SecStaticCodeCheckValidity(staticCode, [], nil) == errSecSuccess,
              SecCodeCopySigningInformation(staticCode, SecCSFlags(rawValue: kSecCSSigningInformation), &details) == errSecSuccess,
              let info = details as? [String: Any],
              let flags = info[kSecCodeInfoFlags as String] as? NSNumber else { return .invalid }
        // CS_ADHOC is bit 0x2. A detached Preview helper is sealed with the
        // main executable's exact path and hash before LaunchServices starts it.
        if flags.uint32Value & 0x2 != 0 {
            let path = Bundle.main.object(forInfoDictionaryKey: "EmperorExpectedMainExecutable") as? String
            let hash = Bundle.main.object(forInfoDictionaryKey: "EmperorExpectedMainCDHash") as? String
            if let path, let hash {
                let lower = hash.lowercased()
                guard path.hasPrefix("/"), !path.contains("\0"),
                      lower.count == 40,
                      lower.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }) else {
                    return .invalid
                }
                return .adHocPreview(executable: URL(fileURLWithPath: path).resolvingSymlinksInPath().path, cdHash: lower)
            }
            return path == nil && hash == nil ? .adHocNested : .invalid
        }
        guard let team = info[kSecCodeInfoTeamIdentifier as String] as? String,
              !team.isEmpty else { return .invalid }
        return .team(team)
    }

    private static func validSignedPeer(pid: pid_t, teamID: String) -> Bool {
        let escapedTeam = teamID.replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
        let text = "identifier \"com.emperor.agent.desktop\" and anchor apple generic and certificate leaf[subject.OU] = \"\(escapedTeam)\""
        return validPeer(pid: pid, requirement: text)
    }

    private static func validAdHocPeer(pid: pid_t, cdHash: String) -> Bool {
        validPeer(pid: pid, requirement: "identifier \"com.emperor.agent.desktop\" and cdhash H\"\(cdHash)\"")
    }

    private static func validPeer(pid: pid_t, requirement text: String) -> Bool {
        var guest: SecCode?
        let attributes = [kSecGuestAttributePid as String: NSNumber(value: pid)] as CFDictionary
        guard SecCodeCopyGuestWithAttributes(nil, attributes, [], &guest) == errSecSuccess,
              let guest else { return false }
        var requirement: SecRequirement?
        guard SecRequirementCreateWithString(text as CFString, [], &requirement) == errSecSuccess,
              let requirement else { return false }
        return SecCodeCheckValidity(guest, [], requirement) == errSecSuccess
    }

    /// For ad-hoc Preview, compare the main executable's canonical path with
    /// the one implied by the nested helper app, rather than trusting argv.
    private static func installedMainExecutable() -> String? {
        let ownURL = URL(fileURLWithPath: Bundle.main.executablePath ?? CommandLine.arguments[0]).standardizedFileURL
        let helperContents = ownURL.deletingLastPathComponent().deletingLastPathComponent()
        guard helperContents.lastPathComponent == "Contents",
              helperContents.deletingLastPathComponent().lastPathComponent == "Emperor Computer Helper.app" else {
            return nil
        }
        let mainContents = helperContents
            .deletingLastPathComponent()  // helper app
            .deletingLastPathComponent()  // Helpers
            .deletingLastPathComponent()  // Library
            .deletingLastPathComponent()  // main Contents
        guard mainContents.lastPathComponent == "Contents" else { return nil }
        return mainContents.appendingPathComponent("MacOS/Emperor Agent").resolvingSymlinksInPath().path
    }

    private static func executablePath(pid: pid_t) -> String? {
        var buffer = [CChar](repeating: 0, count: Int(PATH_MAX))
        let count = proc_pidpath(pid, &buffer, UInt32(buffer.count))
        guard count > 0 else { return nil }
        return String(decoding: buffer.prefix(while: { $0 != 0 }).map(UInt8.init(bitPattern:)), as: UTF8.self)
    }
}
