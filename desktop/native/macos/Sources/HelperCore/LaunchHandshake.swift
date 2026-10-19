import CryptoKit
import Foundation

/// The Helper's half of the SEC-09 launch handshake. main listens on the
/// socket and hands the Helper a one-time 32-byte secret on stdin (never in
/// argv). On connect main sends `challenge { nonce }`; the Helper answers
/// `hello { nonce, proof }` and accepts main only if `welcome.proof` is
/// right. TypeScript computes the same proofs (protocol/handshake.ts);
/// `fixtures/handshake.json` pins both.
public enum LaunchHandshake {
    public enum Failure: Error, Equatable { case invalidSecret }

    /// A launch nonce or proof: 32 bytes as 64 lowercase hex digits.
    public static func isToken(_ value: String) -> Bool {
        value.utf8.count == 64 && value.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
    }

    /// The stdin line: 64 hex digits, then a newline (optional at EOF).
    public static func parseSecret(_ line: Data) throws -> Data {
        var bytes = [UInt8](line)
        if bytes.last == 0x0a { bytes.removeLast() }
        guard let text = String(bytes: bytes, encoding: .utf8), isToken(text) else {
            throw Failure.invalidSecret
        }
        return hexData(text)
    }

    public static func newNonce() -> String {
        var generator = SystemRandomNumberGenerator()
        return (0..<32).map { _ in String(format: "%02x", UInt8.random(in: 0...255, using: &generator)) }.joined()
    }

    public static func helloProof(secret: Data, serverNonce: String, clientNonce: String) -> String {
        proof(secret: secret, label: "emperor-helper-hello", serverNonce: serverNonce, clientNonce: clientNonce)
    }

    public static func welcomeProof(secret: Data, serverNonce: String, clientNonce: String) -> String {
        proof(secret: secret, label: "emperor-main-welcome", serverNonce: serverNonce, clientNonce: clientNonce)
    }

    /// Constant-time comparison of two tokens.
    public static func matches(_ received: String, _ expected: String) -> Bool {
        let left = Array(received.utf8), right = Array(expected.utf8)
        guard left.count == right.count, isToken(expected) else { return false }
        var difference: UInt8 = 0
        for index in left.indices { difference |= left[index] ^ right[index] }
        return difference == 0
    }

    private static func proof(secret: Data, label: String, serverNonce: String, clientNonce: String) -> String {
        let message = Data("\(label)\u{0}\(serverNonce)\u{0}\(clientNonce)".utf8)
        let code = HMAC<SHA256>.authenticationCode(for: message, using: SymmetricKey(data: secret))
        return code.map { String(format: "%02x", $0) }.joined()
    }

    private static func hexData(_ text: String) -> Data {
        var data = Data(capacity: text.utf8.count / 2)
        var index = text.startIndex
        while index < text.endIndex {
            let next = text.index(index, offsetBy: 2)
            data.append(UInt8(text[index..<next], radix: 16)!)
            index = next
        }
        return data
    }
}
