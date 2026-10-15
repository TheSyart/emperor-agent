import AppKit
import Darwin

/// AppKit refreshes `NSWorkspace.frontmostApplication`, `runningApplications`
/// and each instance's `isActive` from the main run loop. The helper's main
/// thread mostly blocks on its socket, so those values trail the real
/// foreground: an app the helper has just activated still reads as inactive,
/// a protected prompt that has just come up may read as absent, and an app
/// launched after the helper started (the Agent's `open -a`, or the user's)
/// is never in `runningApplications` at all. A new `NSRunningApplication`
/// answers from the system every time (about 50 µs; a full scan of 90 apps
/// about 12 ms), so the helper lists apps from the system's process list.
enum LiveWorkspace {
    /// Every regular app running now, apps launched after the helper started
    /// included, in process ID order.
    static func runningApplications() -> [NSRunningApplication] {
        liveApplications(pids: allProcessIDs(),
                         executablePath: executablePath(pid:),
                         application: { NSRunningApplication(processIdentifier: $0) })
            .filter { $0.activationPolicy == .regular && !$0.isTerminated }
    }

    /// The processes among `pids` that run an app bundle's own executable,
    /// each once, in pid order; `application` returns nil for one that has
    /// gone. Generic so it can be tested without AppKit.
    static func liveApplications<App>(
        pids: [pid_t],
        executablePath: (pid_t) -> String?,
        application: (pid_t) -> App?
    ) -> [App] {
        var seen = Set<pid_t>()
        var result: [App] = []
        for pid in pids.sorted() where pid > 0 && seen.insert(pid).inserted {
            guard let path = executablePath(pid), isApplicationExecutable(path),
                  let app = application(pid) else { continue }
            result.append(app)
        }
        return result
    }

    /// `…/Name.app/Contents/MacOS/<executable>`: an app bundle's own
    /// executable, not an XPC service or a tool inside one. Helper apps nested
    /// in another app (Electron's) match too; their activation policy is not
    /// regular, so they drop out after.
    static func isApplicationExecutable(_ path: String) -> Bool {
        let parts = path.split(separator: "/", omittingEmptySubsequences: true)
        guard parts.count >= 4 else { return false }
        // proc_pidpath can point at macOS's code_sign_clone copy, whose
        // bundle ends in .app.bundle. It is still the app's own executable;
        // NSRunningApplication and activationPolicy validate the live app.
        let bundle = parts[parts.count - 4]
        return parts[parts.count - 2] == "MacOS"
            && parts[parts.count - 3] == "Contents"
            && (bundle.hasSuffix(".app") || bundle.hasSuffix(".app.bundle"))
    }

    private static func allProcessIDs() -> [pid_t] {
        let needed = Int(proc_listallpids(nil, 0))
        guard needed > 0 else { return [] }
        // Room for processes started between the two calls.
        var pids = [pid_t](repeating: 0, count: needed + 64)
        let count = pids.withUnsafeMutableBytes { buffer in
            proc_listallpids(buffer.baseAddress, Int32(buffer.count))
        }
        guard count > 0 else { return [] }
        return Array(pids.prefix(Int(count)))
    }

    private static func executablePath(pid: pid_t) -> String? {
        var buffer = [CChar](repeating: 0, count: Int(PATH_MAX))
        let length = proc_pidpath(pid, &buffer, UInt32(buffer.count))
        guard length > 0 else { return nil }
        return String(decoding: buffer.prefix(while: { $0 != 0 }).map(UInt8.init(bitPattern:)), as: UTF8.self)
    }

    static func isActive(_ pid: pid_t) -> Bool {
        NSRunningApplication(processIdentifier: pid)?.isActive == true
    }

    /// The active app now, or nil when no app is active (the moment between
    /// two activations); callers must fail closed on nil.
    static func activeApplication() -> NSRunningApplication? {
        var seen = Set<pid_t>()
        let hint = NSWorkspace.shared.frontmostApplication.map { [$0] } ?? []
        for app in hint + runningApplications() {
            let pid = app.processIdentifier
            guard pid > 0, seen.insert(pid).inserted,
                  let live = NSRunningApplication(processIdentifier: pid), live.isActive else { continue }
            return live
        }
        return nil
    }
}
