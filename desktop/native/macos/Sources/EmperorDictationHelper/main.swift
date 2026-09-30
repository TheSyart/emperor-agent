import CoreAudio
import DictationCore
import DictationPlatform
import Foundation

// Emperor Dictation Helper (VO-01). Emperor's main process starts it as a
// child process and talks JSON lines over stdin/stdout (DictationProtocol).
// One dictation at a time; audio stays in memory and is dropped when the
// dictation ends; nothing is written to disk. When stdin closes (Emperor
// quit), a running dictation is cancelled and the helper exits.
//
// `--probe [file]` is experiment E-D1: print which grants this process has,
// ask for the undetermined ones, print them again, and exit. Run it once as
// Emperor's child and once through LaunchServices (`open -a … --args
// --probe /tmp/probe.json`) to see which name macOS records the grants under.
//
// `--transcribe <audio> [--locale <tag>] [--out <file>]` is experiment E-D2:
// recognize a recording on device with the engine `EMPEROR_DICTATION_ENGINE`
// selects, and print one JSON object with the text, the audio's length and
// how long recognition took. It needs Speech Recognition permission only.

/// Events to stdout, one line each, from any queue.
final class Output {
    private let lock = NSLock()

    func send(_ event: DictationEvent?) {
        guard let event else { return }
        let data = DictationCodec.encode(event)
        lock.lock()
        FileHandle.standardOutput.write(data)
        lock.unlock()
    }
}

final class ActiveDictation {
    var sequence: DictationSequence
    let engine: DictationEngine
    var timer: DispatchSourceTimer?
    var endReason: DictationEndReason?

    init(sequence: DictationSequence, engine: DictationEngine) {
        self.sequence = sequence
        self.engine = engine
    }
}

final class Controller {
    let queue = DispatchQueue(label: "com.emperor.dictation.control")
    private let output: Output
    private var active: ActiveDictation?
    /// A start waiting for the system's permission answer.
    private var pending: String?
    private var localeCache: (at: Date, engine: String, value: [DictationLocale])?
    private lazy var probeEngine: DictationEngine = Controller.makeEngine()

    init(output: Output) {
        self.output = output
    }

    static func makeEngine() -> DictationEngine {
        if ProcessInfo.processInfo.environment["EMPEROR_DICTATION_ENGINE"] == "speech-analyzer",
            #available(macOS 26.0, *)
        {
            return SpeechAnalyzerEngine()
        }
        return SpeechRecognizerEngine()
    }

    private var engineName: String { probeEngine.name }

    func handle(_ line: String) {
        let request: DictationRequest
        do {
            request = try DictationCodec.decodeRequest(Data(line.utf8))
        } catch let error as DictationProtocolError {
            output.send(.error(session: nil, seq: nil, code: .invalidRequest, message: error.message))
            return
        } catch {
            output.send(.error(session: nil, seq: nil, code: .invalidRequest, message: "\(error)"))
            return
        }
        switch request {
        case let .hello(version):
            guard version == dictationProtocolVersion else {
                output.send(.error(
                    session: nil, seq: nil, code: .invalidRequest,
                    message: "protocol \(version) is not \(dictationProtocolVersion)"))
                return
            }
            output.send(.hello(protocolVersion: dictationProtocolVersion, engine: engineName))
        case .status:
            output.send(.status(status()))
        case let .start(session, locale, device, maxSeconds):
            start(session: session, locale: locale, device: device, maxSeconds: maxSeconds)
        case let .stop(session):
            stop(session: session, reason: .stopped)
        case let .cancel(session):
            cancel(session: session)
        }
    }

    private func status() -> DictationStatus {
        DictationStatus(
            microphone: DictationPermissions.microphone(),
            speech: DictationPermissions.speech(),
            devices: AudioInputDevices.listed(),
            locales: locales(of: probeEngine),
            systemLocale: DictationLocales.system(),
            engine: engineName)
    }

    /// Reading the on-device locales asks the recognizer about every
    /// language, so a minute's answer is reused (by `status` and `start`).
    private func locales(of engine: DictationEngine) -> [DictationLocale] {
        if let cache = localeCache, cache.engine == engine.name,
            Date().timeIntervalSince(cache.at) < 60
        {
            return cache.value
        }
        let value = engine.locales()
        localeCache = (Date(), engine.name, value)
        return value
    }

    private func refuse(_ session: String, _ code: DictationErrorCode, _ message: String) {
        var sequence = DictationSequence(session: session)
        output.send(sequence.error(code, message))
        output.send(sequence.end(.error))
    }

