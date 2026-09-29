import Darwin
import Foundation
import Security

private let hostName = "com.emperor.agent.browser"
private let browserToMainLimit = 64 * 1024 * 1024
private let mainToBrowserLimit = 1024 * 1024

private enum HostError: Error {
    case invalidArguments
    case invalidOrigin
    case invalidPath
    case insecureSocket
    case mainUnavailable
    case peerRejected
    case frameTooLarge
    case truncatedFrame
    case io
}

private func fail(_ code: String) -> Never {
    // Only a fixed diagnostic code; never log a browser frame, URL, secret, or
    // pairing message. stdout is reserved for Native Messaging frames.
    fputs("emperor-nm-host: \(code)\n", stderr)
    exit(EXIT_FAILURE)
}

private func writeAll(_ fd: Int32, _ data: Data) throws {
    try data.withUnsafeBytes { bytes in
        guard let base = bytes.baseAddress else { return }
        var offset = 0
        while offset < bytes.count {
            let count = Darwin.write(fd, base.advanced(by: offset), bytes.count - offset)
            if count < 0 && errno == EINTR { continue }
            guard count > 0 else { throw HostError.io }
            offset += count
        }
    }
}

private func readExactly(_ fd: Int32, count: Int) throws -> Data? {
    var data = Data(count: count)
    var offset = 0
    try data.withUnsafeMutableBytes { bytes in
        guard let base = bytes.baseAddress else { return }
        while offset < count {
            let received = Darwin.read(fd, base.advanced(by: offset), count - offset)
            if received < 0 && errno == EINTR { continue }
            if received == 0 {
                if offset == 0 { return }
                throw HostError.truncatedFrame
            }
            guard received > 0 else { throw HostError.io }
            offset += received
        }
    }
    return offset == 0 ? nil : data
}

private func readFrame(_ fd: Int32, limit: Int) throws -> Data? {
    guard let header = try readExactly(fd, count: 4) else { return nil }
    var length: UInt32 = 0
    _ = header.withUnsafeBytes { bytes in
        memcpy(&length, bytes.baseAddress!, 4)
    }
    // Native Messaging uses the host's native byte order, not the network
    // byte order used by the separate platform-helper protocol (§11).
    guard length > 0 && Int(length) <= limit else { throw HostError.frameTooLarge }
    guard let body = try readExactly(fd, count: Int(length)) else { throw HostError.truncatedFrame }
    var frame = header
    frame.append(body)
    return frame
}

private func writeErrorFrame(_ code: String) {
    let object: [String: Any] = [
        "type": "response", "id": 0, "ok": false,
        "error": ["code": code, "message": code, "retryable": true],
    ]
    guard let body = try? JSONSerialization.data(withJSONObject: object), body.count <= mainToBrowserLimit else { return }
    var length = UInt32(body.count)
    var frame = withUnsafeBytes(of: &length) { Data($0) }
    frame.append(body)
    try? writeAll(STDOUT_FILENO, frame)
}

private func homeDirectory() throws -> String {
    guard let record = getpwuid(getuid()), let path = record.pointee.pw_dir else { throw HostError.invalidPath }
    return String(cString: path)
}

private func defaultSocketPath() throws -> String {
    "\(try homeDirectory())/.emperor/run/nm-\(getuid()).sock"
}

private func checkedSocketPath(_ path: String) throws {
    guard path.hasPrefix("/"), !path.utf8.contains(0), path.utf8.count < 104 else { throw HostError.invalidPath }
    let parent = URL(fileURLWithPath: path).deletingLastPathComponent().path
    var directory = stat()
    if lstat(parent, &directory) != 0 {
        if errno == ENOENT { throw HostError.mainUnavailable }
        throw HostError.insecureSocket
    }
    guard
          directory.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR),
          directory.st_uid == getuid(),
          directory.st_mode & 0o777 == 0o700 else { throw HostError.insecureSocket }
    var socketInfo = stat()
    if lstat(path, &socketInfo) != 0 {
        if errno == ENOENT { throw HostError.mainUnavailable }
        throw HostError.insecureSocket
    }
    guard
          socketInfo.st_mode & mode_t(S_IFMT) == mode_t(S_IFSOCK),
          socketInfo.st_uid == getuid(),
          socketInfo.st_mode & 0o077 == 0 else { throw HostError.insecureSocket }
}

