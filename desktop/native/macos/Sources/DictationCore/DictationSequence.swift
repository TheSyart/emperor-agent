/// One dictation's events, in order: `started`, any number of `partial`s
/// and `level`s, at most one `final`, then exactly one `ended`. Every event
/// carries the next sequence number. A recognizer that repeats itself (the
/// same partial twice, a second final, a partial after the final, anything
/// after the end) is filtered here, so the main process never sees it.
public struct DictationSequence: Sendable {
    public let session: String
    public private(set) var seq = 0
    public private(set) var hasFinal = false
    public private(set) var hasEnded = false
    private var hasStarted = false
    private var lastPartial: String?

    public init(session: String) {
        self.session = session
    }

    private mutating func next() -> Int {
        seq += 1
        return seq
    }

    public mutating func started(locale: String) -> DictationEvent? {
        guard !hasStarted, !hasEnded else { return nil }
        hasStarted = true
        return .started(session: session, seq: next(), locale: locale)
    }

    public mutating func partial(_ text: String) -> DictationEvent? {
        guard !hasFinal, !hasEnded, text != lastPartial else { return nil }
        lastPartial = text
        return .partial(session: session, seq: next(), text: text)
    }

    /// The microphone's loudness, clamped to 0–1 with two decimals; only
    /// while listening (after `started`, before the final result).
    public mutating func level(_ value: Double) -> DictationEvent? {
        guard hasStarted, !hasFinal, !hasEnded, value.isFinite else { return nil }
        let clamped = min(1, max(0, value))
        return .level(session: session, seq: next(), value: (clamped * 100).rounded() / 100)
    }

    public mutating func final(_ text: String) -> DictationEvent? {
        guard !hasFinal, !hasEnded else { return nil }
        hasFinal = true
        return .final(session: session, seq: next(), text: text)
    }

    public mutating func error(_ code: DictationErrorCode, _ message: String) -> DictationEvent? {
        guard !hasEnded else { return nil }
        return .error(session: session, seq: next(), code: code, message: message)
    }

    public mutating func end(_ reason: DictationEndReason) -> DictationEvent? {
        guard !hasEnded else { return nil }
        hasEnded = true
        return .ended(session: session, seq: next(), reason: reason)
    }
}
