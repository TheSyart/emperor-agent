import Foundation

/// Helper-side heartbeat accounting (00 §11). One ping is due per interval;
/// the peer is lost after `maxMissed` consecutive unanswered pings, that is,
/// when the next ping falls due while that many are still outstanding.
public struct HeartbeatTracker: Sendable {
    public let maxMissed: Int
    public private(set) var outstanding = 0
    private var lastSent = 0
    private var lastAcknowledged = 0

    public init(maxMissed: Int = 3) {
        self.maxMissed = max(1, maxMissed)
    }

    /// The sequence number of the ping now due, or nil when the peer has
    /// missed `maxMissed` heartbeats in a row and must be treated as lost.
    public mutating func nextPing() -> Int? {
        guard outstanding < maxMissed else { return nil }
        lastSent += 1
        outstanding += 1
        return lastSent
    }

    /// A pong for an outstanding ping clears that ping and every earlier one.
    /// Pings sent after it stay outstanding; duplicate, stale, or never-sent
    /// sequence numbers are ignored.
    public mutating func acknowledge(_ seq: Int) {
        guard seq > lastAcknowledged, seq <= lastSent else { return }
        lastAcknowledged = seq
        outstanding = lastSent - seq
    }
}
