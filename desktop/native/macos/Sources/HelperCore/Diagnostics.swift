import Darwin
import Foundation

/// One-line stderr diagnostics. The helper writes no log files and no
/// persistent unified-log entries (00 §11). Codes are stable identifiers and
/// values are clipped to a small token alphabet, so a caller cannot leak a
/// launch nonce, a filesystem path, window text, or a secret through them.
public enum HelperDiagnostic {
    public static let prefix = "Emperor Computer Helper:"
    private static let maxValueBytes = 64

    public static func line(_ code: String, _ fields: KeyValuePairs<String, String> = [:]) -> String {
        var parts = [prefix, token(code, allowed: codeCharacter, fallback: "UNKNOWN")]
        for (key, value) in fields {
            parts.append("\(token(key, allowed: keyCharacter, fallback: "field"))=\(token(value, allowed: valueCharacter, fallback: "-"))")
        }
        return parts.joined(separator: " ")
    }

    /// Best effort: a closed or redirected stderr never affects the helper.
    public static func emit(_ code: String, _ fields: KeyValuePairs<String, String> = [:]) {
        let bytes = Array((line(code, fields) + "\n").utf8)
        bytes.withUnsafeBytes { raw in
            _ = Darwin.write(STDERR_FILENO, raw.baseAddress, raw.count)
        }
    }

    private static func token(_ text: String, allowed: (UInt8) -> Bool, fallback: String) -> String {
        let clipped = text.utf8.prefix(maxValueBytes).map { allowed($0) ? $0 : UInt8(ascii: "?") }
        return clipped.isEmpty ? fallback : String(decoding: clipped, as: UTF8.self)
    }

    private static func codeCharacter(_ byte: UInt8) -> Bool {
        (65...90).contains(byte) || (48...57).contains(byte) || byte == UInt8(ascii: "_")
    }

    private static func keyCharacter(_ byte: UInt8) -> Bool {
        (65...90).contains(byte) || (97...122).contains(byte) || (48...57).contains(byte)
    }

    private static func valueCharacter(_ byte: UInt8) -> Bool {
        keyCharacter(byte) || [UInt8(ascii: "-"), UInt8(ascii: "_"), UInt8(ascii: "."),
                               UInt8(ascii: ",")].contains(byte)
    }
}
