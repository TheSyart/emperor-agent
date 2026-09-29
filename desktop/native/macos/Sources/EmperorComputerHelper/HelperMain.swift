import Darwin
import Foundation
import HelperCore
import HelperPlatform

private struct LaunchOptions {
    let parentPID: pid_t
    let nonce: String
    let socketPath: String

    init(arguments: [String]) throws {
        guard arguments.count == 6,
              arguments[0] == "--parent-pid", let pid = Int32(arguments[1]), pid > 1,
              arguments[2] == "--nonce", (16...128).contains(arguments[3].utf8.count),
              arguments[4] == "--socket", arguments[5].hasPrefix("/") else {
            throw ProtocolError.invalidMessage
        }
        parentPID = pid
        nonce = arguments[3]
        socketPath = arguments[5]
    }
}

private final class Connection {
    private let fd: Int32
    private var decoder = FrameDecoder()
    private var pending: [[String: Any]] = []

    init(fd: Int32) { self.fd = fd }
    deinit { close(fd) }

    func send(_ message: [String: Any]) throws {
        let bytes = try Framing.encodeJSON(HelperProtocol.encode(message))
        try sendRaw(bytes)
    }

    func sendBlob(id: String, bytes: Data) throws {
        try sendRaw(Framing.encodeBlob(id: id, bytes: bytes))
    }

    private func sendRaw(_ bytes: Data) throws {
        var written = 0
        try bytes.withUnsafeBytes { raw in
            while written < raw.count {
                let count = Darwin.write(fd, raw.baseAddress!.advanced(by: written), raw.count - written)
                if count > 0 { written += count; continue }
                if count < 0 && errno == EINTR { continue }
                throw FrameError.failedDecoder
            }
        }
    }

    /// nil means poll timeout; an empty array means the peer disconnected.
    func read(timeoutMilliseconds: Int32) throws -> [[String: Any]]? {
        if !pending.isEmpty {
            let messages = pending
            pending.removeAll()
            return messages
        }
        return try readNew(timeoutMilliseconds: timeoutMilliseconds)
    }

    /// Runs between input steps of an action. Besides cancellation, it
    /// answers main's heartbeat so a long action is not mistaken for a hang.
    func probeCancel(activeID: Int) {
        for _ in 0..<8 {
            do {
                guard let messages = try readNew(timeoutMilliseconds: 0) else { return }
                if messages.isEmpty { InputController.shared.cancel(); return }
                for message in messages {
                    let type = message["type"] as? String
                    if type == "cancel", message["id"] as? Int == activeID {
                        InputController.shared.cancel()
                    } else if type == "ping", let seq = message["seq"] {
                        try send(["type": "pong", "seq": seq])
                    } else {
                        pending.append(message)
                    }
                }
            } catch {
                InputController.shared.cancel()
                return
            }
        }
    }

    private func readNew(timeoutMilliseconds: Int32) throws -> [[String: Any]]? {
        var descriptor = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
        let result = poll(&descriptor, 1, timeoutMilliseconds)
        if result == 0 { return nil }
        if result < 0 && errno == EINTR { return nil }
        guard result > 0 else { throw FrameError.failedDecoder }
        var buffer = [UInt8](repeating: 0, count: 65_536)
        let size = Darwin.read(fd, &buffer, buffer.count)
        if size == 0 { return [] }
        if size < 0 && errno == EINTR { return nil }
        guard size > 0 else { throw FrameError.failedDecoder }
        let frames = try decoder.push(Data(buffer.prefix(size)))
        if frames.isEmpty { return nil }
        return try frames.map { frame in
            guard case let .json(data) = frame else { throw FrameError.unknownKind }
            return try HelperProtocol.decode(data)
        }
    }
}

private func constantTimeEqual(_ left: String, _ right: String) -> Bool {
    let a = Array(left.utf8), b = Array(right.utf8)
    guard a.count == b.count else { return false }
    var difference: UInt8 = 0
    for index in a.indices { difference |= a[index] ^ b[index] }
    return difference == 0
}

private func releaseAllInput() {
    InputController.shared.releaseAll()
}

