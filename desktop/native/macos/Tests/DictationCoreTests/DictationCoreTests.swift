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
}
