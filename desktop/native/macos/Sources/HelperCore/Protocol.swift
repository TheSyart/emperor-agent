import Foundation

public enum ProtocolError: Error, Equatable {
    case invalidMessage
    case unsupportedVersion
    case invalidNonce
}

/// JSON object validation at the native trust boundary. The TypeScript schema
/// remains authoritative; these checks reject malformed wire messages before
/// dispatch and impose stricter local observation limits.
public enum HelperProtocol {
    public static let version = 1
    public static let helperVersion = "0.1.0"

    public static func decode(_ data: Data) throws -> [String: Any] {
        guard data.count <= Framing.maxJSONBytes,
              let raw = try? JSONSerialization.jsonObject(with: data),
              let message = raw as? [String: Any] else { throw ProtocolError.invalidMessage }
        try validate(message)
        return message
    }

    public static func encode(_ message: [String: Any]) throws -> Data {
        try validate(message)
        // TS's golden ping frame uses these field orders. All other JSON is
        // semantically compared because JSON object key order is immaterial.
        if let type = message["type"] as? String, ["ping", "pong"].contains(type),
           let seq = integer(message["seq"]) {
            return Data("{\"type\":\"\(type)\",\"seq\":\(seq)}".utf8)
        }
        let data = try JSONSerialization.data(withJSONObject: message, options: [.sortedKeys])
        guard data.count <= Framing.maxJSONBytes else { throw FrameError.oversizedJSON }
        return data
    }

    public static func hello(arch: String, permissions: [String: String], capabilities: [String] = []) -> [String: Any] {
        [
            "type": "hello", "protocol": version, "helperVersion": helperVersion,
            "platform": "macos", "arch": arch,
            "capabilities": capabilities, "permissions": permissions,
        ]
    }

    public static func error(id: Int, code: String, message: String) -> [String: Any] {
        ["type": "response", "id": id, "ok": false,
         "error": ["code": code, "message": String(message.prefix(2_000))]]
    }

    public static func validate(_ message: [String: Any]) throws {
        guard let type = string(message["type"], max: 32) else { throw ProtocolError.invalidMessage }
        switch type {
        case "hello":
            try keys(message, required: ["type", "protocol", "helperVersion", "platform", "arch", "capabilities", "permissions"])
            guard let proto = integer(message["protocol"]), proto > 0,
                  string(message["helperVersion"], max: 64) != nil,
                  let platform = string(message["platform"], max: 16),
                  ["macos", "windows", "linux"].contains(platform),
                  string(message["arch"], max: 32) != nil,
                  let capabilities = message["capabilities"] as? [String], capabilities.count <= 64,
                  capabilities.allSatisfy({ !$0.isEmpty && $0.utf8.count <= 64 }),
                  let permissions = message["permissions"] as? [String: String],
                  permissions.allSatisfy({ ["granted", "denied", "unknown", "stale"].contains($0.value) })
            else { throw ProtocolError.invalidMessage }
        case "welcome":
            try keys(message, required: ["type", "protocol"], optional: ["nonce", "sessionToken"])
            guard let proto = integer(message["protocol"]), proto > 0 else { throw ProtocolError.invalidMessage }
            for name in ["nonce", "sessionToken"] where message[name] != nil {
                guard let value = string(message[name], max: 128), value.utf8.count >= 16 else {
                    throw ProtocolError.invalidMessage
                }
            }
        case "request":
            try keys(message, required: ["type", "id", "method", "params", "deadlineMs"])
            guard let id = integer(message["id"]), id >= 0,
                  string(message["method"], max: 64) != nil,
                  message["params"] != nil,
                  let deadline = integer(message["deadlineMs"]), (1...120_000).contains(deadline)
            else { throw ProtocolError.invalidMessage }
            if message["method"] as? String == "observe.semantic" {
                guard let params = message["params"] as? [String: Any] else { throw ProtocolError.invalidMessage }
                guard let rawBudget = params["budget"] as? [String: Any] else { throw ProtocolError.invalidMessage }
                _ = try ObservationBudget(json: rawBudget)
            }
        case "response":
            guard let id = integer(message["id"]), id >= 0,
                  let ok = message["ok"] as? Bool else { throw ProtocolError.invalidMessage }
            if ok {
                try keys(message, required: ["type", "id", "ok", "result"])
            } else {
                try keys(message, required: ["type", "id", "ok", "error"])
                guard let error = message["error"] as? [String: Any],
                      string(error["code"], max: 64) != nil,
                      let detail = error["message"] as? String, detail.utf8.count <= 2_000 else {
                    throw ProtocolError.invalidMessage
                }
                try keys(error, required: ["code", "message"], optional: ["reason"])
            }
        case "event":
            try keys(message, required: ["type", "name", "data"])
            guard string(message["name"], max: 64) != nil else { throw ProtocolError.invalidMessage }
        case "cancel":
            try keys(message, required: ["type", "id"])
            guard let id = integer(message["id"]), id >= 0 else { throw ProtocolError.invalidMessage }
        case "ping", "pong":
            try keys(message, required: ["type", "seq"])
            guard let seq = integer(message["seq"]), seq >= 0 else { throw ProtocolError.invalidMessage }
        default:
            throw ProtocolError.invalidMessage
        }
    }

    private static func keys(_ object: [String: Any], required: Set<String>, optional: Set<String> = []) throws {
        guard required.isSubset(of: Set(object.keys)),
              Set(object.keys).isSubset(of: required.union(optional)) else { throw ProtocolError.invalidMessage }
    }

    private static func string(_ value: Any?, max: Int) -> String? {
        guard let value = value as? String, !value.isEmpty, value.utf8.count <= max else { return nil }
        return value
    }

    private static func integer(_ value: Any?) -> Int? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
              let decimal = Decimal(string: number.stringValue),
              decimal.isFinite, decimal == Decimal(Int(truncating: number)) else { return nil }
        return Int(exactly: number.int64Value)
    }
}