    private func start(session: String, locale: String?, device: String?, maxSeconds: Int) {
        if pending != nil || active.map({ !$0.sequence.hasEnded }) == true {
            output.send(.error(
                session: session, seq: nil, code: .busy, message: "已有一段听写正在进行"))
            return
        }
        pending = session
        DictationPermissions.request { microphone, speech in
            self.queue.async {
                // Stopped or cancelled while macOS was asking.
                guard self.pending == session else { return }
                self.pending = nil
                guard microphone == .granted else {
                    self.refuse(session, .permissionDenied, "没有麦克风权限")
                    return
                }
                guard speech == .granted else {
                    self.refuse(session, .permissionDenied, "没有语音识别权限")
                    return
                }
                self.begin(session: session, locale: locale, device: device, maxSeconds: maxSeconds)
            }
        }
    }

    private func begin(session: String, locale: String?, device: String?, maxSeconds: Int) {
        let engine = Controller.makeEngine()
        guard let chosen = DictationLocaleMatch.resolve(
            requested: locale, systemLocale: DictationLocales.system(), available: locales(of: engine))
        else {
            refuse(session, .unsupportedLocale, "这台 Mac 不能在本机识别 \(locale ?? DictationLocales.system())")
            return
        }
        var input: AudioDeviceID?
        if let device {
            guard let found = AudioInputDevices.find(uid: device) else {
                refuse(session, .noDevice, "找不到选定的麦克风")
                return
            }
            input = found.id
        } else if AudioInputDevices.defaultInput() == nil {
            refuse(session, .noDevice, "没有可用的麦克风")
            return
        }
        let handler = DictationEngineHandler(
            partial: { text in self.queue.async { self.partial(session, text) } },
            final: { text in self.queue.async { self.finish(session, text) } },
            failure: { code, message in self.queue.async { self.fail(session, code, message) } })
        do {
            try engine.start(locale: Locale(identifier: chosen.id), device: input, handler: handler)
        } catch let error as DictationEngineError {
            refuse(session, error.code, error.message)
            return
        } catch {
            refuse(session, .failed, "\(error)")
            return
        }
        let current = ActiveDictation(sequence: DictationSequence(session: session), engine: engine)
        active = current
        output.send(current.sequence.started(locale: chosen.id))
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + .seconds(maxSeconds))
        timer.setEventHandler { [weak self] in self?.stop(session: session, reason: .maxDuration) }
        timer.resume()
        current.timer = timer
    }

    private func current(_ session: String) -> ActiveDictation? {
        guard let active, active.sequence.session == session, !active.sequence.hasEnded else {
            return nil
        }
        return active
    }

    private func partial(_ session: String, _ text: String) {
        guard let current = current(session) else { return }
        output.send(current.sequence.partial(text))
    }

    private func close(_ current: ActiveDictation, _ reason: DictationEndReason) {
        current.timer?.cancel()
        current.timer = nil
        output.send(current.sequence.end(reason))
    }

    /// A start still waiting for permission ends before any audio exists.
    private func dropPending(_ session: String) -> Bool {
        guard pending == session else { return false }
        pending = nil
        var sequence = DictationSequence(session: session)
        output.send(sequence.end(.cancelled))
        return true
    }

    private func stop(session: String, reason: DictationEndReason) {
        if reason == .stopped, dropPending(session) { return }
        guard let current = current(session) else {
            if reason == .stopped {
                output.send(.error(session: session, seq: nil, code: .notFound, message: "没有这段听写"))
            }
            return
        }
        guard current.endReason == nil else { return }
        current.endReason = reason
        current.engine.stop()
        // The final result follows; if the recognizer never delivers it, end anyway.
        queue.asyncAfter(deadline: .now() + 10) { [weak self] in
            guard let self, let late = self.current(session) else { return }
            self.close(late, reason)
        }
    }

    private func finish(_ session: String, _ text: String) {
        guard let current = current(session) else { return }
        output.send(current.sequence.final(text))
        current.engine.stop()
        close(current, current.endReason ?? .stopped)
    }

    private func fail(_ session: String, _ code: DictationErrorCode, _ message: String) {
        guard let current = current(session) else { return }
        output.send(current.sequence.error(code, message))
        current.engine.cancel()
        close(current, .error)
    }

    private func cancel(session: String) {
        if dropPending(session) { return }
        guard let current = current(session) else { return }
        current.engine.cancel()
        close(current, .cancelled)
    }

    /// stdin closed: Emperor is gone.
    func shutdown() {
        if let active, !active.sequence.hasEnded {
            active.engine.cancel()
        }
        exit(0)
    }
}

