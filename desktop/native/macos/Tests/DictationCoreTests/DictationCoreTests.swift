import Foundation
import XCTest
@testable import DictationCore

final class DictationCoreTests: XCTestCase {
    private func decode(_ json: String) throws -> DictationRequest {
        try DictationCodec.decodeRequest(Data(json.utf8))
    }

    private func object(_ event: DictationEvent) throws -> [String: Any] {
        let data = DictationCodec.encode(event)
        XCTAssertEqual(data.last, 0x0A)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data.dropLast()) as? [String: Any])
    }

    func testDecodesEveryRequest() throws {
        XCTAssertEqual(try decode(#"{"type":"hello","protocol":1}"#), .hello(protocolVersion: 1))
        XCTAssertEqual(try decode(#"{"type":"status"}"#), .status)
        XCTAssertEqual(
            try decode(#"{"type":"start","session":"3f2a9c1e-0000-4000-8000-000000000001","locale":"zh-CN","device":null,"maxSeconds":300}"#),
            .start(session: "3f2a9c1e-0000-4000-8000-000000000001", locale: "zh-CN", device: nil, maxSeconds: 300)
        )
        XCTAssertEqual(
            try decode(#"{"type":"start","session":"abcdefgh","device":"BuiltInMicrophoneDevice","maxSeconds":1}"#),
            .start(session: "abcdefgh", locale: nil, device: "BuiltInMicrophoneDevice", maxSeconds: 1)
        )
        XCTAssertEqual(try decode(#"{"type":"stop","session":"abcdefgh"}"#), .stop(session: "abcdefgh"))
        XCTAssertEqual(try decode(#"{"type":"cancel","session":"abcdefgh"}"#), .cancel(session: "abcdefgh"))
    }

    func testRejectsMalformedRequests() {
        for json in [
            "not json",
            "[]",
            #"{"session":"abcdefgh"}"#,
            #"{"type":"launch"}"#,
            #"{"type":"status","extra":true}"#,
            #"{"type":"stop","session":"short"}"#,
            #"{"type":"stop","session":"abcd efgh"}"#,
            #"{"type":"start","session":"abcdefgh","maxSeconds":0}"#,
            #"{"type":"start","session":"abcdefgh","maxSeconds":601}"#,
            #"{"type":"start","session":"abcdefgh","maxSeconds":10,"locale":"../etc"}"#,
            #"{"type":"start","session":"abcdefgh","maxSeconds":10,"device":""}"#,
        ] {
            XCTAssertThrowsError(try decode(json), json)
        }
        let long = #"{"type":"status","pad":""# + String(repeating: "x", count: dictationMaxLineBytes) + #""}"#
        XCTAssertThrowsError(try decode(long))
    }

    func testEncodesEventsAsSortedJsonLines() throws {
        let status = try object(.status(DictationStatus(
            microphone: .granted, speech: .undetermined,
            devices: [DictationDevice(id: "mic-1", name: "内建麦克风", isDefault: true)],
            locales: [DictationLocale(id: "zh-CN", name: "中文（中国大陆）")],
            systemLocale: "zh-CN", engine: "sf-speech"
        )))
        XCTAssertEqual(status["type"] as? String, "status")
        XCTAssertEqual((status["permissions"] as? [String: String])?["speech"], "undetermined")
        XCTAssertEqual(((status["devices"] as? [[String: Any]])?.first?["default"]) as? Bool, true)
        let error = try object(.error(session: nil, seq: nil, code: .unsupportedLocale, message: "no"))
        XCTAssertTrue(error["session"] is NSNull)
        XCTAssertEqual(error["code"] as? String, "unsupported_locale")
        let text = String(decoding: DictationCodec.encode(.ended(session: "abcdefgh", seq: 4, reason: .maxDuration)), as: UTF8.self)
        XCTAssertEqual(text, #"{"reason":"max_duration","seq":4,"session":"abcdefgh","type":"ended"}"# + "\n")
    }

    func testSequenceNumbersEventsAndLetsOneFinalAndOneEndThrough() {
        var sequence = DictationSequence(session: "abcdefgh")
        XCTAssertEqual(sequence.started(locale: "zh-CN"), .started(session: "abcdefgh", seq: 1, locale: "zh-CN"))
        XCTAssertNil(sequence.started(locale: "zh-CN"))
        XCTAssertEqual(sequence.partial("你"), .partial(session: "abcdefgh", seq: 2, text: "你"))
        XCTAssertNil(sequence.partial("你"), "the same partial twice is dropped")
        XCTAssertEqual(sequence.partial("你好"), .partial(session: "abcdefgh", seq: 3, text: "你好"))
        XCTAssertEqual(sequence.final("你好。"), .final(session: "abcdefgh", seq: 4, text: "你好。"))
        XCTAssertNil(sequence.final("你好。"), "a repeated final is dropped")
        XCTAssertNil(sequence.partial("你好吗"), "no partial after the final")
        XCTAssertEqual(sequence.end(.stopped), .ended(session: "abcdefgh", seq: 5, reason: .stopped))
        XCTAssertNil(sequence.end(.cancelled))
        XCTAssertNil(sequence.error(.failed, "late"))
    }

    func testResolvesTheLocaleToRecognizeOnDevice() {
        let available = [
            DictationLocale(id: "en-US", name: "English (US)"),
            DictationLocale(id: "en-GB", name: "English (UK)"),
            DictationLocale(id: "zh-CN", name: "中文（中国大陆）"),
        ]
        func resolve(_ requested: String?, system: String = "zh-Hans-CN") -> String? {
            DictationLocaleMatch.resolve(requested: requested, systemLocale: system, available: available)?.id
        }
        XCTAssertEqual(resolve(nil), "zh-CN", "the system locale, script ignored")
        XCTAssertEqual(resolve(nil, system: "en_GB"), "en-GB")
        XCTAssertEqual(resolve(nil, system: "en-AU"), "en-US", "same language when the region is missing")
        XCTAssertEqual(resolve(nil, system: "en-GB-u-mu-celsius"), "en-GB", "extensions are not a region")
        XCTAssertEqual(resolve(nil, system: "en-u-mu-celsius"), "en-US")
        XCTAssertEqual(resolve("en-GB"), "en-GB")
        XCTAssertNil(resolve("en-AU"), "a chosen locale is never swapped for another")
        XCTAssertEqual(resolve("en"), "en-US")
        XCTAssertNil(resolve(nil, system: "ja-JP"))
        XCTAssertNil(resolve("fr-FR"))
    }

    func testCancelEndsWithoutAFinal() {
        var sequence = DictationSequence(session: "abcdefgh")
        _ = sequence.started(locale: "en-US")
        _ = sequence.partial("hello")
        XCTAssertEqual(sequence.end(.cancelled), .ended(session: "abcdefgh", seq: 3, reason: .cancelled))
        XCTAssertNil(sequence.final("hello"))
        XCTAssertFalse(sequence.hasFinal)
    }

    // RV-06: the microphone's loudness, for the composer's waveform.

    func testEncodesALevelWithTwoDecimals() throws {
        let text = String(decoding: DictationCodec.encode(.level(session: "abcdefgh", seq: 3, value: 0.43)), as: UTF8.self)
        XCTAssertEqual(text, #"{"seq":3,"session":"abcdefgh","type":"level","value":0.43}"# + "\n")
        XCTAssertEqual(try object(.level(session: "abcdefgh", seq: 4, value: 1))["value"] as? Double, 1)
        XCTAssertEqual(try object(.level(session: "abcdefgh", seq: 5, value: 0))["value"] as? Double, 0)
    }

    func testSequenceSendsLevelsOnlyWhileListening() {
        var sequence = DictationSequence(session: "abcdefgh")
        XCTAssertNil(sequence.level(0.5), "no level before started")
        _ = sequence.started(locale: "zh-CN")
        XCTAssertEqual(sequence.level(0.4321), .level(session: "abcdefgh", seq: 2, value: 0.43))
        XCTAssertEqual(sequence.level(1.7), .level(session: "abcdefgh", seq: 3, value: 1))
        XCTAssertEqual(sequence.level(-0.2), .level(session: "abcdefgh", seq: 4, value: 0))
        XCTAssertNil(sequence.level(.nan))
        XCTAssertEqual(sequence.partial("你好"), .partial(session: "abcdefgh", seq: 5, text: "你好"))
        _ = sequence.final("你好。")
        XCTAssertNil(sequence.level(0.5), "the microphone is closed after the final")
        _ = sequence.end(.stopped)
        XCTAssertNil(sequence.level(0.5))
    }

    func testLevelMeterCutsAudioIntoFifteenthsOfASecond() {
        var meter = DictationLevelMeter(sampleRate: 48_000)
        XCTAssertEqual(meter.windowFrames, 3_200)
        // Whatever the buffer size, a level comes every 3,200 frames.
        XCTAssertEqual(meter.add([Float](repeating: 0, count: 4_800)), [0])
        XCTAssertEqual(meter.add([Float](repeating: 0, count: 4_800)), [0, 0])
        XCTAssertEqual(meter.add([Float](repeating: 0, count: 1_000)), [])
        XCTAssertEqual(DictationLevelMeter(sampleRate: 44_100).windowFrames, 2_940)
    }

    func testLevelMeterPutsLoudnessOnADecibelScale() {
        XCTAssertEqual(DictationLevelMeter.level(rms: 0), 0)
        XCTAssertEqual(DictationLevelMeter.level(rms: .nan), 0)
        XCTAssertEqual(DictationLevelMeter.level(rms: 0.001), 0, "-60 dB: room noise is silence")
        XCTAssertEqual(DictationLevelMeter.level(rms: 0.01), 0.25, accuracy: 0.0001, "-40 dB")
        XCTAssertEqual(DictationLevelMeter.level(rms: 0.1), 0.75, accuracy: 0.0001, "-20 dB: speech")
        XCTAssertEqual(DictationLevelMeter.level(rms: 1), 1, "full scale")
        var meter = DictationLevelMeter(sampleRate: 1_500)
        let quiet = (0..<100).map { Float($0.isMultiple(of: 2) ? 0.01 : -0.01) }
        let loud = (0..<100).map { Float($0.isMultiple(of: 2) ? 0.1 : -0.1) }
        let levels = meter.add(quiet + loud)
        XCTAssertEqual(levels.count, 2)
        XCTAssertEqual(levels[0], 0.25, accuracy: 0.0001)
        XCTAssertEqual(levels[1], 0.75, accuracy: 0.0001)
    }
}
