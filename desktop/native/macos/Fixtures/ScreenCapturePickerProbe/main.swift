import AppKit
import CoreGraphics
import CoreMedia
import Foundation
import ScreenCaptureKit
import Security

// E-M3b and E-M16 only. This app records permission status, frame counts and
// stream errors, never pixels.
private struct SelectedFilter: @unchecked Sendable {
    // The picker transfers this immutable selection to the main actor; the
    // probe never changes the filter after receiving it.
    let value: SCContentFilter
}

/// Counts complete frames and reports status changes and the stop reason.
private final class FrameSink: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private var complete = 0
    private var lastStatus = -1
    private let onStatus: @Sendable (Int) -> Void
    private let onStop: @Sendable (String, Int) -> Void

    init(onStatus: @escaping @Sendable (Int) -> Void, onStop: @escaping @Sendable (String, Int) -> Void) {
        self.onStatus = onStatus
        self.onStop = onStop
    }

    var frames: Int { lock.lock(); defer { lock.unlock() }; return complete }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
                of type: SCStreamOutputType) {
        guard type == .screen,
              let attachments = CMSampleBufferGetSampleAttachmentsArray(
                  sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let raw = attachments.first?[.status] as? Int else { return }
        lock.lock()
        if raw == SCFrameStatus.complete.rawValue { complete += 1 }
        let changed = raw != lastStatus
        lastStatus = raw
        lock.unlock()
        if changed { onStatus(raw) }
    }

    func stream(_ stream: SCStream, didStopWithError error: any Error) {
        let failure = error as NSError
        onStop(failure.domain, failure.code)
    }
}

@MainActor
final class PickerProbe: NSObject, NSApplicationDelegate {
    private let picker = SCContentSharingPicker.shared
    private var window: NSWindow?
    private var statusLabel: NSTextField?
    private let logURL = URL(fileURLWithPath: "/tmp/emperor-cu-picker-probe.jsonl")
    private var stream: SCStream?
    private var sink: FrameSink?
    private var mode = ""
    private var ticker: Timer?
    private var startedAt = Date()
    private var cpuAtStart = 0.0

