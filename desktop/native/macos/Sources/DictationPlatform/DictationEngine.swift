import AVFoundation
import CoreAudio
import DictationCore
import Speech

/// What an engine reports. Callbacks may arrive on any queue; the helper's
/// controller moves them onto its own.
public struct DictationEngineHandler {
    public let partial: (String) -> Void
    public let final: (String) -> Void
    public let failure: (DictationErrorCode, String) -> Void
    /// The microphone's loudness (0–1), about 15 times a second while it is
    /// open (RV-06); a recognized file reports none.
    public let level: (Double) -> Void

    public init(
        partial: @escaping (String) -> Void,
        final: @escaping (String) -> Void,
        failure: @escaping (DictationErrorCode, String) -> Void,
        level: @escaping (Double) -> Void = { _ in }
    ) {
        self.partial = partial
        self.final = final
        self.failure = failure
        self.level = level
    }
}

public enum DictationEngineError: Error {
    case noDevice(String)
    case unsupportedLocale(String)
    case unavailable(String)

    public var code: DictationErrorCode {
        switch self {
        case .noDevice: return .noDevice
        case .unsupportedLocale: return .unsupportedLocale
        case .unavailable: return .recognizerUnavailable
        }
    }

    public var message: String {
        switch self {
        case let .noDevice(text), let .unsupportedLocale(text), let .unavailable(text): return text
        }
    }
}

/// One recognizer behind the microphone. `start` begins capturing; `stop`
/// ends the audio and lets the final result arrive; `cancel` drops it.
public protocol DictationEngine: AnyObject {
    var name: String { get }
    /// Locales this engine recognizes on device right now.
    func locales() -> [DictationLocale]
    func start(locale: Locale, device: AudioDeviceID?, handler: DictationEngineHandler) throws
    func stop()
    func cancel()
    /// Experiment E-D2: recognize a recorded file on device, the same way.
    func transcribe(file: URL, locale: Locale, handler: DictationEngineHandler) throws
}

/// Length of an audio file in seconds, when it can be read.
public func dictationAudioSeconds(_ file: URL) -> Double? {
    guard let audio = try? AVAudioFile(forReading: file), audio.processingFormat.sampleRate > 0 else {
        return nil
    }
    return Double(audio.length) / audio.processingFormat.sampleRate
}

/// `SFSpeechRecognizer` with on-device recognition required: audio never
/// leaves the Mac. Available on macOS 14 and later.
public final class SpeechRecognizerEngine: DictationEngine {
    public let name = "sf-speech"
    private let audio = AVAudioEngine()
    private var recognizer: SFSpeechRecognizer?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var cancelled = false

    public init() {}

    /// On device only: without the network nothing changes, and no audio
    /// is sent to a server.
    static func makeRequest() -> SFSpeechAudioBufferRecognitionRequest {
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.requiresOnDeviceRecognition = true
        request.shouldReportPartialResults = true
        request.addsPunctuation = true
        return request
    }

    public func locales() -> [DictationLocale] {
        DictationLocales.onDevice()
    }

    private func onDeviceRecognizer(_ locale: Locale) throws -> SFSpeechRecognizer {
        guard let recognizer = SFSpeechRecognizer(locale: locale),
            recognizer.supportsOnDeviceRecognition
        else {
            throw DictationEngineError.unsupportedLocale("这台 Mac 不能在本机识别 \(locale.identifier)")
        }
        guard recognizer.isAvailable else {
            throw DictationEngineError.unavailable("语音识别暂时不可用")
        }
        return recognizer
    }

    private func resultHandler(
        _ handler: DictationEngineHandler
    ) -> (SFSpeechRecognitionResult?, Error?) -> Void {
        { [weak self] result, error in
            guard let self, !self.cancelled else { return }
            if let result {
                let text = result.bestTranscription.formattedString
                if result.isFinal {
                    handler.final(text)
                    return
                }
                handler.partial(text)
            }
            if let error = error as NSError? {
                // 1110: no speech was detected — an empty final, not a failure.
                if error.domain == "kAFAssistantErrorDomain", error.code == 1110 {
                    handler.final("")
                } else {
                    handler.failure(.failed, "识别失败：\(error.localizedDescription)")
                }
            }
        }
    }

    public func transcribe(file: URL, locale: Locale, handler: DictationEngineHandler) throws {
        let recognizer = try onDeviceRecognizer(locale)
        let request = SFSpeechURLRecognitionRequest(url: file)
        request.requiresOnDeviceRecognition = true
        request.shouldReportPartialResults = true
        request.addsPunctuation = true
        self.recognizer = recognizer
        cancelled = false
        task = recognizer.recognitionTask(with: request, resultHandler: resultHandler(handler))
    }

    public func start(locale: Locale, device: AudioDeviceID?, handler: DictationEngineHandler) throws {
        let recognizer = try onDeviceRecognizer(locale)
        if let device { try AudioInputDevices.use(device, for: audio) }
        let input = audio.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.channelCount > 0, format.sampleRate > 0 else {
            throw DictationEngineError.noDevice("没有可用的麦克风输入")
        }
        let request = Self.makeRequest()
        self.recognizer = recognizer
        self.request = request
        cancelled = false
        let meter = DictationLevelTap(sampleRate: format.sampleRate)
        input.installTap(onBus: 0, bufferSize: 2048, format: format) { buffer, _ in
            request.append(buffer)
            for value in meter.levels(of: buffer) { handler.level(value) }
        }
        audio.prepare()
        do {
            try audio.start()
        } catch {
            input.removeTap(onBus: 0)
            throw DictationEngineError.noDevice("麦克风无法启动：\(error.localizedDescription)")
        }
        task = recognizer.recognitionTask(with: request, resultHandler: resultHandler(handler))
    }

    private func stopAudio() {
        if audio.isRunning { audio.stop() }
        audio.inputNode.removeTap(onBus: 0)
    }

    public func stop() {
        stopAudio()
        request?.endAudio()
    }

    public func cancel() {
        cancelled = true
        task?.cancel()
        stopAudio()
    }
}
