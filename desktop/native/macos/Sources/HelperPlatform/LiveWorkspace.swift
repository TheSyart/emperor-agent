import AppKit

/// AppKit refreshes `NSWorkspace.frontmostApplication`, `runningApplications`
/// and each instance's `isActive` from the main run loop. The helper's main
/// thread mostly blocks on its socket, so those values trail the real
/// foreground: an app the helper has just activated still reads as inactive,
/// and a protected prompt that has just come up may read as absent. A new
/// `NSRunningApplication` answers `isActive` from the system every time
/// (about 50 µs; a full scan of 90 apps about 12 ms).
enum LiveWorkspace {
    static func isActive(_ pid: pid_t) -> Bool {
        NSRunningApplication(processIdentifier: pid)?.isActive == true
    }

    /// The active app now, or nil when none of the apps AppKit knows about is
    /// active (one launched moments ago); callers must fail closed on nil.
    static func activeApplication() -> NSRunningApplication? {
        var seen = Set<pid_t>()
        let hint = NSWorkspace.shared.frontmostApplication.map { [$0] } ?? []
        for app in hint + NSWorkspace.shared.runningApplications {
            let pid = app.processIdentifier
            guard pid > 0, seen.insert(pid).inserted,
                  let live = NSRunningApplication(processIdentifier: pid), live.isActive else { continue }
            return live
        }
        return nil
    }
}
