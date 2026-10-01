import AVFoundation
import Speech
import XCTest
@testable import DictationPlatform

final class DictationPlatformTests: XCTestCase {
    /// Offline or not, recognition never falls back to Apple's servers.
    func testRecognitionRequestStaysOnDevice() {
        let request = SpeechRecognizerEngine.makeRequest()
        XCTAssertTrue(request.requiresOnDeviceRecognition)
        XCTAssertTrue(request.shouldReportPartialResults)
        XCTAssertTrue(request.addsPunctuation)
    }

    /// A buffer as the input tap delivers it, every sample of the first
    /// channel at `first`, of the others at `other` (no microphone needed).
    private func buffer(
        frames: Int, channels: AVAudioChannelCount, interleaved: Bool, first: Float, other: Float = 0
    ) throws -> AVAudioPCMBuffer {
        let format = try XCTUnwrap(AVAudioFormat(
            commonFormat: .pcmFormatFloat32, sampleRate: 48_000, channels: channels, interleaved: interleaved))
        let buffer = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames)))
        buffer.frameLength = AVAudioFrameCount(frames)
        let data = try XCTUnwrap(buffer.floatChannelData)
        if interleaved {
            for index in 0..<(frames * Int(channels)) {
                data[0][index] = index % Int(channels) == 0 ? first : other
            }
        } else {
            for channel in 0..<Int(channels) {
                for frame in 0..<frames { data[channel][frame] = channel == 0 ? first : other }
            }
        }
        return buffer
    }

    /// RV-06: the tap measures the first channel, a level per 1/15 second.
    func testLevelTapMeasuresTheFirstChannel() throws {
        let tap = DictationLevelTap(sampleRate: 48_000)
        let mono = try buffer(frames: 4_800, channels: 1, interleaved: false, first: 0.1)
        let levels = tap.levels(of: mono)
        XCTAssertEqual(levels.count, 1)
        XCTAssertEqual(levels[0], 0.75, accuracy: 0.0001)
        // The 1,600 frames left over count towards the next level.
        XCTAssertEqual(tap.levels(of: mono).count, 2)

        let stereo = DictationLevelTap(sampleRate: 48_000)
        let interleaved = try buffer(frames: 3_200, channels: 2, interleaved: true, first: 0.01, other: 1)
        XCTAssertEqual(stereo.levels(of: interleaved).first ?? -1, 0.25, accuracy: 0.0001)
        let planar = try buffer(frames: 3_200, channels: 2, interleaved: false, first: 0.01, other: 1)
        XCTAssertEqual(stereo.levels(of: planar).first ?? -1, 0.25, accuracy: 0.0001)
    }
}