private func connectSocket(_ path: String) throws -> Int32 {
    try checkedSocketPath(path)
    let fd = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else { throw HostError.mainUnavailable }
    var address = sockaddr_un()
    address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
    address.sun_family = sa_family_t(AF_UNIX)
    let characters = path.utf8CString
    _ = withUnsafeMutableBytes(of: &address.sun_path) { bytes in
        characters.withUnsafeBytes { source in
            memcpy(bytes.baseAddress!, source.baseAddress!, source.count)
        }
    }
    let connected = withUnsafePointer(to: &address) { pointer in
        pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
        }
    }
    guard connected == 0 else { Darwin.close(fd); throw HostError.mainUnavailable }
    return fd
}

private func executablePath(pid: pid_t) -> String? {
    var buffer = [CChar](repeating: 0, count: Int(PATH_MAX))
    guard proc_pidpath(pid, &buffer, UInt32(buffer.count)) > 0 else { return nil }
    return String(cString: buffer)
}

private func canonical(_ path: String) -> String {
    URL(fileURLWithPath: path).standardizedFileURL.resolvingSymlinksInPath().path
}

private func ownTeamID() -> String? {
    var selfCode: SecCode?
    guard SecCodeCopySelf([], &selfCode) == errSecSuccess, let selfCode else { return nil }
    var staticCode: SecStaticCode?
    guard SecCodeCopyStaticCode(selfCode, [], &staticCode) == errSecSuccess, let staticCode else { return nil }
    var details: CFDictionary?
    guard SecCodeCopySigningInformation(staticCode, SecCSFlags(rawValue: kSecCSSigningInformation), &details) == errSecSuccess,
          let info = details as? [String: Any],
          let flags = info[kSecCodeInfoFlags as String] as? NSNumber,
          flags.uint32Value & 0x2 == 0,
          let team = info[kSecCodeInfoTeamIdentifier as String] as? String,
          !team.isEmpty else { return nil }
    return team
}

private func signedMainMatches(pid: pid_t, teamID: String) -> Bool {
    let escaped = teamID.replacingOccurrences(of: "\\", with: "\\\\")
        .replacingOccurrences(of: "\"", with: "\\\"")
    let requirementText = "identifier \"com.emperor.agent.desktop\" and anchor apple generic and certificate leaf[subject.OU] = \"\(escaped)\""
    var requirement: SecRequirement?
    guard SecRequirementCreateWithString(requirementText as CFString, [], &requirement) == errSecSuccess,
          let requirement else { return false }
    let attributes = [kSecGuestAttributePid as String: NSNumber(value: pid)] as CFDictionary
    var guest: SecCode?
    guard SecCodeCopyGuestWithAttributes(nil, attributes, [], &guest) == errSecSuccess,
          let guest else { return false }
    return SecCodeCheckValidity(guest, [], requirement) == errSecSuccess
}

private func packagedMainExecutable() -> String? {
    let ownPath = URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL
    let helpers = ownPath.deletingLastPathComponent()
    let library = helpers.deletingLastPathComponent()
    let contents = library.deletingLastPathComponent()
    let app = contents.deletingLastPathComponent()
    guard helpers.lastPathComponent == "Helpers",
          library.lastPathComponent == "Library",
          contents.lastPathComponent == "Contents",
          app.pathExtension == "app" else { return nil }
    return contents.appendingPathComponent("MacOS/Emperor Agent").path
}

