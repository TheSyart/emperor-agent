import AppKit
import CoreGraphics
import Foundation
import HelperCore
import ScreenCaptureKit

public struct CapturedScreenshot {
    public let result: [String: Any]
    public let blobs: [(String, Data)]
}

public enum ScreenCapture {
    /// The bound AX window as a capturable ScreenCaptureKit window: the one
    /// on-screen window with the same owner, title and frame.
    static func shareableWindow(for target: BoundTarget) async throws -> (window: SCWindow, frame: Rect) {
        try DesktopPermissions.requireAccessibility()
        try DesktopPermissions.requireScreenRecording()
        guard !DesktopCatalog.bool(target.element, "AXMinimized"),
              let frame = target.frame, frame.width > 0, frame.height > 0 else {
            throw NativeError.denied(code: "TARGET_NOT_VISIBLE", message: "Window cannot be captured")
        }
        let shareable = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        let candidates = shareable.windows.compactMap { window -> ScreenshotWindow? in
            guard let owner = window.owningApplication else { return nil }
            let rect = window.frame
            return ScreenshotWindow(id: window.windowID, pid: owner.processID,
                                    title: window.title ?? "",
                                    frame: Rect(x: rect.minX, y: rect.minY,
                                                width: rect.width, height: rect.height))
        }
        let fingerprint = WindowFingerprint(pid: target.pid, title: target.title, frame: frame)
        guard let windowID = WindowMatcher.screenshotWindowID(
                  ax: fingerprint, boundID: target.cgWindowID,
                  cgCandidates: CGWindowInventory.current(), scCandidates: candidates),
              let window = shareable.windows.first(where: { $0.windowID == windowID }),
              window.isOnScreen else {
            HelperDiagnostic.emit("SCREENSHOT_NO_MATCH", [
                "boundID": target.cgWindowID == nil ? "none" : "set",
                "pidWindows": String(candidates.filter { $0.pid == target.pid }.count),
            ])
            throw NativeError.denied(code: "TARGET_NOT_VISIBLE", message: "AX window has no unique visible screenshot match")
        }
        return (window, frame)
    }

    public static func capture(target: BoundTarget, modelCopy: Bool, modelMaxEdge: Int) async throws -> CapturedScreenshot {
        guard (64...4_096).contains(modelMaxEdge) else {
            throw NativeError.denied(code: "TARGET_NOT_VISIBLE", message: "Window cannot be captured")
        }
        let (window, frame) = try await shareableWindow(for: target)
        let scale = try displayScale(for: frame)
        guard scale.isFinite, scale > 0 else {
            throw NativeError.denied(code: "DRIVER_UNAVAILABLE", message: "Invalid display scale")
        }
        let scaledWidth = frame.width * scale, scaledHeight = frame.height * scale
        guard scaledWidth.isFinite, scaledHeight.isFinite,
              scaledWidth >= 1, scaledHeight >= 1,
              scaledWidth <= 16_384, scaledHeight <= 16_384,
              scaledWidth * scaledHeight <= 100_000_000 else {
            throw NativeError.denied(code: "BUDGET_EXCEEDED", message: "Screenshot dimensions exceed budget")
        }
        let width = Int(scaledWidth.rounded()), height = Int(scaledHeight.rounded())
        let config = SCStreamConfiguration()
        config.width = width
        config.height = height
        config.showsCursor = false
        let filter = SCContentFilter(desktopIndependentWindow: window)
        let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
        let bitmap = NSBitmapImageRep(cgImage: image)
        guard let original = bitmap.representation(using: .png, properties: [:]),
              original.count <= Framing.maxFrameBytes - 66 else {
            throw NativeError.denied(code: "BUDGET_EXCEEDED", message: "Screenshot exceeds transport limit")
        }
        let screenshotID = "s-" + UUID().uuidString
        let blobID = "b-" + UUID().uuidString
        var result: [String: Any] = [
            "screenshotId": screenshotID, "generation": target.generation,
            "revision": target.revision, "width": image.width, "height": image.height,
            "scale": Double(image.width) / frame.width, "blobId": blobID,
        ]
        var blobs = [(blobID, original)]
        if modelCopy {
            let factor = min(1.0, Double(modelMaxEdge) / Double(max(image.width, image.height)))
            let modelWidth = max(1, Int((Double(image.width) * factor).rounded()))
            let modelHeight = max(1, Int((Double(image.height) * factor).rounded()))
            let modelBitmap = NSBitmapImageRep(
                bitmapDataPlanes: nil, pixelsWide: modelWidth, pixelsHigh: modelHeight,
                bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)
            guard let modelBitmap, let graphics = NSGraphicsContext(bitmapImageRep: modelBitmap) else {
                throw NativeError.denied(code: "DRIVER_UNAVAILABLE", message: "Cannot resize screenshot")
            }
            NSGraphicsContext.saveGraphicsState()
            NSGraphicsContext.current = graphics
            graphics.imageInterpolation = .high
            NSImage(cgImage: image, size: NSSize(width: modelWidth, height: modelHeight))
                .draw(in: NSRect(x: 0, y: 0, width: modelWidth, height: modelHeight))
            graphics.flushGraphics()
            NSGraphicsContext.restoreGraphicsState()
            guard let jpeg = modelBitmap.representation(using: .jpeg,
                                                         properties: [.compressionFactor: 0.8]),
                  jpeg.count <= Framing.maxFrameBytes - 66 else {
                throw NativeError.denied(code: "BUDGET_EXCEEDED", message: "Model screenshot exceeds transport limit")
            }
            let modelBlobID = "b-" + UUID().uuidString
            result["model"] = ["blobId": modelBlobID, "width": modelWidth, "height": modelHeight]
            blobs.append((modelBlobID, jpeg))
        }
        return CapturedScreenshot(result: result, blobs: blobs)
    }

    private static func displayScale(for frame: Rect) throws -> Double {
        var displays = [CGDirectDisplayID](repeating: 0, count: 32)
        var count: UInt32 = 0
        guard CGGetActiveDisplayList(UInt32(displays.count), &displays, &count) == .success else {
            throw NativeError.denied(code: "DRIVER_UNAVAILABLE", message: "Cannot read display layout")
        }
        let center = CGPoint(x: frame.x + frame.width / 2, y: frame.y + frame.height / 2)
        let matches = displays.prefix(Int(count)).filter { CGDisplayBounds($0).contains(center) }
        guard matches.count == 1, let mode = CGDisplayCopyDisplayMode(matches[0]), mode.width > 0 else {
            throw NativeError.denied(code: "TARGET_NOT_VISIBLE", message: "Window display is ambiguous")
        }
        return Double(mode.pixelWidth) / Double(mode.width)
    }
}
