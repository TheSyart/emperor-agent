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
}
