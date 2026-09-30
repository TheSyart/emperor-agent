import AVFoundation
import CoreAudio
import DictationCore
import Foundation
import Speech

/// macOS 26's `SpeechAnalyzer` with a `DictationTranscriber` (on device,
/// long dictation with punctuation). Experiment E-D2 compares it with
/// `SFSpeechRecognizer`; the helper uses it only when
/// `EMPEROR_DICTATION_ENGINE=speech-analyzer`, and only for locales whose
/// model is already installed (nothing is downloaded here).
@available(macOS 26.0, *)
public final class SpeechAnalyzerEngine: DictationEngine {
    public let name = "speech-analyzer"
    private let audio = AVAudioEngine()
    private let lock = NSLock()
    private var analyzer: SpeechAnalyzer?
    private var continuation: AsyncStream<AnalyzerInput>.Continuation?
    private var results: Task<Void, Never>?
    private var handler: DictationEngineHandler?
    private var finalized = ""
    private var installed: [DictationLocale] = []

    public init() {
        // Read once, synchronously enough for `locales()`.
        let semaphore = DispatchSemaphore(value: 0)
        Task {
            let locales = await DictationTranscriber.installedLocales
            self.lock.withLock { self.installed = locales.map(DictationLocales.named) }
            semaphore.signal()
        }
        _ = semaphore.wait(timeout: .now() + 5)
    }

    public func locales() -> [DictationLocale] {
        lock.withLock { installed }.sorted { $0.id < $1.id }
    }

    private static func convert(
        _ buffer: AVAudioPCMBuffer, with converter: AVAudioConverter, to format: AVAudioFormat
    ) -> AVAudioPCMBuffer? {
        let ratio = format.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio + 1)
        guard let output = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else {
            return nil
        }
        var consumed = false
        var error: NSError?
        converter.convert(to: output, error: &error) { _, status in
            if consumed {
                status.pointee = .noDataNow
                return nil
            }
            consumed = true
            status.pointee = .haveData
            return buffer
        }
        return error == nil && output.frameLength > 0 ? output : nil
    }

    public func start(locale: Locale, device: AudioDeviceID?, handler: DictationEngineHandler) throws {
        guard locales().contains(where: { $0.id == locale.identifier(.bcp47) }) else {
            throw DictationEngineError.unsupportedLocale(
                "这台 Mac 还没有 \(locale.identifier) 的本机识别模型")
        }
        if let device { try AudioInputDevices.use(device, for: audio) }
        let input = audio.inputNode
        let inputFormat = input.outputFormat(forBus: 0)
        guard inputFormat.channelCount > 0, inputFormat.sampleRate > 0 else {
            throw DictationEngineError.noDevice("没有可用的麦克风输入")
        }
        let transcriber = DictationTranscriber(locale: locale, preset: .progressiveLongDictation)
        let analyzer = SpeechAnalyzer(modules: [transcriber])
        let (stream, continuation) = AsyncStream<AnalyzerInput>.makeStream()
        lock.withLock {
            self.analyzer = analyzer
            self.continuation = continuation
            self.handler = handler
            self.finalized = ""
        }
        results = collect(transcriber, handler: handler)
        Task { [weak self] in
            guard let self else { return }
            guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]),
                let converter = AVAudioConverter(from: inputFormat, to: format)
            else {
                handler.failure(.recognizerUnavailable, "本机识别模型不可用")
                return
            }
            input.installTap(onBus: 0, bufferSize: 2048, format: inputFormat) { buffer, _ in
                if let converted = Self.convert(buffer, with: converter, to: format) {
                    continuation.yield(AnalyzerInput(buffer: converted))
                }
            }
            do {
                self.audio.prepare()
                try self.audio.start()
                try await analyzer.start(inputSequence: stream)
            } catch {
                handler.failure(.noDevice, "麦克风无法启动：\(error.localizedDescription)")
            }
        }
    }

    /// Finished segments accumulate; the volatile tail is shown after them.
    private func collect(
        _ transcriber: DictationTranscriber, handler: DictationEngineHandler
    ) -> Task<Void, Never> {
        Task { [weak self] in
            do {
                for try await result in transcriber.results {
                    guard let self else { return }
                    let text = String(result.text.characters)
                    if result.isFinal {
                        let all = self.lock.withLock { () -> String in
                            self.finalized += text
                            return self.finalized
                        }
                        handler.partial(all)
                    } else {
                        handler.partial(self.lock.withLock { self.finalized } + text)
                    }
                }
            } catch {
                handler.failure(.failed, "识别失败：\(error.localizedDescription)")
            }
        }
    }

    public func transcribe(file: URL, locale: Locale, handler: DictationEngineHandler) throws {
        guard locales().contains(where: { $0.id == locale.identifier(.bcp47) }) else {
            throw DictationEngineError.unsupportedLocale(
                "这台 Mac 还没有 \(locale.identifier) 的本机识别模型")
        }
        let audioFile: AVAudioFile
        do {
            audioFile = try AVAudioFile(forReading: file)
        } catch {
            throw DictationEngineError.unavailable("读不了这个音频文件：\(error.localizedDescription)")
        }
        let transcriber = DictationTranscriber(locale: locale, preset: .progressiveLongDictation)
        let analyzer = SpeechAnalyzer(modules: [transcriber])
        lock.withLock {
            self.analyzer = analyzer
            self.handler = handler
            self.finalized = ""
        }
        let results = collect(transcriber, handler: handler)
        self.results = results
        Task { [weak self] in
            do {
                try await analyzer.start(inputAudioFile: audioFile, finishAfterFile: true)
                await results.value
                guard let self else { return }
                handler.final(self.lock.withLock { self.finalized })
            } catch {
                handler.failure(.failed, "识别失败：\(error.localizedDescription)")
            }
        }
    }

    private func stopAudio() {
        if audio.isRunning { audio.stop() }
        audio.inputNode.removeTap(onBus: 0)
    }

    public func stop() {
        stopAudio()
        let (analyzer, continuation, handler) = lock.withLock {
            (self.analyzer, self.continuation, self.handler)
        }
        continuation?.finish()
        let results = self.results
        Task { [weak self] in
            try? await analyzer?.finalizeAndFinishThroughEndOfInput()
            await results?.value
            guard let self else { return }
            handler?.final(self.lock.withLock { self.finalized })
        }
    }

    public func cancel() {
        stopAudio()
        let (analyzer, continuation) = lock.withLock { (self.analyzer, self.continuation) }
        continuation?.finish()
        results?.cancel()
        Task { await analyzer?.cancelAndFinishNow() }
    }
}
