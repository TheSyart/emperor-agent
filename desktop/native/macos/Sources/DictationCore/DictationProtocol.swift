import Foundation

/// The dictation helper's wire protocol (VO-01): one JSON object per line on
/// stdin (requests from Emperor's main process) and stdout (events). The
/// helper runs as a child process, so the pipe itself is the authenticated
/// channel; this layer only validates shapes and sizes. While the
/// microphone is open, `level` events carry its loudness (0–1, about 15 a
/// second) for the composer's waveform (RV-06).
public let dictationProtocolVersion = 1
/// Longest accepted request line, in UTF-8 bytes.
public let dictationMaxLineBytes = 64 * 1024
/// Upper bound for one dictation, in seconds.
public let dictationMaxSeconds = 600

public enum DictationRequest: Equatable, Sendable {
    case hello(protocolVersion: Int)
    case status
    case start(session: String, locale: String?, device: String?, maxSeconds: Int)
    case stop(session: String)
    case cancel(session: String)
}

public enum PermissionState: String, Sendable, Equatable {
    case granted, denied, undetermined, restricted
}

public struct DictationDevice: Equatable, Sendable {
    public let id: String
    public let name: String
    public let isDefault: Bool
    public init(id: String, name: String, isDefault: Bool) {
        self.id = id
        self.name = name
        self.isDefault = isDefault
    }
}

public struct DictationLocale: Equatable, Sendable {
    public let id: String
    public let name: String
    public init(id: String, name: String) {
        self.id = id
        self.name = name
    }
}

public struct DictationStatus: Equatable, Sendable {
    public let microphone: PermissionState
    public let speech: PermissionState
    public let devices: [DictationDevice]
    /// Locales this machine can recognize on device, right now.
    public let locales: [DictationLocale]
    public let systemLocale: String
    public let engine: String
    public init(
        microphone: PermissionState, speech: PermissionState,
        devices: [DictationDevice], locales: [DictationLocale],
        systemLocale: String, engine: String
    ) {
        self.microphone = microphone
        self.speech = speech
        self.devices = devices
        self.locales = locales
        self.systemLocale = systemLocale
        self.engine = engine
    }
}

public enum DictationErrorCode: String, Sendable, Equatable {
    case invalidRequest = "invalid_request"
    case busy
    case notFound = "not_found"
    case permissionDenied = "permission_denied"
    case noDevice = "no_device"
    case unsupportedLocale = "unsupported_locale"
    case recognizerUnavailable = "recognizer_unavailable"
    case failed
}

public enum DictationEndReason: String, Sendable, Equatable {
    case stopped, cancelled, maxDuration = "max_duration", error
}

public enum DictationEvent: Equatable, Sendable {
    case hello(protocolVersion: Int, engine: String)
    case status(DictationStatus)
    case started(session: String, seq: Int, locale: String)
    case partial(session: String, seq: Int, text: String)
    /// The microphone's loudness, 0–1 with two decimals.
    case level(session: String, seq: Int, value: Double)
    case final(session: String, seq: Int, text: String)
    case ended(session: String, seq: Int, reason: DictationEndReason)
    case error(session: String?, seq: Int?, code: DictationErrorCode, message: String)
}

public struct DictationProtocolError: Error, Equatable, Sendable {
    public let message: String
    public init(_ message: String) { self.message = message }
}

/// Ids Emperor generates for a session (a UUID, or anything this plain).
private func validSession(_ value: String) -> Bool {
    value.count >= 8 && value.count <= 64
        && value.unicodeScalars.allSatisfy {
            CharacterSet.alphanumerics.contains($0) || $0 == "-"
        }
}

/// BCP 47-ish: `zh-CN`, `en_US`, `yue-Hant-HK`.
private func validLocale(_ value: String) -> Bool {
    guard value.count >= 2, value.count <= 35 else { return false }
    let parts = value.split(separator: "-", omittingEmptySubsequences: false)
        .flatMap { $0.split(separator: "_", omittingEmptySubsequences: false) }
    guard let first = parts.first, (2...3).contains(first.count),
        first.unicodeScalars.allSatisfy({ CharacterSet.letters.contains($0) })
    else { return false }
    return parts.dropFirst().allSatisfy { part in
        (2...8).contains(part.count)
            && part.unicodeScalars.allSatisfy { CharacterSet.alphanumerics.contains($0) }
    }
}