private func serve(_ connection: Connection, nonce: String, parentPID: pid_t) async throws {
    #if arch(arm64)
    let arch = "arm64"
    #elseif arch(x86_64)
    let arch = "x86_64"
    #else
    let arch = "unknown"
    #endif
    let dispatcher = ReadOnlyDispatcher(verifiedMainPID: parentPID)
    try connection.send(HelperProtocol.hello(
        arch: arch, permissions: DesktopPermissions.status(),
        capabilities: ["permissions.status", "permissions.request", "apps.list", "windows.list",
                       "target.bind", "target.release", "observe.semantic", "observe.screenshot", "observe.menu", "act",
                       "target.capture", "target.preview", "front.restore",
                       "act.fillSecret",
                       "input.releaseAll"]))

    let handshakeDeadline = ContinuousClock.now.advanced(by: .seconds(5))
    var welcome: [String: Any]?
    var initialMessages: [[String: Any]] = []
    while ContinuousClock.now < handshakeDeadline && welcome == nil {
        let received: [[String: Any]]?
        do {
            received = try connection.read(timeoutMilliseconds: 200)
        } catch {
            HelperDiagnostic.emit("HANDSHAKE_FAILED", ["reason": "invalid-message"])
            throw error
        }
        guard let messages = received else { continue }
        guard let first = messages.first else {
            HelperDiagnostic.emit("HANDSHAKE_FAILED", ["reason": "disconnected"])
            throw ProtocolError.invalidMessage
        }
        welcome = first
        initialMessages = Array(messages.dropFirst())
    }
    guard let welcome else {
        HelperDiagnostic.emit("HANDSHAKE_FAILED", ["reason": "timeout"])
        throw ProtocolError.invalidMessage
    }
    guard welcome["type"] as? String == "welcome" else {
        HelperDiagnostic.emit("HANDSHAKE_FAILED", ["reason": "unexpected-message"])
        throw ProtocolError.invalidMessage
    }
    guard welcome["protocol"] as? Int == HelperProtocol.version else {
        HelperDiagnostic.emit("HANDSHAKE_FAILED", ["reason": "protocol"])
        throw ProtocolError.unsupportedVersion
    }
    // Never report the expected or received nonce, only that it did not match.
    guard let receivedNonce = welcome["nonce"] as? String,
          constantTimeEqual(receivedNonce, nonce) else {
        HelperDiagnostic.emit("PEER_REJECTED", ["reason": "nonce"])
        throw ProtocolError.invalidNonce
    }

    var lastRequest = ContinuousClock.now
    var lastPing = ContinuousClock.now
    var heartbeat = HeartbeatTracker(maxMissed: 3)
    while true {
        guard kill(parentPID, 0) == 0 || errno == EPERM else {
            HelperDiagnostic.emit("HELPER_EXIT", ["reason": "parent-exited"])
            return
        }
        if dispatcher.targetCount == 0 && lastRequest.duration(to: .now) >= .seconds(600) {
            HelperDiagnostic.emit("HELPER_EXIT", ["reason": "idle"])
            return
        }
        await dispatcher.maintainCaptures()
        for event in dispatcher.events() { try connection.send(event) }
        if lastPing.duration(to: .now) >= .seconds(5) {
            // Three unanswered pings are tolerated; the peer is lost only
            // when a fourth falls due with all three still outstanding.
            guard let seq = heartbeat.nextPing() else {
                HelperDiagnostic.emit("HELPER_EXIT", ["reason": "heartbeat-lost"])
                return
            }
            try connection.send(["type": "ping", "seq": seq])
            lastPing = .now
        }
        let messages: [[String: Any]]
        if !initialMessages.isEmpty {
            messages = initialMessages
            initialMessages = []
        } else {
            guard let incoming = try connection.read(timeoutMilliseconds: 1_000) else { continue }
            messages = incoming
        }
        if messages.isEmpty {
            HelperDiagnostic.emit("HELPER_EXIT", ["reason": "disconnected"])
            return
        }
        let cancelledIDs = Set(messages.compactMap { message -> Int? in
            message["type"] as? String == "cancel" ? message["id"] as? Int : nil
        })
        for message in messages {
            switch message["type"] as? String {
            case "pong":
                if let seq = message["seq"] as? Int { heartbeat.acknowledge(seq) }
            case "ping":
                try connection.send(["type": "pong", "seq": message["seq"]!])
            case "cancel":
                InputController.shared.cancel()
            case "request":
                lastRequest = .now
                guard let id = message["id"] as? Int, let method = message["method"] as? String else {
                    throw ProtocolError.invalidMessage
                }
                if cancelledIDs.contains(id) {
                    releaseAllInput()
                    try connection.send(HelperProtocol.error(id: id, code: "CANCELLED", message: "Request cancelled"))
                    continue
                }
                if method == "shutdown" {
                    try connection.send(["type": "response", "id": id, "ok": true, "result": [:] as [String: String]])
                    return
                }
                if method == "input.releaseAll" {
                    let params = message["params"] as? [String: Any]
                    if params?["recovery"] as? Bool == true {
                        InputController.shared.releaseAllAfterCrash()
                    } else {
                        releaseAllInput()
                    }
                    try connection.send(["type": "response", "id": id, "ok": true, "result": [:] as [String: String]])
                    continue
                }
                let started = ContinuousClock.now
                var dispatched = false
                do {
                    if method == "act" || method == "act.fillSecret" {
                        InputController.shared.setCancellationProbe { connection.probeCancel(activeID: id) }
                    }
                    defer { InputController.shared.setCancellationProbe(nil) }
                    let reply = try await dispatcher.handle(method: method, params: message["params"]!) { operationID, pointer in
                        var data: [String: Any] = ["operationId": operationID]
                        if let pointer { data["pointer"] = pointer }
                        try connection.send(["type": "event", "name": "act.dispatched", "data": data])
                        dispatched = true
                    }
                    let deadline = message["deadlineMs"] as? Int ?? 0
                    guard started.duration(to: .now) <= .milliseconds(deadline) else {
                        throw NativeError.denied(code: dispatched ? "OUTCOME_UNKNOWN" : "TIMEOUT_NO_EFFECT",
                                                 message: "Helper request exceeded deadline")
                    }
                    try connection.send(["type": "response", "id": id, "ok": true, "result": reply.result])
                    for (blobID, bytes) in reply.blobs { try connection.sendBlob(id: blobID, bytes: bytes) }
                } catch let error as NativeError {
                    try connection.send(HelperProtocol.error(id: id, code: error.code, message: error.message))
                } catch is BudgetError {
                    try connection.send(HelperProtocol.error(id: id, code: "INVALID_REQUEST", message: "Invalid observation budget"))
                } catch {
                    try connection.send(HelperProtocol.error(id: id, code: "DRIVER_UNAVAILABLE", message: "Native read-only operation failed"))
                }
            default:
                throw ProtocolError.invalidMessage
            }
        }
    }
}

