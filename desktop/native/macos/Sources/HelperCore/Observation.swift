import Foundation

public enum BudgetError: Error, Equatable { case invalidBudget, exceeded }

public struct ObservationBudget: Equatable, Sendable {
    public static let defaults = ObservationBudget(maxElements: 200, maxTextBytes: 16_384, maxDepth: 8, timeoutMs: 3_000)
    public let maxElements: Int
    public let maxTextBytes: Int
    public let maxDepth: Int
    public let timeoutMs: Int

    public init(maxElements: Int, maxTextBytes: Int, maxDepth: Int, timeoutMs: Int) {
        self.maxElements = maxElements
        self.maxTextBytes = maxTextBytes
        self.maxDepth = maxDepth
        self.timeoutMs = timeoutMs
    }

    public init(json: [String: Any]) throws {
        guard Set(json.keys) == ["maxElements", "maxTextBytes", "maxDepth", "timeoutMs"],
              let elements = Self.integer(json["maxElements"]), (1...200).contains(elements),
              let bytes = Self.integer(json["maxTextBytes"]), (0...16_384).contains(bytes),
              let depth = Self.integer(json["maxDepth"]), (1...16).contains(depth),
              let timeout = Self.integer(json["timeoutMs"]), (100...3_000).contains(timeout)
        else { throw BudgetError.invalidBudget }
        self.init(maxElements: elements, maxTextBytes: bytes, maxDepth: depth, timeoutMs: timeout)
    }

    private static func integer(_ value: Any?) -> Int? {
        guard let number = value as? NSNumber,
              CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
        return Int(number.stringValue)
    }
}

public struct BudgetTracker {
    public let budget: ObservationBudget
    private let start: ContinuousClock.Instant
    private var elementCount = 0
    private var textBytes = 0

    public init(budget: ObservationBudget = .defaults) {
        self.budget = budget
        start = ContinuousClock.now
    }

    public mutating func consume(depth: Int, text: String?) throws {
        guard depth >= 0, depth <= budget.maxDepth,
              elementCount < budget.maxElements,
              textBytes <= budget.maxTextBytes else { throw BudgetError.exceeded }
        let count = text?.utf8.count ?? 0
        guard count <= budget.maxTextBytes - textBytes,
              start.duration(to: .now) <= .milliseconds(budget.timeoutMs) else { throw BudgetError.exceeded }
        elementCount += 1
        textBytes += count
    }

    public var usedElements: Int { elementCount }
    public var usedTextBytes: Int { textBytes }
}

/// A resumable semantic observation cursor names a traversal offset within
/// one target generation and revision. Any other cursor is stale.
public enum ObservationCursor {
    public static let maxOffset = 10_000

    public static func encode(generation: Int, revision: Int, offset: Int) -> String {
        "g\(generation)-r\(revision)-o\(offset)"
    }

    /// The offset of a cursor minted for this generation and revision, or nil.
    public static func offset(_ cursor: String, generation: Int, revision: Int) -> Int? {
        let prefix = "g\(generation)-r\(revision)-o"
        guard cursor.hasPrefix(prefix) else { return nil }
        let digits = cursor.dropFirst(prefix.count)
        guard !digits.isEmpty, digits.utf8.count <= 5,
              digits.utf8.allSatisfy({ (48...57).contains($0) }),
              let offset = Int(digits), offset < maxOffset else { return nil }
        return offset
    }

    /// Budget truncation can resume from the next unread node. Depth and
    /// traversal-limit truncation cannot: the caller must narrow its query.
    public static func next(truncated: Bool, depthLimited: Bool, nextIndex: Int,
                            generation: Int, revision: Int) -> String? {
        guard truncated, !depthLimited, nextIndex >= 0, nextIndex < maxOffset else { return nil }
        return encode(generation: generation, revision: revision, offset: nextIndex)
    }
}

public enum UTF8Text {
    /// The longest prefix of whole Characters that fits in `maximumBytes`.
    public static func prefix(_ text: String, maximumBytes: Int) -> String {
        guard maximumBytes > 0 else { return "" }
        var bytes = 0
        var result = ""
        for character in text {
            let count = String(character).utf8.count
            if bytes + count > maximumBytes { break }
            result.append(character)
            bytes += count
        }
        return result
    }

    /// The longest suffix of whole Characters that fits in `maximumBytes`,
    /// led by `…` when anything was cut.
    public static func tail(_ text: String, maximumBytes: Int) -> String {
        if text.utf8.count <= maximumBytes { return text }
        let marker = "…"
        guard maximumBytes > marker.utf8.count else { return "" }
        var bytes = marker.utf8.count
        var start = text.endIndex
        while start > text.startIndex {
            let previous = text.index(before: start)
            let count = String(text[previous]).utf8.count
            if bytes + count > maximumBytes { break }
            bytes += count
            start = previous
        }
        return marker + text[start...]
    }
}

public struct Point: Equatable {
    public let x: Double; public let y: Double
    public init(x: Double, y: Double) { self.x = x; self.y = y }
}
public struct Rect: Equatable {
    public let x: Double; public let y: Double
    public let width: Double; public let height: Double
    public init(x: Double, y: Double, width: Double, height: Double) {
        self.x = x; self.y = y; self.width = width; self.height = height
    }
}

public enum CoordinateError: Error { case invalidGeometry, outsideScreenshot }
public enum Coordinates {
    public static func screenshotToGlobal(pixel: Point, window: Rect, scale: Double) throws -> Point {
        guard [pixel.x, pixel.y, window.x, window.y, window.width, window.height, scale].allSatisfy(\.isFinite),
              window.width > 0, window.height > 0, scale > 0 else { throw CoordinateError.invalidGeometry }
        guard pixel.x >= 0, pixel.y >= 0,
              pixel.x < window.width * scale, pixel.y < window.height * scale else {
            throw CoordinateError.outsideScreenshot
        }
        return Point(x: window.x + pixel.x / scale, y: window.y + pixel.y / scale)
    }
}
