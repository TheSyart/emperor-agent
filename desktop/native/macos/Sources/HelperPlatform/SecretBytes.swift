import Foundation

/// Best-effort zeroing of the helper-owned UTF-8 copy. Foundation's JSON
/// parser and AX IPC can make additional copies that Swift cannot scrub; the
/// transport must never log or persist an act.fillSecret frame.
final class SecretBytes {
    private var data: Data

    init(_ text: String) { data = Data(text.utf8) }
    deinit { wipe() }

    func withCFString<T>(_ body: (CFString) throws -> T) throws -> T {
        guard !data.isEmpty else {
            throw NativeError.denied(code: "INVALID_REQUEST", message: "Secret is empty")
        }
        return try data.withUnsafeMutableBytes { raw in
            guard let address = raw.baseAddress?.assumingMemoryBound(to: UInt8.self),
                  let value = CFStringCreateWithBytesNoCopy(
                    kCFAllocatorDefault, address, raw.count,
                    CFStringBuiltInEncodings.UTF8.rawValue, false, kCFAllocatorNull) else {
                throw NativeError.denied(code: "DRIVER_UNAVAILABLE", message: "Cannot prepare secret")
            }
            return try body(value)
        }
    }

    func wipe() {
        if !data.isEmpty { data.resetBytes(in: 0..<data.count) }
    }

    var isZeroed: Bool { data.allSatisfy { $0 == 0 } }
}