private func run() async throws {
    let options = try LaunchOptions(arguments: Array(CommandLine.arguments.dropFirst()))
    let server = try UnixServer(path: options.socketPath)
    let idleDeadline = ContinuousClock.now.advanced(by: .seconds(600))
    while ContinuousClock.now < idleDeadline {
        guard kill(options.parentPID, 0) == 0 || errno == EPERM else { return }
        guard let client = server.acceptIfReady(timeoutMilliseconds: 1_000) else { continue }
        do {
            try PeerIdentity.verify(fd: client, expectedPID: options.parentPID)
        } catch {
            // Keep listening for the real parent. The rejected peer learns
            // nothing; the reason goes to stderr without pid, path or nonce.
            let reason = (error as? PeerError) == .peerPID ? "pid" : "signature"
            HelperDiagnostic.emit("PEER_REJECTED", ["reason": reason])
            close(client)
            continue
        }
        let connection = Connection(fd: client)
        defer { releaseAllInput() }
        try await serve(connection, nonce: options.nonce, parentPID: options.parentPID)
        return
    }
}

@main private struct HelperMain {
    static func main() async {
        // Diagnostics go to stderr, which may be a closed pipe. The socket
        // itself already uses SO_NOSIGPIPE.
        signal(SIGPIPE, SIG_IGN)
        do {
            try await run()
        } catch {
            // No diagnostic file and no launch nonce, peer path, or secret in stderr.
            HelperDiagnostic.emit("HELPER_FAILED", ["error": String(describing: type(of: error))])
            exit(EXIT_FAILURE)
        }
    }
}
