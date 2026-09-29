import CoreImage
import CoreMedia
import CoreVideo
import Foundation
import HelperCore
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

/// One low-rate stream per window the agent controls (E-M16). macOS marks a
/// streamed window with its purple sharing badge and lists the helper under
/// screen sharing in the menu bar, so the user sees which window is being
/// controlled and can stop it there ("Stop Sharing" reaches main as
/// `target.capture.stopped` with reason `user`, which is a takeover). Only the
/// latest complete frame is kept, for the live preview.
final class TargetCaptureStreams {
    private final class Sink: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
        private let lock = NSLock()
        private var latest: CVPixelBuffer?
        private var sequence = 0
        private var stopReason: String?

        func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
                    of type: SCStreamOutputType) {
            guard type == .screen,
                  let attachments = CMSampleBufferGetSampleAttachmentsArray(
                      sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
                  attachments.first?[.status] as? Int == SCFrameStatus.complete.rawValue,
                  let buffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
            lock.lock()
            latest = buffer
            sequence += 1
            lock.unlock()
        }

        func stream(_ stream: SCStream, didStopWithError error: any Error) {
            let failure = error as NSError
            lock.lock()
            stopReason = CaptureStreamPlan.stopReason(domain: failure.domain, code: failure.code)
            lock.unlock()
        }

        func frame() -> (sequence: Int, buffer: CVPixelBuffer?) {
            lock.lock(); defer { lock.unlock() }
            return (sequence, latest)
        }

        func takeStopReason() -> String? {
            lock.lock(); defer { lock.unlock() }
            let reason = stopReason
            stopReason = nil
            return reason
        }
    }

    private struct Wanted {
        var generation: Int
        var failures = 0
        var nextAttempt = ContinuousClock.now
    }

    private struct Running {
        let stream: SCStream
        let sink: Sink
    }

    private var wanted: [String: Wanted] = [:]
    private var running: [String: Running] = [:]
    /// Targets that received a secret: never streamed or previewed again.
    private var blocked = Set<String>()
    private var pendingEvents: [[String: Any]] = []
    private let frames = DispatchQueue(label: "emperor.capture.frames")
    private lazy var imageContext = CIContext(options: [.cacheIntermediates: false])

    /// Starts or stops the stream; returns whether one is running afterwards.
    /// A start that fails is retried with backoff while the target is wanted.
    func set(active: Bool, target: BoundTarget) async -> Bool {
        guard active else {
            wanted.removeValue(forKey: target.id)
            await stop(target.id)
            return false
        }
        guard !blocked.contains(target.id) else { return false }
        if wanted[target.id] == nil { wanted[target.id] = Wanted(generation: target.generation) }
        if running[target.id] != nil { return true }
        return await start(target)
    }

    /// Stops now and never again for this target: a secret is about to be filled.
    func block(targetID: String) async {
        blocked.insert(targetID)
        wanted.removeValue(forKey: targetID)
        await stop(targetID)
    }

    func forget(targetID: String) async {
        wanted.removeValue(forKey: targetID)
        blocked.remove(targetID)
        await stop(targetID)
    }

    /// From the helper loop: report streams the system stopped, drop streams
    /// whose target is gone, and retry failed starts after their backoff.
    func maintain(lookup: (String, Int) -> BoundTarget?) async {
        for (id, entry) in running {
            guard let reason = entry.sink.takeStopReason() else { continue }
            running.removeValue(forKey: id)
            HelperDiagnostic.emit("CAPTURE_STREAM", ["state": "stopped", "reason": reason])
            if reason == "user" {
                wanted.removeValue(forKey: id)
                pendingEvents.append(["type": "event", "name": "target.capture.stopped",
                                      "data": ["targetId": id, "reason": "user"]])
            } else {
                failed(id)
            }
        }
        for (id, want) in wanted {
            guard let target = lookup(id, want.generation) else {
                wanted.removeValue(forKey: id)
                await stop(id)
                continue
            }
            if running[id] == nil && ContinuousClock.now >= want.nextAttempt {
                _ = await start(target)
            }
        }
    }

    func drainEvents() -> [[String: Any]] {
        defer { pendingEvents = [] }
        return pendingEvents
    }

    /// The latest frame as JPEG, only when it is newer than `afterSeq`.
    func preview(targetID: String, maxEdge: Int,
                 afterSeq: Int?) -> (sequence: Int, jpeg: Data?, width: Int, height: Int)? {
        guard !blocked.contains(targetID), let entry = running[targetID] else { return nil }
        let (sequence, buffer) = entry.sink.frame()
        guard let buffer, sequence > (afterSeq ?? -1) else { return (sequence, nil, 0, 0) }
        let image = CIImage(cvPixelBuffer: buffer)
        let longest = max(image.extent.width, image.extent.height)
        guard longest > 0 else { return (sequence, nil, 0, 0) }
        let scale = min(1, CGFloat(maxEdge) / longest)
        let scaled = image.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        let data = NSMutableData()
        guard let cgImage = imageContext.createCGImage(scaled, from: scaled.extent),
              let destination = CGImageDestinationCreateWithData(
                  data, UTType.jpeg.identifier as CFString, 1, nil) else { return (sequence, nil, 0, 0) }
        CGImageDestinationAddImage(destination, cgImage,
                                   [kCGImageDestinationLossyCompressionQuality: 0.7] as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { return (sequence, nil, 0, 0) }
        return (sequence, data as Data, cgImage.width, cgImage.height)
    }

    private func start(_ target: BoundTarget) async -> Bool {
        do {
            let (window, frame) = try await ScreenCapture.shareableWindow(for: target)
            let size = CaptureStreamPlan.size(width: frame.width, height: frame.height)
            let configuration = SCStreamConfiguration()
            configuration.width = size.width
            configuration.height = size.height
            configuration.minimumFrameInterval = CMTime(
                value: 1, timescale: CMTimeScale(CaptureStreamPlan.framesPerSecond))
            configuration.showsCursor = false
            configuration.queueDepth = 3
            configuration.pixelFormat = kCVPixelFormatType_32BGRA
            let sink = Sink()
            let stream = SCStream(filter: SCContentFilter(desktopIndependentWindow: window),
                                  configuration: configuration, delegate: sink)
            try stream.addStreamOutput(sink, type: .screen, sampleHandlerQueue: frames)
            try await stream.startCapture()
            running[target.id] = Running(stream: stream, sink: sink)
            wanted[target.id]?.failures = 0
            HelperDiagnostic.emit("CAPTURE_STREAM", ["state": "started"])
            return true
        } catch {
            failed(target.id)
            HelperDiagnostic.emit("CAPTURE_STREAM", ["state": "start-failed"])
            return false
        }
    }

    private func failed(_ id: String) {
        guard var want = wanted[id] else { return }
        want.failures += 1
        want.nextAttempt = ContinuousClock.now.advanced(
            by: .seconds(CaptureStreamPlan.retryDelay(failures: want.failures)))
        wanted[id] = want
    }

    private func stop(_ id: String) async {
        guard let entry = running.removeValue(forKey: id) else { return }
        try? await entry.stream.stopCapture()
    }
}