private func probe(to path: String?) {
    func report(_ stage: String) -> [String: Any] {
        [
            "stage": stage,
            "bundle": Bundle.main.bundleIdentifier ?? "none",
            "pid": Int(getpid()),
            "parent": Int(getppid()),
            "microphone": DictationPermissions.microphone().rawValue,
            "speech": DictationPermissions.speech().rawValue,
        ]
    }
    let before = report("before")
    DictationPermissions.request { _, _ in
        let lines = [before, report("after")].compactMap {
            try? JSONSerialization.data(withJSONObject: $0, options: [.sortedKeys])
        }
        let text = lines.map { String(decoding: $0, as: UTF8.self) }.joined(separator: "\n") + "\n"
        if let path {
            try? text.write(toFile: path, atomically: true, encoding: .utf8)
        } else {
            FileHandle.standardOutput.write(Data(text.utf8))
        }
        exit(0)
    }
    dispatchMain()
}

private func transcribe(_ arguments: [String]) -> Never {
    func value(after flag: String) -> String? {
        guard let index = arguments.firstIndex(of: flag), arguments.indices.contains(index + 1) else {
            return nil
        }
        return arguments[index + 1]
    }
    let output = value(after: "--out")
    let requested = value(after: "--locale")
    let lock = NSLock()
    var report: [String: Any] = [
        "requestedLocale": requested.map { $0 as Any } ?? NSNull(),
        "systemLocale": DictationLocales.system(),
    ]
    var partials = 0
    // The first answer wins; the lock is never released because the
    // process exits right after writing it.
    func finish(_ extra: [String: Any]) -> Never {
        lock.lock()
        report.merge(extra) { _, new in new }
        let data = (try? JSONSerialization.data(
            withJSONObject: report, options: [.sortedKeys, .prettyPrinted])) ?? Data()
        let text = String(decoding: data, as: UTF8.self) + "\n"
        if let output {
            try? text.write(toFile: output, atomically: true, encoding: .utf8)
        } else {
            FileHandle.standardOutput.write(Data(text.utf8))
        }
        exit(0)
    }
    func failed(_ code: String, _ message: String) -> Never {
        finish(["error": ["code": code, "message": message]])
    }
    guard let path = value(after: "--transcribe"), !path.hasPrefix("--") else {
        failed("invalid_request", "usage: --transcribe <audio> [--locale <tag>] [--out <file>]")
    }
    let file = URL(fileURLWithPath: path)
    let engine = Controller.makeEngine()
    report["engine"] = engine.name
    report["file"] = file.path
    let audioSeconds = dictationAudioSeconds(file)
    if let audioSeconds { report["audioSeconds"] = audioSeconds }
    let started = Date()
    DictationPermissions.requestSpeech { speech in
        guard speech == .granted else {
            failed("permission_denied", "speech recognition is \(speech.rawValue)")
        }
        guard let chosen = DictationLocaleMatch.resolve(
            requested: requested, systemLocale: DictationLocales.system(), available: engine.locales())
        else {
            failed("unsupported_locale", "no on-device model for \(requested ?? DictationLocales.system())")
        }
        lock.withLock { report["locale"] = chosen.id }
        let handler = DictationEngineHandler(
            partial: { _ in lock.withLock { partials += 1 } },
            final: { text in
                let count = lock.withLock { partials }
                finish([
                    "text": text,
                    "partials": count,
                    "elapsedSeconds": Date().timeIntervalSince(started),
                ])
            },
            failure: { code, message in failed(code.rawValue, message) })
        do {
            try engine.transcribe(file: file, locale: Locale(identifier: chosen.id), handler: handler)
        } catch let error as DictationEngineError {
            failed(error.code.rawValue, error.message)
        } catch {
            failed("failed", "\(error)")
        }
    }
    let limit = max(120, (audioSeconds ?? 0) * 3)
    DispatchQueue.global().asyncAfter(deadline: .now() + limit) {
        failed("timeout", "no result after \(Int(limit)) seconds")
    }
    dispatchMain()
}

let arguments = CommandLine.arguments
if let index = arguments.firstIndex(of: "--probe") {
    probe(to: arguments.indices.contains(index + 1) ? arguments[index + 1] : nil)
}
if arguments.contains("--transcribe") {
    transcribe(arguments)
}

signal(SIGPIPE, SIG_IGN)
let controller = Controller(output: Output())
DispatchQueue.global(qos: .userInitiated).async {
    while let line = readLine(strippingNewline: true) {
        if line.isEmpty { continue }
        controller.queue.async { controller.handle(line) }
    }
    controller.queue.async { controller.shutdown() }
}
dispatchMain()
