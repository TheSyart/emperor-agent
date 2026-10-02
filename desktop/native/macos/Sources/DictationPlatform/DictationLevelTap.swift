import AVFoundation
import DictationCore

/// The microphone's loudness, measured in an engine's input tap (RV-06):
/// the first channel of each buffer goes through a `DictationLevelMeter`.
/// The tap delivers one buffer at a time on its audio thread, which is the
/// only caller.
final class DictationLevelTap {
    private var meter: DictationLevelMeter

    init(sampleRate: Double) {
        meter = DictationLevelMeter(sampleRate: sampleRate)
    }

    /// Levels completed by this buffer; none for a format without floats.
    func levels(of buffer: AVAudioPCMBuffer) -> [Double] {
        guard let channels = buffer.floatChannelData, buffer.format.channelCount > 0 else {
            return []
        }
        // Interleaved buffers keep every channel in the first pointer.
        let step = max(1, buffer.stride)
        let samples = UnsafeBufferPointer(start: channels[0], count: Int(buffer.frameLength) * step)
        return meter.add(stride(from: 0, to: samples.count, by: step).lazy.map { samples[$0] })
    }
}