private func verifyPeer(_ fd: Int32, fixtureMain: String? = nil) throws {
    var peerUID: uid_t = 0
    var peerGID: gid_t = 0
    guard getpeereid(fd, &peerUID, &peerGID) == 0, peerUID == getuid() else { throw HostError.peerRejected }
    var pid: pid_t = 0
    var length = socklen_t(MemoryLayout<pid_t>.size)
    guard getsockopt(fd, SOL_LOCAL, LOCAL_PEERPID, &pid, &length) == 0,
          length == MemoryLayout<pid_t>.size, pid > 0 else { throw HostError.peerRejected }
    #if NM_TESTING
    if let fixtureMain {
        guard let actual = executablePath(pid: pid), canonical(actual) == canonical(fixtureMain) else { throw HostError.peerRejected }
        return
    }
    #endif
    if let team = ownTeamID() {
        guard signedMainMatches(pid: pid, teamID: team) else { throw HostError.peerRejected }
    } else {
        guard let expected = packagedMainExecutable(),
              let actual = executablePath(pid: pid),
              canonical(actual) == canonical(expected) else { throw HostError.peerRejected }
    }
}

private func relay(from source: Int32, to destination: Int32, limit: Int) throws {
    while let frame = try readFrame(source, limit: limit) {
        try writeAll(destination, frame)
    }
}

private func extensionID(_ text: String) -> Bool {
    text.utf8.count == 32 && text.utf8.allSatisfy { $0 >= 97 && $0 <= 112 }
}

private func originID(_ origin: String) -> String? {
    let prefix = "chrome-extension://"
    guard origin.hasPrefix(prefix) else { return nil }
    let suffix = String(origin.dropFirst(prefix.count))
    let id = suffix.hasSuffix("/") ? String(suffix.dropLast()) : suffix
    return extensionID(id) ? id : nil
}

private func browserManifestDirectory(_ browser: String) throws -> URL {
    let relative: String
    switch browser {
    case "chrome": relative = "Google/Chrome"
    case "chrome-beta": relative = "Google/Chrome Beta"
    case "chrome-dev": relative = "Google/Chrome Dev"
    case "chrome-canary": relative = "Google/Chrome Canary"
    case "chrome-for-testing": relative = "Google/ChromeForTesting"
    case "chromium": relative = "Chromium"
    case "edge": relative = "Microsoft Edge"
    default: throw HostError.invalidArguments
    }
    return URL(fileURLWithPath: try homeDirectory()).appendingPathComponent("Library/Application Support/\(relative)/NativeMessagingHosts")
}

private func manifestData(binary: String, id: String) throws -> Data {
    guard extensionID(id), binary.hasPrefix("/"), !binary.utf8.contains(0),
          FileManager.default.isExecutableFile(atPath: binary) else { throw HostError.invalidArguments }
    let document: [String: Any] = [
        "name": hostName,
        "description": "Emperor Agent browser connection",
        "path": canonical(binary),
        "type": "stdio",
        "allowed_origins": ["chrome-extension://\(id)/"],
    ]
    return try JSONSerialization.data(withJSONObject: document, options: [.prettyPrinted, .sortedKeys])
}

private func parsedFlags(_ args: ArraySlice<String>) throws -> [String: String] {
    let words = Array(args)
    guard words.count.isMultiple(of: 2) else { throw HostError.invalidArguments }
    var result: [String: String] = [:]
    for index in stride(from: 0, to: words.count, by: 2) {
        guard words[index].hasPrefix("--"), result[words[index]] == nil else { throw HostError.invalidArguments }
        result[words[index]] = words[index + 1]
    }
    return result
}

