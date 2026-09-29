import Foundation

public enum FrameError: Error, Equatable {
    case invalidLength
    case oversizedJSON
    case invalidUTF8
    case invalidJSON
    case malformedBlob
    case invalidBlobID
    case unknownKind
    case failedDecoder
}

public enum Frame: Equatable {
    case json(Data)
    case blob(id: String, bytes: Data)
}

public enum Framing {
    public static let jsonKind: UInt8 = 1
    public static let blobKind: UInt8 = 2
    public static let maxJSONBytes = 1_048_576
    public static let maxFrameBytes = 33_554_432

    public static func encodeJSON(_ data: Data) throws -> Data {
        guard data.count <= maxJSONBytes else { throw FrameError.oversizedJSON }
        return try wrap(kind: jsonKind, body: data)
    }

    public static func encodeBlob(id: String, bytes: Data) throws -> Data {
        guard validBlobID(id), let idBytes = id.data(using: .ascii) else { throw FrameError.invalidBlobID }
        guard bytes.count <= maxFrameBytes - idBytes.count - 2 else { throw FrameError.invalidLength }
        var body = Data([UInt8(idBytes.count)])
        body.append(idBytes)
        body.append(bytes)
        return try wrap(kind: blobKind, body: body)
    }

    public static func decode(kind: UInt8, body: Data) throws -> Frame {
        switch kind {
        case jsonKind:
            guard body.count <= maxJSONBytes else { throw FrameError.oversizedJSON }
            guard String(data: body, encoding: .utf8) != nil else { throw FrameError.invalidUTF8 }
            guard (try? JSONSerialization.jsonObject(with: body, options: [.fragmentsAllowed])) != nil else {
                throw FrameError.invalidJSON
            }
            return .json(body)
        case blobKind:
            guard let length = body.first, length > 0, body.count >= Int(length) + 1,
                  let id = String(data: body.subdata(in: 1..<(Int(length) + 1)), encoding: .ascii),
                  validBlobID(id) else { throw FrameError.malformedBlob }
            return .blob(id: id, bytes: body.subdata(in: (Int(length) + 1)..<body.count))
        default:
            throw FrameError.unknownKind
        }
    }

    private static func wrap(kind: UInt8, body: Data) throws -> Data {
        let length = body.count + 1
        guard length <= maxFrameBytes else { throw FrameError.invalidLength }
        var result = Data([
            UInt8((length >> 24) & 0xff), UInt8((length >> 16) & 0xff),
            UInt8((length >> 8) & 0xff), UInt8(length & 0xff), kind,
        ])
        result.append(body)
        return result
    }

    private static func validBlobID(_ id: String) -> Bool {
        let bytes = Array(id.utf8)
        return (1...64).contains(bytes.count) && bytes.allSatisfy {
            (48...57).contains($0) || (65...90).contains($0) ||
            (97...122).contains($0) || $0 == 45 || $0 == 95
        }
    }
}

/// Accumulates at most one maximum frame plus a 4-byte header. Rejects the
/// declared length before receiving or allocating a large payload.
public struct FrameDecoder {
    private var pending = Data()
    private var failed = false

    public init() {}

    public mutating func push(_ data: Data) throws -> [Frame] {
        guard !failed else { throw FrameError.failedDecoder }
        do {
            var input = data[...]
            var frames: [Frame] = []
            while !input.isEmpty {
                if pending.count < 4 {
                    let take = min(4 - pending.count, input.count)
                    pending.append(contentsOf: input.prefix(take))
                    input = input.dropFirst(take)
                    if pending.count < 4 { break }
                }
                let length = pending.prefix(4).reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
                guard length >= 1 && length <= Framing.maxFrameBytes else { throw FrameError.invalidLength }
                let remaining = Int(length) + 4 - pending.count
                let take = min(remaining, input.count)
                pending.append(contentsOf: input.prefix(take))
                input = input.dropFirst(take)
                if pending.count == Int(length) + 4 {
                    frames.append(try Framing.decode(
                        kind: pending[4], body: pending.subdata(in: 5..<pending.count)))
                    pending.removeAll(keepingCapacity: true)
                }
            }
            return frames
        } catch {
            failed = true
            pending.removeAll()
            throw error
        }
    }

    public var pendingBytes: Int { pending.count }
}
