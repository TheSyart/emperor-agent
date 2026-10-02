import Foundation

/// How loud the microphone is, for the waveform in Emperor's composer
/// (RV-06). Audio is cut into windows of `sampleRate / perSecond` frames,
/// whatever buffer size the audio engine delivers, so a level comes about
/// `perSecond` times a second. Each window's RMS goes on a decibel scale
/// and maps to 0–1: `floorDecibels` and quieter (room noise) is 0,
/// `ceilingDecibels` and louder is 1. Only these numbers leave the helper,
/// never the audio.
public struct DictationLevelMeter: Sendable {
    public static let perSecond = 15.0
    public static let floorDecibels = -50.0
    public static let ceilingDecibels = -10.0

    /// Frames in one window.
    public let windowFrames: Int
    private var frames = 0
    private var squares = 0.0

    public init(sampleRate: Double, perSecond: Double = DictationLevelMeter.perSecond) {
        let window = sampleRate / perSecond
        windowFrames = window.isFinite && window >= 1 ? Int(window.rounded()) : 1
    }

    /// Adds one channel's samples and answers the level of every window
    /// they complete (none, one, or a few for a long buffer).
    public mutating func add<Samples: Sequence>(_ samples: Samples) -> [Double]
    where Samples.Element == Float {
        var levels: [Double] = []
        for sample in samples {
            let value = Double(sample)
            if value.isFinite { squares += value * value }
            frames += 1
            if frames == windowFrames {
                levels.append(Self.level(rms: (squares / Double(frames)).squareRoot()))
                frames = 0
                squares = 0
            }
        }
        return levels
    }

    /// 0–1 for an RMS amplitude, where 1 is full scale.
    public static func level(rms: Double) -> Double {
        guard rms.isFinite, rms > 0 else { return 0 }
        let decibels = 20 * log10(rms)
        return min(1, max(0, (decibels - floorDecibels) / (ceilingDecibels - floorDecibels)))
    }
}