private func manageManifest(_ args: [String]) throws {
    guard args.count >= 2 else { throw HostError.invalidArguments }
    let command = args[1]
    let flags = try parsedFlags(args.dropFirst(2))
    if command == "--manifest" {
        guard flags.count == 2, let binary = flags["--host-path"], let id = flags["--extension-id"] else { throw HostError.invalidArguments }
        try writeAll(STDOUT_FILENO, manifestData(binary: binary, id: id) + Data([10]))
        return
    }
    guard let browser = flags["--browser"], flags.count == (command == "--install" ? 3 : 1) else { throw HostError.invalidArguments }
    let directory = try browserManifestDirectory(browser)
    let destination = directory.appendingPathComponent("\(hostName).json")
    if command == "--install" {
        guard let binary = flags["--host-path"], let id = flags["--extension-id"] else { throw HostError.invalidArguments }
        let data = try manifestData(binary: binary, id: id)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let temporary = directory.appendingPathComponent(".\(hostName).\(UUID().uuidString).tmp")
        guard FileManager.default.createFile(atPath: temporary.path, contents: data, attributes: [.posixPermissions: 0o600]) else { throw HostError.io }
        defer { try? FileManager.default.removeItem(at: temporary) }
        if rename(temporary.path, destination.path) != 0 { throw HostError.io }
        if chmod(destination.path, 0o600) != 0 { throw HostError.io }
        return
    }
    if command == "--uninstall" {
        var info = stat()
        guard lstat(destination.path, &info) == 0 else {
            if errno == ENOENT { return }
            throw HostError.io
        }
        guard info.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG), info.st_uid == getuid(),
              let data = try? Data(contentsOf: destination),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              object["name"] as? String == hostName else { throw HostError.invalidPath }
        try FileManager.default.removeItem(at: destination)
        return
    }
    throw HostError.invalidArguments
}

private func runNative(_ arguments: [String]) throws {
    var origin: String
    var socketPath = try defaultSocketPath()
    var fixtureMain: String? = nil
    #if NM_TESTING
    if arguments.count == 6 && arguments[1] == "--fixture-socket" && arguments[3] == "--fixture-main-exe" {
        socketPath = arguments[2]
        fixtureMain = arguments[4]
        origin = arguments[5]
    } else {
        guard arguments.count == 2 else { throw HostError.invalidArguments }
        origin = arguments[1]
    }
    #else
    guard arguments.count == 2 else { throw HostError.invalidArguments }
    origin = arguments[1]
    #endif
    guard originID(origin) != nil else { throw HostError.invalidOrigin }
    let socket: Int32
    do { socket = try connectSocket(socketPath) }
    catch HostError.mainUnavailable {
        writeErrorFrame("EMPEROR_NOT_RUNNING")
        throw HostError.mainUnavailable
    } catch {
        writeErrorFrame("PEER_IDENTITY_REJECTED")
        throw error
    }
    do { try verifyPeer(socket, fixtureMain: fixtureMain) }
    catch {
        Darwin.close(socket)
        writeErrorFrame("PEER_IDENTITY_REJECTED")
        throw error
    }
    signal(SIGPIPE, SIG_IGN)
    Thread.detachNewThread {
        do {
            try relay(from: STDIN_FILENO, to: socket, limit: browserToMainLimit)
            shutdown(socket, SHUT_WR)
        } catch HostError.frameTooLarge {
            fail("FRAME_TOO_LARGE")
        } catch {
            fail("IO_ERROR")
        }
    }
    defer { Darwin.close(socket) }
    try relay(from: socket, to: STDOUT_FILENO, limit: mainToBrowserLimit)
    shutdown(socket, SHUT_RDWR)
}

do {
    let arguments = CommandLine.arguments
    if arguments.count > 1 && arguments[1].hasPrefix("--") && arguments[1] != "--fixture-socket" {
        try manageManifest(arguments)
    } else {
        try runNative(arguments)
    }
} catch HostError.frameTooLarge {
    fail("FRAME_TOO_LARGE")
} catch HostError.peerRejected {
    fail("PEER_IDENTITY_REJECTED")
} catch HostError.invalidOrigin {
    fail("EXTENSION_ORIGIN_REJECTED")
} catch HostError.invalidArguments {
    fail("INVALID_ARGUMENTS")
} catch HostError.insecureSocket {
    fail("INSECURE_SOCKET")
} catch HostError.mainUnavailable {
    fail("EMPEROR_NOT_RUNNING")
} catch {
    fail("IO_ERROR")
}