    func applicationDidFinishLaunching(_ notification: Notification) {
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 520, height: 220),
                              styleMask: [.titled, .closable, .miniaturizable],
                              backing: .buffered, defer: false)
        window.title = "Emperor Capture Picker Probe"
        window.center()

        let label = NSTextField(labelWithString: "Choose the Emperor AX Fixture window only.")
        label.frame = NSRect(x: 24, y: 150, width: 472, height: 24)
        let choose = NSButton(title: "Choose fixture window", target: self,
                              action: #selector(showPicker))
        choose.frame = NSRect(x: 24, y: 96, width: 220, height: 32)
        let direct = NSButton(title: "Stream fixture directly", target: self,
                              action: #selector(streamDirectly))
        direct.frame = NSRect(x: 260, y: 96, width: 220, height: 32)
        let stop = NSButton(title: "Stop stream", target: self, action: #selector(stopStream))
        stop.frame = NSRect(x: 24, y: 44, width: 220, height: 32)
        for view in [label, choose, direct, stop] { window.contentView?.addSubview(view) }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        self.window = window
        statusLabel = label

        var configuration = SCContentSharingPickerConfiguration()
        configuration.allowedPickerModes = .singleWindow
        picker.defaultConfiguration = configuration
        picker.add(self)
        picker.isActive = true
        record("launched", ["screenRecordingGranted": CGPreflightScreenCaptureAccess()])
    }

    func applicationWillTerminate(_ notification: Notification) {
        picker.remove(self)
        picker.isActive = false
    }

    @objc private func showPicker() {
        record("picker-presented", ["screenRecordingGranted": CGPreflightScreenCaptureAccess()])
        picker.present(using: .window)
    }

    /// E-M16 ①: the filter the Helper would build itself, without the picker.
    @objc private func streamDirectly() {
        Task { @MainActor in
            do {
                let content = try await SCShareableContent.excludingDesktopWindows(
                    false, onScreenWindowsOnly: true)
                let matches = content.windows.filter {
                    $0.owningApplication?.bundleIdentifier == "com.emperor.agent.axfixture" &&
                        $0.title == "Emperor AX Fixture"
                }
                guard matches.count == 1, let target = matches.first,
                      let owner = target.owningApplication,
                      isSignedFixture(pid: owner.processID) else {
                    record("direct-rejected", ["matches": matches.count,
                                               "screenRecordingGranted": CGPreflightScreenCaptureAccess()])
                    statusLabel?.stringValue = "Open the signed fixture window on this desktop first."
                    return
                }
                await start(SCContentFilter(desktopIndependentWindow: target), mode: "direct",
                            frame: target.frame)
            } catch {
                let failure = error as NSError
                record("direct-failed", ["errorDomain": failure.domain, "errorCode": failure.code,
                                         "screenRecordingGranted": CGPreflightScreenCaptureAccess()])
                statusLabel?.stringValue = "Direct stream failed; inspect log."
            }
        }
    }

    /// E-M16 ②: the picker's filter, now kept as a continuous stream.
    func capture(_ filter: SCContentFilter) {
        let before = CGPreflightScreenCaptureAccess()
        let windows = filter.includedWindows
        guard filter.style == .window, windows.count == 1,
              let owner = windows[0].owningApplication,
              owner.bundleIdentifier == "com.emperor.agent.axfixture",
              isSignedFixture(pid: owner.processID) else {
            record("selection-rejected", ["screenRecordingGranted": before,
                                          "reason": "fixture-identity-unverified"])
            statusLabel?.stringValue = "Select only the Emperor AX Fixture window."
            return
        }
        record("picker-selected", ["screenRecordingGranted": before, "fixtureWindow": true])
        let frame = windows[0].frame
        Task { @MainActor in await start(filter, mode: "picker", frame: frame) }
    }

    private func start(_ filter: SCContentFilter, mode: String, frame: CGRect) async {
        await stopCurrent(reason: "replaced")
        let configuration = SCStreamConfiguration()
        let scale = min(1.0, 640.0 / max(frame.width, frame.height, 1))
        configuration.width = max(2, Int(frame.width * scale))
        configuration.height = max(2, Int(frame.height * scale))
        configuration.minimumFrameInterval = CMTime(value: 1, timescale: 2)
        configuration.showsCursor = false
        configuration.queueDepth = 3
        let sink = FrameSink(
            onStatus: { status in
                Task { @MainActor [weak self] in self?.record("frame-status", ["status": status]) }
            },
            onStop: { domain, code in
                Task { @MainActor [weak self] in self?.stoppedBySystem(domain: domain, code: code) }
            })
        let stream = SCStream(filter: filter, configuration: configuration, delegate: sink)
        do {
            try stream.addStreamOutput(sink, type: .screen,
                                       sampleHandlerQueue: DispatchQueue(label: "probe.frames"))
            try await stream.startCapture()
        } catch {
            let failure = error as NSError
            record("stream-failed", ["mode": mode, "errorDomain": failure.domain, "errorCode": failure.code])
            statusLabel?.stringValue = "Stream failed; inspect log."
            return
        }
        self.stream = stream
        self.sink = sink
        self.mode = mode
        startedAt = Date()
        cpuAtStart = Self.cpuSeconds()
        record("stream-started", ["mode": mode, "width": configuration.width,
                                  "height": configuration.height,
                                  "screenRecordingGranted": CGPreflightScreenCaptureAccess()])
        statusLabel?.stringValue = "Streaming (\(mode)). Look at the fixture title bar and the menu bar."
        ticker = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { _ in
            Task { @MainActor [weak self] in self?.tick() }
        }
    }

    private func tick() {
        guard let sink else { return }
        record("stream-tick", ["mode": mode, "frames": sink.frames,
                               "seconds": Int(Date().timeIntervalSince(startedAt))])
    }

    @objc private func stopStream() {
        Task { @MainActor in await stopCurrent(reason: "probe-button") }
    }

    private func stopCurrent(reason: String) async {
        guard let stream else { return }
        ticker?.invalidate()
        ticker = nil
        try? await stream.stopCapture()
        finish(reason: reason, extra: [:])
    }

    private func stoppedBySystem(domain: String, code: Int) {
        guard stream != nil else { return }
        ticker?.invalidate()
        ticker = nil
        finish(reason: "system", extra: ["errorDomain": domain, "errorCode": code])
        statusLabel?.stringValue = "The system stopped the stream (\(code)); inspect log."
    }

    private func finish(reason: String, extra: [String: Any]) {
        let seconds = max(0.001, Date().timeIntervalSince(startedAt))
        var fields: [String: Any] = [
            "mode": mode, "reason": reason, "frames": sink?.frames ?? 0,
            "seconds": Int(seconds),
            "cpuPercent": Int(((Self.cpuSeconds() - cpuAtStart) / seconds * 100).rounded()),
        ]
        fields.merge(extra) { _, new in new }
        record("stream-stopped", fields)
        stream = nil
        sink = nil
        if reason != "system" { statusLabel?.stringValue = "Stream stopped." }
    }

    private static func cpuSeconds() -> Double {
        var usage = rusage()
        getrusage(RUSAGE_SELF, &usage)
        let user = Double(usage.ru_utime.tv_sec) + Double(usage.ru_utime.tv_usec) / 1_000_000
        let system = Double(usage.ru_stime.tv_sec) + Double(usage.ru_stime.tv_usec) / 1_000_000
        return user + system
    }

    func cancelled() {
        record("picker-cancelled", ["screenRecordingGranted": CGPreflightScreenCaptureAccess()])
        statusLabel?.stringValue = "Selection cancelled."
    }

    func pickerFailed(domain: String, code: Int) {
        record("picker-failed", ["errorDomain": domain,
                                  "errorCode": code,
                                  "screenRecordingGranted": CGPreflightScreenCaptureAccess()])
        statusLabel?.stringValue = "Picker failed; inspect log."
    }

    private func signedTeam(for code: SecCode, identifier: String) -> String? {
        guard SecCodeCheckValidity(code, [], nil) == errSecSuccess else { return nil }
        var staticCode: SecStaticCode?
        guard SecCodeCopyStaticCode(code, [], &staticCode) == errSecSuccess,
              let staticCode else { return nil }
        var details: CFDictionary?
        guard SecCodeCopySigningInformation(staticCode,
                  SecCSFlags(rawValue: kSecCSSigningInformation), &details) == errSecSuccess,
              let info = details as? [String: Any],
              info[kSecCodeInfoIdentifier as String] as? String == identifier,
              let flags = info[kSecCodeInfoFlags as String] as? NSNumber,
              flags.uint32Value & 0x2 == 0,
              let team = info[kSecCodeInfoTeamIdentifier as String] as? String,
              !team.isEmpty else { return nil }
        return team
    }

    private func isSignedFixture(pid: pid_t) -> Bool {
        let expectedApp = Bundle.main.bundleURL.deletingLastPathComponent()
            .appendingPathComponent("EmperorAXFixture.app")
            .resolvingSymlinksInPath().standardizedFileURL
        guard let running = NSRunningApplication(processIdentifier: pid),
              running.bundleIdentifier == "com.emperor.agent.axfixture",
              running.bundleURL?.resolvingSymlinksInPath().standardizedFileURL == expectedApp,
              running.executableURL?.resolvingSymlinksInPath().standardizedFileURL ==
                expectedApp.appendingPathComponent("Contents/MacOS/EmperorAXFixture"),
              let selfCode = ownCode(),
              let ownTeam = signedTeam(for: selfCode,
                                       identifier: "com.emperor.agent.capturepickerprobe") else {
            return false
        }
        var guestCode: SecCode?
        let attributes = [kSecGuestAttributePid as String: NSNumber(value: pid)] as CFDictionary
        guard SecCodeCopyGuestWithAttributes(nil, attributes, [], &guestCode) == errSecSuccess,
              let guestCode,
              signedTeam(for: guestCode, identifier: "com.emperor.agent.axfixture") == ownTeam else {
            return false
        }
        return true
    }

    private func ownCode() -> SecCode? {
        var code: SecCode?
        return SecCodeCopySelf([], &code) == errSecSuccess ? code : nil
    }

    private func record(_ event: String, _ fields: [String: Any]) {
        var row = fields
        row["event"] = event
        row["pid"] = ProcessInfo.processInfo.processIdentifier
        row["at"] = ISO8601DateFormatter().string(from: Date())
        guard let bytes = try? JSONSerialization.data(withJSONObject: row),
              var line = String(data: bytes, encoding: .utf8) else { return }
        line += "\n"
        let data = Data(line.utf8)
        if !FileManager.default.fileExists(atPath: logURL.path) {
            FileManager.default.createFile(atPath: logURL.path, contents: nil)
        }
        guard let file = try? FileHandle(forWritingTo: logURL) else { return }
        defer { try? file.close() }
        _ = try? file.seekToEnd()
        try? file.write(contentsOf: data)
    }
}

extension PickerProbe: SCContentSharingPickerObserver {
    nonisolated func contentSharingPicker(_ picker: SCContentSharingPicker,
                                          didUpdateWith filter: SCContentFilter,
                                          for stream: SCStream?) {
        let selected = SelectedFilter(value: filter)
        Task { @MainActor [weak self] in self?.capture(selected.value) }
    }

    nonisolated func contentSharingPicker(_ picker: SCContentSharingPicker,
                                          didCancelFor stream: SCStream?) {
        Task { @MainActor [weak self] in self?.cancelled() }
    }

    nonisolated func contentSharingPickerStartDidFailWithError(_ error: any Error) {
        let failure = error as NSError
        let domain = failure.domain
        let code = failure.code
        Task { @MainActor [weak self] in self?.pickerFailed(domain: domain, code: code) }
    }
}

let app = NSApplication.shared
let delegate = PickerProbe()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
