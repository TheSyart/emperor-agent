import CoreGraphics
import Foundation
import HelperCore

enum CGWindowInventory {
    static func current() -> [ScreenshotWindow] {
        let rows = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements],
                                              kCGNullWindowID) as? [[String: Any]] ?? []
        return candidates(rows: rows)
    }

    /// Every on-screen window, front to back, for the pointer's visibility.
    static func onScreen() -> [ScreenWindow] {
        let rows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements],
                                              kCGNullWindowID) as? [[String: Any]] ?? []
        return rows.compactMap { row in
            guard let rawID = row[kCGWindowNumber as String] as? Int,
                  rawID > 0, rawID <= Int(UInt32.max),
                  let rawPID = row[kCGWindowOwnerPID as String] as? Int,
                  rawPID > 0, rawPID <= Int(Int32.max),
                  let bounds = row[kCGWindowBounds as String] as? [String: Any],
                  let x = (bounds["X"] as? NSNumber)?.doubleValue,
                  let y = (bounds["Y"] as? NSNumber)?.doubleValue,
                  let width = (bounds["Width"] as? NSNumber)?.doubleValue,
                  let height = (bounds["Height"] as? NSNumber)?.doubleValue,
                  [x, y, width, height].allSatisfy(\.isFinite) else { return nil }
            return ScreenWindow(id: UInt32(rawID), pid: Int32(rawPID),
                                layer: row[kCGWindowLayer as String] as? Int ?? 0,
                                frame: Rect(x: x, y: y, width: width, height: height),
                                alpha: (row[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1)
        }
    }

    static func candidates(rows: [[String: Any]]) -> [ScreenshotWindow] {
        rows.compactMap { row in
            guard let rawID = row[kCGWindowNumber as String] as? Int,
                  rawID > 0, rawID <= Int(UInt32.max),
                  let rawPID = row[kCGWindowOwnerPID as String] as? Int,
                  rawPID > 0, rawPID <= Int(Int32.max),
                  row[kCGWindowLayer as String] as? Int == 0,
                  let title = row[kCGWindowName as String] as? String, !title.isEmpty,
                  let bounds = row[kCGWindowBounds as String] as? [String: Any],
                  let x = (bounds["X"] as? NSNumber)?.doubleValue,
                  let y = (bounds["Y"] as? NSNumber)?.doubleValue,
                  let width = (bounds["Width"] as? NSNumber)?.doubleValue,
                  let height = (bounds["Height"] as? NSNumber)?.doubleValue,
                  [x, y, width, height].allSatisfy(\.isFinite),
                  width > 0, height > 0 else { return nil }
            return ScreenshotWindow(id: UInt32(rawID), pid: Int32(rawPID),
                                    title: title, frame: Rect(x: x, y: y,
                                                              width: width, height: height))
        }
    }
}