public enum DictationCodec {
    public static func decodeRequest(_ line: Data) throws -> DictationRequest {
        guard line.count <= dictationMaxLineBytes else {
            throw DictationProtocolError("request is longer than \(dictationMaxLineBytes) bytes")
        }
        guard let object = try? JSONSerialization.jsonObject(with: line),
            let body = object as? [String: Any]
        else { throw DictationProtocolError("request is not a JSON object") }
        guard let type = body["type"] as? String else {
            throw DictationProtocolError("request has no type")
        }
        func only(_ keys: Set<String>) throws {
            let extra = Set(body.keys).subtracting(keys.union(["type"]))
            if !extra.isEmpty {
                throw DictationProtocolError("unknown keys: \(extra.sorted().joined(separator: ", "))")
            }
        }
        func session() throws -> String {
            guard let value = body["session"] as? String, validSession(value) else {
                throw DictationProtocolError("session must be 8–64 letters, digits or dashes")
            }
            return value
        }
        switch type {
        case "hello":
            try only(["protocol"])
            guard let version = body["protocol"] as? Int else {
                throw DictationProtocolError("hello needs a protocol version")
            }
            return .hello(protocolVersion: version)
        case "status":
            try only([])
            return .status
        case "start":
            try only(["session", "locale", "device", "maxSeconds"])
            let id = try session()
            var locale: String?
            if let raw = body["locale"], !(raw is NSNull) {
                guard let value = raw as? String, validLocale(value) else {
                    throw DictationProtocolError("locale is not a language tag")
                }
                locale = value
            }
            var device: String?
            if let raw = body["device"], !(raw is NSNull) {
                guard let value = raw as? String, !value.isEmpty, value.count <= 256 else {
                    throw DictationProtocolError("device must be a non-empty id of at most 256 characters")
                }
                device = value
            }
            guard let seconds = body["maxSeconds"] as? Int,
                (1...dictationMaxSeconds).contains(seconds)
            else {
                throw DictationProtocolError("maxSeconds must be 1–\(dictationMaxSeconds)")
            }
            return .start(session: id, locale: locale, device: device, maxSeconds: seconds)
        case "stop":
            try only(["session"])
            return .stop(session: try session())
        case "cancel":
            try only(["session"])
            return .cancel(session: try session())
        default:
            throw DictationProtocolError("unknown request type \(type)")
        }
    }

    /// One event as a JSON line (keys sorted, trailing newline).
    public static func encode(_ event: DictationEvent) -> Data {
        var body: [String: Any]
        switch event {
        case let .hello(version, engine):
            body = ["type": "hello", "protocol": version, "engine": engine]
        case let .status(status):
            body = [
                "type": "status",
                "permissions": [
                    "microphone": status.microphone.rawValue,
                    "speech": status.speech.rawValue,
                ],
                "devices": status.devices.map {
                    ["id": $0.id, "name": $0.name, "default": $0.isDefault] as [String: Any]
                },
                "locales": status.locales.map { ["id": $0.id, "name": $0.name] },
                "systemLocale": status.systemLocale,
                "engine": status.engine,
            ]
        case let .started(session, seq, locale):
            body = ["type": "started", "session": session, "seq": seq, "locale": locale]
        case let .partial(session, seq, text):
            body = ["type": "partial", "session": session, "seq": seq, "text": text]
        case let .level(session, seq, value):
            // Hundredths as a decimal: a Double would print 0.42999999999999999.
            let hundredths = value.isFinite ? Int((min(1, max(0, value)) * 100).rounded()) : 0
            body = [
                "type": "level", "session": session, "seq": seq,
                "value": NSDecimalNumber(value: hundredths).dividing(by: 100),
            ]
        case let .final(session, seq, text):
            body = ["type": "final", "session": session, "seq": seq, "text": text]
        case let .ended(session, seq, reason):
            body = ["type": "ended", "session": session, "seq": seq, "reason": reason.rawValue]
        case let .error(session, seq, code, message):
            body = [
                "type": "error",
                "session": session.map { $0 as Any } ?? NSNull(),
                "seq": seq.map { $0 as Any } ?? NSNull(),
                "code": code.rawValue,
                "message": message,
            ]
        }
        var data = (try? JSONSerialization.data(withJSONObject: body, options: [.sortedKeys])) ?? Data()
        data.append(0x0A)
        return data
    }
}
