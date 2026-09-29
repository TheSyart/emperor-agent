import Darwin
import AppKit
import ApplicationServices
import Carbon
import CoreGraphics
import Foundation

private struct HelperFailure: Error {
    let code: String
}

private func currentInputSourceID() -> String? {
    guard let source = TISCopyCurrentKeyboardInputSource()?.takeRetainedValue(),
          let value = TISGetInputSourceProperty(source, kTISPropertyInputSourceID) else { return nil }
    return Unmanaged<CFString>.fromOpaque(value).takeUnretainedValue() as String
}

private final class Wire {
    private let fd: Int32
    private var nextID = 1
    private(set) var dispatched = Set<String>()
    private(set) var lostTargets = Set<String>()

    init(path: String) throws {
        fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw HelperFailure(code: "SOCKET_CREATE") }
        // TCC can wait for a person to dismiss its system prompt.
        var timeout = timeval(tv_sec: 130, tv_usec: 0)
        _ = setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8) + [0]
        guard bytes.count < MemoryLayout.size(ofValue: address.sun_path) else {
            throw HelperFailure(code: "SOCKET_PATH")
        }
        withUnsafeMutableBytes(of: &address.sun_path) { $0.copyBytes(from: bytes) }
        var connected = false
        for _ in 0..<100 {
            let result = withUnsafePointer(to: &address) { pointer in
                pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                    connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
                }
            }
            if result == 0 { connected = true; break }
            usleep(100_000)
        }
        guard connected else { throw HelperFailure(code: "SOCKET_CONNECT") }
    }

    deinit { close(fd) }

    private func readExactly(_ length: Int) throws -> Data {
        var data = Data(count: length)
        var offset = 0
        while offset < length {
            let amount = data.withUnsafeMutableBytes { raw in
                Darwin.read(fd, raw.baseAddress!.advanced(by: offset), length - offset)
            }
            guard amount > 0 else { throw HelperFailure(code: "SOCKET_EOF") }
            offset += amount
        }
        return data
    }

    private func frame() throws -> (UInt8, Data) {
        let header = [UInt8](try readExactly(4))
        let length = header.reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
        guard length >= 1, length <= 33_554_432 else { throw HelperFailure(code: "FRAME_LENGTH") }
        let body = try readExactly(Int(length))
        // subdata resets Data indices to zero for the blob parser below.
        return (body[0], body.subdata(in: 1..<body.count))
    }

    private func send(_ object: [String: Any]) throws {
        let json = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        let length = json.count + 1
        guard length <= 1_048_576 else { throw HelperFailure(code: "FRAME_TOO_LARGE") }
        var bytes = Data([
            UInt8((length >> 24) & 255), UInt8((length >> 16) & 255),
            UInt8((length >> 8) & 255), UInt8(length & 255), 1,
        ])
        bytes.append(json)
        var offset = 0
        try bytes.withUnsafeBytes { raw in
            while offset < raw.count {
                let amount = Darwin.write(fd, raw.baseAddress!.advanced(by: offset), raw.count - offset)
                guard amount > 0 else { throw HelperFailure(code: "SOCKET_WRITE") }
                offset += amount
            }
        }
    }

    private func jsonFrame(onDispatched: ((String) throws -> Void)? = nil) throws -> [String: Any] {
        while true {
            let (kind, payload) = try frame()
            guard kind == 1,
                  let message = try JSONSerialization.jsonObject(with: payload) as? [String: Any],
                  let type = message["type"] as? String else {
                throw HelperFailure(code: "FRAME_JSON")
            }
            if type == "ping" {
                try send(["type": "pong", "seq": message["seq"] ?? 0])
                continue
            }
            if type == "event", message["name"] as? String == "act.dispatched",
               let data = message["data"] as? [String: Any],
               let operationID = data["operationId"] as? String {
                dispatched.insert(operationID)
                try onDispatched?(operationID)
                continue
            }
            if type == "event", message["name"] as? String == "target.lost",
               let data = message["data"] as? [String: Any],
               let targetID = data["targetId"] as? String {
                lostTargets.insert(targetID)
            }
            if type == "event" { continue }
            return message
        }
    }

    func helloAndWelcome(nonce: String) throws -> [String: Any] {
        let hello = try jsonFrame()
        guard hello["type"] as? String == "hello" else { throw HelperFailure(code: "HELLO") }
        try send(["type": "welcome", "protocol": 1, "nonce": nonce])
        return hello
    }

    func request(_ method: String, _ params: [String: Any], deadline: Int = 10_000,
                 cancelOnDispatch: Bool = false,
                 cancelWhenPointerDownAt pointerPath: String? = nil,
                 releaseAllAfterPointerCancel: Bool = false) throws -> [String: Any] {
        let id = nextID
        nextID += 1
        try send(["type": "request", "id": id, "method": method,
                  "params": params, "deadlineMs": deadline])
        var releaseID: Int?
        var releaseAcknowledged = false
        var actionResponse: [String: Any]?
        while true {
            let response = try jsonFrame(onDispatched: { operationID in
                guard operationID == params["operationId"] as? String else { return }
                if let pointerPath {
                    let until = Date().addingTimeInterval(1)
                    while Date() < until {
                        if (try? String(contentsOfFile: pointerPath, encoding: .utf8)) == "down" {
                            try self.send(["type": "cancel", "id": id])
                            if releaseAllAfterPointerCancel {
                                let cleanupID = self.nextID
                                self.nextID += 1
                                try self.send(["type": "request", "id": cleanupID,
                                               "method": "input.releaseAll", "params": [:],
                                               "deadlineMs": 1_000])
                                releaseID = cleanupID
                            }
                            return
                        }
                        usleep(1_000)
                    }
                    throw HelperFailure(code: "POINTER_DOWN_NOT_SEEN")
                }
                // Stop background typing between its chunks (E-M6b).
                if cancelOnDispatch { try self.send(["type": "cancel", "id": id]) }
            })
            guard response["type"] as? String == "response" else { continue }
            guard let responseID = response["id"] as? Int else {
                throw HelperFailure(code: "RESPONSE_ID")
            }
            if responseID == releaseID {
                guard response["ok"] as? Bool == true else {
                    throw HelperFailure(code: "RELEASE_ALL_FAILED")
                }
                releaseAcknowledged = true
            } else if responseID == id {
                actionResponse = response
            } else {
                throw HelperFailure(code: "RESPONSE_ID")
            }
            guard let actionResponse, releaseID == nil || releaseAcknowledged else { continue }
            if actionResponse["ok"] as? Bool == true {
                return actionResponse["result"] as? [String: Any] ?? [:]
            }
            let error = actionResponse["error"] as? [String: Any]
            let code = error?["code"] as? String ?? "HELPER_ERROR"
            // Helper messages are static and content-free; print every one so
            // a failed run names the check that refused it.
            fputs("\(code) at \(method): \(error?["message"] as? String ?? "no detail")\n", stderr)
            throw HelperFailure(code: code)
        }
    }

    func screenshotBlob(expectedID: String) throws -> Int {
        let (kind, payload) = try frame()
        guard kind == 2, let idLength = payload.first,
              payload.count > Int(idLength) + 1,
              let id = String(data: payload.subdata(in: 1..<(Int(idLength) + 1)), encoding: .ascii),
              id == expectedID else { throw HelperFailure(code: "SCREENSHOT_BLOB") }
        let png = payload.dropFirst(Int(idLength) + 1)
        guard png.prefix(8).elementsEqual([137, 80, 78, 71, 13, 10, 26, 10]) else {
            throw HelperFailure(code: "SCREENSHOT_PNG")
        }
        return png.count
    }
}

private func required<T>(_ dictionary: [String: Any], _ key: String) throws -> T {
    guard let value = dictionary[key] as? T else { throw HelperFailure(code: "MISSING_\(key)") }
    return value
}

private func observation(_ wire: Wire, targetID: String, generation: Int) throws -> [String: Any] {
    for attempt in 0..<3 {
        do {
            return try wire.request("observe.semantic", [
                "targetId": targetID, "generation": generation,
                "budget": ["maxElements": 200, "maxTextBytes": 16_384,
                           "maxDepth": 8, "timeoutMs": 3_000],
                "includeText": true,
            ], deadline: 5_000)
        } catch let error as HelperFailure where error.code == "STALE_TARGET" && attempt < 2 {
            usleep(100_000)
        }
    }
    throw HelperFailure(code: "OBSERVATION_UNSTABLE")
}

/// Brings a bound target forward with the explicit `activate` action; the
/// helper never activates an app on its own.
private func activateTarget(_ wire: Wire, targetID: String, generation: Int,
                            operationID: String) throws {
    let current = try observation(wire, targetID: targetID, generation: generation)
    do {
        _ = try wire.request("act", ["operationId": operationID, "targetId": targetID,
            "generation": generation, "expectedRevision": try required(current, "revision") as Int,
            "action": ["kind": "activate"]])
    } catch let error as HelperFailure where error.code == "OUTCOME_UNKNOWN" {
        // Checked below by the dispatch record; never replayed.
    }
    guard wire.dispatched.contains(operationID) else { throw HelperFailure(code: "ACTIVATE_NOT_DISPATCHED") }
    print("act activate: target brought forward on explicit request")
}

private func statusShows(_ snapshot: [String: Any], _ text: String) -> Bool {
    (snapshot["elements"] as? [[String: Any]] ?? []).contains { item in
        (item["name"] as? String)?.contains(text) == true ||
            (item["value"] as? String)?.contains(text) == true
    }
}

/// With the fixture in the background: its menu is listed without the Apple
/// menu, a menu command runs without activating it, pointer input is refused
/// before dispatch, and only an explicit `activate` brings it forward.
/// The app in front right now, asked live (a cached frontmost value trails).
private func liveActiveApp() -> NSRunningApplication? {
    for app in NSWorkspace.shared.runningApplications {
        if let live = NSRunningApplication(processIdentifier: app.processIdentifier), live.isActive {
            return live
        }
    }
    return nil
}

@MainActor private func runBackgroundRoutes(_ wire: Wire, targetID: String, generation: Int,
                                            fixture: NSRunningApplication) throws {
    func fixtureActive() -> Bool {
        NSRunningApplication(processIdentifier: fixture.processIdentifier)?.isActive == true
    }
    guard let finder = NSRunningApplication.runningApplications(
        withBundleIdentifier: "com.apple.finder").first,
        finder.activate(options: []) else { throw HelperFailure(code: "BACKGROUND_SETUP") }
    for _ in 0..<40 where fixtureActive() { usleep(50_000) }
    guard !fixtureActive() else { throw HelperFailure(code: "BACKGROUND_SETUP") }

    let bar: [[String: Any]] = try required(try wire.request("observe.menu", [
        "targetId": targetID, "generation": generation, "path": [String](),
    ]), "items")
    let fixtureMenu: [[String: Any]] = try required(try wire.request("observe.menu", [
        "targetId": targetID, "generation": generation, "path": ["Fixture"],
    ]), "items")
    guard bar.contains(where: { $0["title"] as? String == "Fixture" }),
          !bar.contains(where: { $0["title"] as? String == "Apple" }),
          fixtureMenu.contains(where: {
              $0["title"] as? String == "Menu Action" && $0["shortcut"] as? String == "Meta+M"
          }) else { throw HelperFailure(code: "MENU_LISTING") }
    print("observe.menu: fixture menus listed, Apple menu excluded")

    var snapshot = try observation(wire, targetID: targetID, generation: generation)
    let menuID = "fixture-background-menu-1"
    do {
        _ = try wire.request("act", ["operationId": menuID, "targetId": targetID,
            "generation": generation, "expectedRevision": try required(snapshot, "revision") as Int,
            "action": ["kind": "menu", "path": ["Fixture", "Menu Action"]]])
    } catch let error as HelperFailure where error.code == "OUTCOME_UNKNOWN" {
        // Checked below by observation; never replayed.
    }
    guard wire.dispatched.contains(menuID) else { throw HelperFailure(code: "MENU_NOT_DISPATCHED") }
    snapshot = try observation(wire, targetID: targetID, generation: generation)
    guard statusShows(snapshot, "Status: menu action") else { throw HelperFailure(code: "MENU_NOT_OBSERVED") }
    guard !fixtureActive() else { throw HelperFailure(code: "MENU_ACTIVATED_TARGET") }
    print("act menu: command ran with the fixture in the background")

    let buttonRef: String = try required(try element(snapshot, named: "Press Me"), "ref")
    let dragID = "fixture-background-drag-1"
    do {
        _ = try wire.request("act", ["operationId": dragID, "targetId": targetID,
            "generation": generation, "expectedRevision": try required(snapshot, "revision") as Int,
            "action": ["kind": "drag", "from": buttonRef, "to": buttonRef]])
        throw HelperFailure(code: "BACKGROUND_POINTER_ACCEPTED")
    } catch let error as HelperFailure where error.code == "TARGET_NOT_VISIBLE" {
        guard !wire.dispatched.contains(dragID) else { throw HelperFailure(code: "BACKGROUND_POINTER_DISPATCHED") }
    }
    guard !fixtureActive() else { throw HelperFailure(code: "POINTER_ACTIVATED_TARGET") }
    print("act drag: refused before dispatch while the fixture is in the background")

    // Whatever really is in front now: macOS may have declined the Finder
    // activation above, and the helper records the actual front app.
    let frontBefore = liveActiveApp()
    try activateTarget(wire, targetID: targetID, generation: generation, operationID: "fixture-activate-1")
    for _ in 0..<20 where !fixtureActive() { usleep(50_000) }
    guard fixtureActive() else { throw HelperFailure(code: "ACTIVATE_NOT_OBSERVED") }

    // The task end hands the front back to the app that had it.
    let restored: Bool = try required(try wire.request("front.restore", [
        "targetId": targetID, "generation": generation,
    ]), "restored")
    for _ in 0..<20 where fixtureActive() { usleep(50_000) }
    let frontAfter = liveActiveApp()
    print("front.restore: restored=\(restored), before=\(frontBefore?.bundleIdentifier ?? "none"), after=\(frontAfter?.bundleIdentifier ?? "none")")
    guard restored, !fixtureActive(), let frontBefore,
          frontAfter?.processIdentifier == frontBefore.processIdentifier else {
        throw HelperFailure(code: "FRONT_NOT_RESTORED")
    }
    print("front.restore: the front went back to the app that had it")
    try activateTarget(wire, targetID: targetID, generation: generation, operationID: "fixture-activate-2")
    for _ in 0..<20 where !fixtureActive() { usleep(50_000) }
    guard fixtureActive() else { throw HelperFailure(code: "ACTIVATE_NOT_OBSERVED") }
}

private func element(_ result: [String: Any], named name: String) throws -> [String: Any] {
    let elements: [[String: Any]] = try required(result, "elements")
    guard let match = elements.first(where: { $0["name"] as? String == name }) else {
        throw HelperFailure(code: "AX_ELEMENT_\(name.replacingOccurrences(of: " ", with: "_"))")
    }
    return match
}

private func runModifierExperiment(_ wire: Wire, targetID: String, generation: Int,
                                   snapshot: [String: Any], keyEventPath: String) throws {
    var current = snapshot
    let focusID = "fixture-modifier-focus-1"
    for attempt in 1...3 {
        let usernameRef: String = try required(element(current, named: "Username"), "ref")
        let revision: Int = try required(current, "revision")
        do {
            _ = try wire.request("act", ["operationId": focusID, "targetId": targetID,
                "generation": generation, "expectedRevision": revision,
                "action": ["kind": "click", "ref": usernameRef]])
            break
        } catch let error as HelperFailure where error.code == "OUTCOME_UNKNOWN" {
            // Inspect focus rather than replaying a dispatched click.
            break
        } catch let error as HelperFailure where error.code == "STALE_TARGET" &&
                    !wire.dispatched.contains(focusID) && attempt < 3 {
            current = try observation(wire, targetID: targetID, generation: generation)
        }
    }
    guard wire.dispatched.contains(focusID) else { throw HelperFailure(code: "MODIFIER_FOCUS_NOT_DISPATCHED") }
    let focused = try observation(wire, targetID: targetID, generation: generation)
    guard (try element(focused, named: "Username")["states"] as? [String] ?? []).contains("focused") else {
        throw HelperFailure(code: "MODIFIER_FIELD_NOT_FOCUSED")
    }

    let previousSource = TISCopyCurrentKeyboardInputSource()?.takeRetainedValue()
    guard let asciiSource = TISCopyCurrentASCIICapableKeyboardInputSource()?.takeRetainedValue(),
          TISSelectInputSource(asciiSource) == noErr else {
        throw HelperFailure(code: "MODIFIER_ASCII_SOURCE")
    }
    defer { if let previousSource { _ = TISSelectInputSource(previousSource) } }

    guard let externalSource = CGEventSource(stateID: .hidSystemState),
          let shiftDown = CGEvent(keyboardEventSource: externalSource, virtualKey: 56, keyDown: true),
          let shiftUp = CGEvent(keyboardEventSource: externalSource, virtualKey: 56, keyDown: false) else {
        throw HelperFailure(code: "MODIFIER_SYNTHESIS")
    }
    shiftDown.flags = .maskShift
    shiftUp.flags = []
    shiftDown.post(tap: .cghidEventTap)
    defer { shiftUp.post(tap: .cghidEventTap) }
    usleep(150_000)
    let shiftHeldBeforeAction = CGEventSource.flagsState(.combinedSessionState).contains(.maskShift)
    guard shiftHeldBeforeAction else {
        throw HelperFailure(code: "EXTERNAL_SHIFT_NOT_HELD")
    }

    let operationID = "fixture-modifier-a-1"
    current = focused
    for attempt in 1...3 {
        let usernameRef: String = try required(element(current, named: "Username"), "ref")
        let focusedRevision: Int = try required(current, "revision")
        do {
            _ = try wire.request("act", ["operationId": operationID, "targetId": targetID,
                "generation": generation, "expectedRevision": focusedRevision,
                "action": ["kind": "press", "key": "A", "ref": usernameRef]])
            break
        } catch let error as HelperFailure where error.code == "OUTCOME_UNKNOWN" {
            // A key may have arrived despite a delayed AX change notification.
            break
        } catch let error as HelperFailure where error.code == "STALE_TARGET" &&
                    !wire.dispatched.contains(operationID) && attempt < 3 {
            current = try observation(wire, targetID: targetID, generation: generation)
        }
    }
    guard wire.dispatched.contains(operationID) else { throw HelperFailure(code: "MODIFIER_KEY_NOT_DISPATCHED") }
    var keyRecord = ""
    for _ in 0..<20 {
        keyRecord = (try? String(contentsOfFile: keyEventPath, encoding: .utf8)) ?? ""
        if keyRecord.hasPrefix("keyCode=0 ") { break }
        usleep(50_000)
    }
    print("external Shift held before Helper action: \(shiftHeldBeforeAction)")
    print("fixture received: \(keyRecord)")
    guard keyRecord == "keyCode=0 shift=false characters=a" else {
        throw HelperFailure(code: "MODIFIER_INHERITED_OR_KEY_MISSING")
    }
    let after = try observation(wire, targetID: targetID, generation: generation)
    guard try element(after, named: "Username")["value"] as? String == "a" else {
        throw HelperFailure(code: "MODIFIER_TEXT_MISMATCH")
    }
    _ = try wire.request("shutdown", [:], deadline: 2_000)
    print("PASS: private Helper event source and explicit empty flags ignored held external Shift")
}

@MainActor private func runPostToPidExperiment(_ wire: Wire, fixture: NSRunningApplication,
                                               keyEventPath: String) throws {
    let probeApp = NSApplication.shared
    probeApp.setActivationPolicy(.regular)
    probeApp.finishLaunching()
    let probeWindow = NSWindow(contentRect: NSRect(x: 100, y: 100, width: 320, height: 120),
                               styleMask: [.titled, .closable], backing: .buffered, defer: false)
    probeWindow.title = "Emperor postToPid fixture probe"
    probeWindow.makeKeyAndOrderFront(nil)
    probeApp.activate(ignoringOtherApps: true)
    defer { probeWindow.close() }
    for _ in 0..<20 {
        if NSWorkspace.shared.frontmostApplication?.processIdentifier == getpid() { break }
        RunLoop.current.run(until: Date().addingTimeInterval(0.05))
    }
    print("postToPid setup: frontmost=\(NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? "unknown"), fixtureActive=\(fixture.isActive)")
    guard NSWorkspace.shared.frontmostApplication?.processIdentifier == getpid(),
          !fixture.isActive else { throw HelperFailure(code: "POST_TO_PID_BACKGROUND_SETUP") }

    guard let source = CGEventSource(stateID: .privateState),
          let down = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true),
          let up = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false) else {
        throw HelperFailure(code: "POST_TO_PID_SYNTHESIS")
    }
    down.flags = []
    up.flags = []
    down.postToPid(fixture.processIdentifier)
    up.postToPid(fixture.processIdentifier)
    usleep(350_000)
    let record = (try? String(contentsOfFile: keyEventPath, encoding: .utf8)) ?? ""
    let outcome = record.hasPrefix("keyCode=0 ") ? "delivered" : "not-delivered"
    print("postToPid background experiment: fixtureIsActive=\(fixture.isActive), outcome=\(outcome), keyRecord=\(record)")
    _ = try wire.request("shutdown", [:], deadline: 2_000)
    print("PASS: postToPid background experiment recorded; production Helper remains foreground-only HID")
}

@MainActor private func run() throws {
    guard (5...6).contains(CommandLine.arguments.count) else { throw HelperFailure(code: "ARGUMENTS") }
    let helperPath = CommandLine.arguments[1]
    let socketPath = CommandLine.arguments[2]
    let nonce = CommandLine.arguments[3]
    let fixtureExecutable = CommandLine.arguments[4]
    let fixtureTeamID = CommandLine.arguments.count == 6 ? CommandLine.arguments[5] : nil
    let launcher = Process()
    launcher.executableURL = URL(fileURLWithPath: "/usr/bin/open")
    var openArguments = ["-g", "-n", "-a", helperPath]
    // The Helper keeps no log file; its diagnostics (for example APP_MODE)
    // go only to stderr, which LaunchServices discards unless redirected.
    if let stderrPath = ProcessInfo.processInfo.environment["EMPEROR_FIXTURE_HELPER_STDERR"],
       stderrPath.hasPrefix("/") {
        openArguments += ["--stderr", stderrPath]
    }
    launcher.arguments = openArguments + ["--args", "--parent-pid", String(getpid()),
                                          "--nonce", nonce, "--socket", socketPath]
    try launcher.run()
    launcher.waitUntilExit()
    let wire = try Wire(path: socketPath)
    let hello = try wire.helloAndWelcome(nonce: nonce)
    var permissions = try wire.request("permissions.status", [:])["permissions"] as? [String: String] ?? [:]
    print("hello: \(hello["helperVersion"] ?? "unknown"), permissions: \(permissions)")
    let apps = try wire.request("apps.list", [:])["apps"] as? [[String: Any]] ?? []
    let chromeModeOnly = ProcessInfo.processInfo.environment["EMPEROR_FIXTURE_APP_MODE_ONLY"] == "1"
    let electronModeOnly = ProcessInfo.processInfo.environment["EMPEROR_FIXTURE_ELECTRON_APP_MODE_ONLY"] == "1"
    let appModeOnly = chromeModeOnly || electronModeOnly
    let finderFocusOnly = ProcessInfo.processInfo.environment["EMPEROR_FIXTURE_FINDER_FOCUS_ONLY"] == "1"
    let finderCreateOnly = ProcessInfo.processInfo.environment["EMPEROR_FIXTURE_FINDER_CREATE_ONLY"] == "1"
    guard appModeOnly || finderFocusOnly || finderCreateOnly || apps.contains(where: { $0["appId"] as? String == "com.emperor.agent.axfixture" }) else {
        throw HelperFailure(code: "FIXTURE_APP_MISSING")
    }
    let protectedID: (String) -> Bool = { id in
        let id = id.lowercased()
        return id == "com.emperor.agent.desktop" ||
            id.hasPrefix("com.emperor.agent.desktop.") ||
            id == "com.apple.systempreferences" ||
            id.hasPrefix("com.apple.systempreferences.") ||
            ["com.apple.headphonesettings", "com.apple.keychainaccess", "com.apple.passwords",
             "com.apple.securityagent", "com.apple.coreauthui", "com.apple.localauthentication.uiagent",
             "com.apple.usernotificationcenter",
             "com.apple.loginwindow", "com.apple.screensaver.engine"].contains(id)
    }
    guard !apps.contains(where: { app in
        guard let id = app["appId"] as? String else { return false }
        return protectedID(id)
    }) else { throw HelperFailure(code: "PROTECTED_APP_EXPOSED") }
    if !appModeOnly && !finderFocusOnly && !finderCreateOnly { print("apps.list: fixture present") }
    let runningProtectedIDs = Set(NSWorkspace.shared.runningApplications.compactMap { app -> String? in
        guard let id = app.bundleIdentifier, protectedID(id) else { return nil }
        return id
    })
    if !runningProtectedIDs.isEmpty {
        print("apps.list: running protected processes filtered: \(runningProtectedIDs.sorted().joined(separator: ", "))")
        for id in runningProtectedIDs {
            let protectedWindows: [[String: Any]] = try required(try wire.request("windows.list", [
                "appId": id,
            ]), "windows")
            guard protectedWindows.isEmpty else { throw HelperFailure(code: "PROTECTED_WINDOW_EXPOSED") }
        }
        print("windows.list: running protected windows filtered")
    } else {
        print("SKIP: no protected App was running during protected target check")
    }
    if ProcessInfo.processInfo.environment["EMPEROR_FIXTURE_PROTECTED_ONLY"] == "1" {
        _ = try wire.request("shutdown", [:], deadline: 2_000)
        print("PASS: running protected App and window listings filtered")
        return
    }
    if permissions["accessibility"] != "granted" || permissions["screen-recording"] != "granted" {
        // The helper itself must call the TCC request APIs before it can appear
        // as a selectable subject in System Settings. A status check alone does
        // not register the helper or show a permission prompt.
        for permission in ["screen-recording", "accessibility"] where permissions[permission] != "granted" {
            let result = try wire.request("permissions.request", ["permission": permission], deadline: 120_000)
            print("permissions.request \(permission): settings opened=\(result["opened"] ?? false)")
        }
        permissions = try wire.request("permissions.status", [:])["permissions"] as? [String: String] ?? [:]
        print("permissions after request: \(permissions)")
    }
    if permissions["accessibility"] != "granted" || permissions["screen-recording"] != "granted" {
        _ = try? wire.request("shutdown", [:], deadline: 2_000)
        print("PENDING_TCC: finish the helper permission prompts in System Settings, then rerun this script")
        exit(77)
    }

    if ProcessInfo.processInfo.environment["EMPEROR_FIXTURE_CREDENTIAL_MISMATCH_ONLY"] == "1" {
        // 01 §13.3: an app that reuses the fixture's bundle ID but is not the
        // registered signer must never receive a credential. The script runs
        // an ad-hoc re-signed copy (no Team ID); the genuine Team ID comes in
        // as the expected binding.
        guard let fixtureTeamID else { throw HelperFailure(code: "MISMATCH_TEAM_MISSING") }
        let windows: [[String: Any]] = try required(try wire.request("windows.list", [
            "appId": "com.emperor.agent.axfixture",
        ]), "windows")
        guard windows.count == 1, let windowRef = windows[0]["windowRef"] as? String else {
            throw HelperFailure(code: "MISMATCH_WINDOW_NOT_UNIQUE")
        }
        let bound = try wire.request("target.bind", ["windowRef": windowRef])
        let targetID: String = try required(bound, "targetId")
        let generation: Int = try required(bound, "generation")
        let refusals: [(String, [String: Any])] = [
            ("team", ["bundleId": "com.emperor.agent.axfixture", "path": fixtureExecutable,
                      "teamId": fixtureTeamID]),
            ("path", ["bundleId": "com.emperor.agent.axfixture",
                      "path": "/Applications/Emperor AX Fixture.app/Contents/MacOS/EmperorAXFixture"]),
        ]
        for (name, binding) in refusals {
            let snapshot = try observation(wire, targetID: targetID, generation: generation)
            let username = try element(snapshot, named: "Username")
            let operationID = "fixture-mismatch-\(name)"
            do {
                _ = try wire.request("act.fillSecret", [
                    "operationId": operationID, "targetId": targetID, "generation": generation,
                    "expectedRevision": try required(snapshot, "revision") as Int,
                    "ref": try required(username, "ref") as String, "field": "username",
                    "secret": "fixture-mismatch-secret", "binding": binding,
                ])
                throw HelperFailure(code: "MISMATCH_FILLED_\(name)")
            } catch let error as HelperFailure where error.code == "PERMISSION_DENIED" {
                print("act.fillSecret \(name) mismatch: PERMISSION_DENIED")
            }
            guard !wire.dispatched.contains(operationID) else {
                throw HelperFailure(code: "MISMATCH_DISPATCHED_\(name)")
            }
            let after = try observation(wire, targetID: targetID, generation: generation)
            guard (try element(after, named: "Username"))["value"] as? String ?? "" == "" else {
                throw HelperFailure(code: "MISMATCH_FIELD_CHANGED_\(name)")
            }
        }
        // Positive control: the same copy, bound for what it really is (an
        // unsigned app at this path), is filled. The refusals above are about
        // identity, not about the field.
        let snapshot = try observation(wire, targetID: targetID, generation: generation)
        let username = try element(snapshot, named: "Username")
        let controlID = "fixture-mismatch-control"
        let filled = try wire.request("act.fillSecret", [
            "operationId": controlID, "targetId": targetID, "generation": generation,
            "expectedRevision": try required(snapshot, "revision") as Int,
            "ref": try required(username, "ref") as String, "field": "username",
            "secret": "fixture-user", "binding": ["bundleId": "com.emperor.agent.axfixture",
                                                  "path": fixtureExecutable],
        ])
        guard filled["filled"] as? Bool == true, wire.dispatched.contains(controlID) else {
            throw HelperFailure(code: "MISMATCH_CONTROL_NOT_FILLED")
        }
        print("act.fillSecret matching unsigned binding: filled=true")
        _ = try? wire.request("target.release", ["targetId": targetID])
        _ = try wire.request("shutdown", [:], deadline: 2_000)
        print("PASS: credential fill refused for a same-bundle-ID app with another identity")
        return
    }

    if finderCreateOnly {
        let title = "emperor-cu-finder.hkkl9E"
        let base = "/tmp/\(title)"
        let created = "\(base)/emperor-cu-created-fixture.hkkl9E"
        guard !FileManager.default.fileExists(atPath: created) else {
            throw HelperFailure(code: "FINDER_CREATE_PRECONDITION")
        }
        let finderWindows: [[String: Any]] = try required(try wire.request("windows.list", [
            "appId": "com.apple.finder",
        ]), "windows")
        let matches = finderWindows.filter { $0["title"] as? String == title }
        guard matches.count == 1, let windowRef = matches[0]["windowRef"] as? String else {
            throw HelperFailure(code: "FINDER_WINDOW_NOT_UNIQUE")
        }
        let bound = try wire.request("target.bind", ["windowRef": windowRef])
        let targetID: String = try required(bound, "targetId")
        let generation: Int = try required(bound, "generation")
        try activateTarget(wire, targetID: targetID, generation: generation,
                           operationID: "finder-create-only-activate-1")
        let before = try observation(wire, targetID: targetID, generation: generation)
        let beforeElements: [[String: Any]] = try required(before, "elements")
        guard beforeElements.contains(where: { $0["name"] as? String == "未命名文件夹" }),
              !beforeElements.contains(where: { $0["name"] as? String == "未命名文件夹 2" }) else {
            throw HelperFailure(code: "FINDER_CREATE_INITIAL_STATE")
        }
        let createdAction = try wire.request("act", [
            "operationId": "finder-create-only-create-1", "targetId": targetID,
            "generation": generation, "expectedRevision": try required(before, "revision") as Int,
            "action": ["kind": "press", "key": "Meta+Shift+N"],
        ])
        guard wire.dispatched.contains("finder-create-only-create-1") else {
            throw HelperFailure(code: "FINDER_CREATE_NOT_DISPATCHED")
        }
        print("Finder create: outcome=\(createdAction["outcome"] ?? "unknown")")
        let after = try observation(wire, targetID: targetID, generation: generation)
        let afterElements: [[String: Any]] = try required(after, "elements")
        guard afterElements.contains(where: {
            $0["name"] as? String == "未命名文件夹 2" &&
                ($0["states"] as? [String])?.contains("selected") == true
        }) else { throw HelperFailure(code: "FINDER_CREATED_NOT_SELECTED") }
        let typed = try wire.request("act", [
            "operationId": "finder-create-only-type-1", "targetId": targetID,
            "generation": generation, "expectedRevision": try required(after, "revision") as Int,
            "action": ["kind": "typeText", "text": "emperor-cu-created-fixture.hkkl9E"],
        ])
        guard wire.dispatched.contains("finder-create-only-type-1") else {
            throw HelperFailure(code: "FINDER_TYPE_NOT_DISPATCHED")
        }
        print("Finder type: outcome=\(typed["outcome"] ?? "unknown")")
        let afterType = try observation(wire, targetID: targetID, generation: generation)
        let committed = try wire.request("act", [
            "operationId": "finder-create-only-commit-1", "targetId": targetID,
            "generation": generation, "expectedRevision": try required(afterType, "revision") as Int,
            "action": ["kind": "press", "key": "Return"],
        ])
        guard wire.dispatched.contains("finder-create-only-commit-1") else {
            throw HelperFailure(code: "FINDER_COMMIT_NOT_DISPATCHED")
        }
        print("Finder commit: outcome=\(committed["outcome"] ?? "unknown")")
        _ = try observation(wire, targetID: targetID, generation: generation)
        guard FileManager.default.fileExists(atPath: created) else {
            throw HelperFailure(code: "FINDER_CREATE_NOT_OBSERVED")
        }
        _ = try wire.request("shutdown", [:], deadline: 2_000)
        print("PASS: Finder folder created and named through bound-window keyboard actions")
        return
    }

    if finderFocusOnly {
        let title = "emperor-cu-finder.hkkl9E"
        let original = "/tmp/\(title)/未命名文件夹"
        let renamed = "/tmp/\(title)/emperor-cu-renamed.hkkl9E"
        let created = "/tmp/\(title)/emperor-cu-created.hkkl9E"
        guard FileManager.default.fileExists(atPath: original),
              !FileManager.default.fileExists(atPath: renamed),
              !FileManager.default.fileExists(atPath: created) else {
            throw HelperFailure(code: "FINDER_RENAME_PRECONDITION")
        }
        let finderWindows: [[String: Any]] = try required(try wire.request("windows.list", [
            "appId": "com.apple.finder",
        ]), "windows")
        let matches = finderWindows.filter { $0["title"] as? String == title }
        print("Finder windows: count=\(finderWindows.count), exactTestTitle=\(matches.count)")
        guard matches.count == 1, let windowRef = matches[0]["windowRef"] as? String else {
            throw HelperFailure(code: "FINDER_WINDOW_NOT_UNIQUE")
        }
        let bound = try wire.request("target.bind", ["windowRef": windowRef])
        let targetID: String = try required(bound, "targetId")
        let generation: Int = try required(bound, "generation")
        try activateTarget(wire, targetID: targetID, generation: generation,
                           operationID: "finder-focus-activate-1")
        let before = try observation(wire, targetID: targetID, generation: generation)
        let elements: [[String: Any]] = try required(before, "elements")
        guard elements.filter({
            $0["name"] as? String == "未命名文件夹" &&
                ($0["states"] as? [String])?.contains("selected") == true
        }).count == 1 else { throw HelperFailure(code: "FINDER_TEST_FOLDER_NOT_SELECTED") }
        let pressID = "finder-focus-return-1"
        let revision: Int = try required(before, "revision")
        let pressed = try wire.request("act", ["operationId": pressID, "targetId": targetID,
            "generation": generation, "expectedRevision": revision,
            "action": ["kind": "press", "key": "Return"]])
        guard wire.dispatched.contains(pressID) else { throw HelperFailure(code: "FINDER_RETURN_NOT_DISPATCHED") }
        print("Finder Return: outcome=\(pressed["outcome"] ?? "unknown")")
        let after = try observation(wire, targetID: targetID, generation: generation)
        let afterRevision: Int = try required(after, "revision")
        let typedID = "finder-focus-type-1"
        let typed = try wire.request("act", ["operationId": typedID, "targetId": targetID,
            "generation": generation, "expectedRevision": afterRevision,
            "action": ["kind": "typeText", "text": "emperor-cu-renamed.hkkl9E"]])
        guard wire.dispatched.contains(typedID) else { throw HelperFailure(code: "FINDER_TYPE_NOT_DISPATCHED") }
        print("Finder type: outcome=\(typed["outcome"] ?? "unknown")")
        let afterType = try observation(wire, targetID: targetID, generation: generation)
        let typeRevision: Int = try required(afterType, "revision")
        let commitID = "finder-focus-commit-1"
        let committed = try wire.request("act", ["operationId": commitID, "targetId": targetID,
            "generation": generation, "expectedRevision": typeRevision,
            "action": ["kind": "press", "key": "Return"]])
        guard wire.dispatched.contains(commitID) else { throw HelperFailure(code: "FINDER_COMMIT_NOT_DISPATCHED") }
        print("Finder commit: outcome=\(committed["outcome"] ?? "unknown")")
        let afterRename = try observation(wire, targetID: targetID, generation: generation)
        guard FileManager.default.fileExists(atPath: renamed),
              !FileManager.default.fileExists(atPath: original) else {
            throw HelperFailure(code: "FINDER_RENAME_NOT_OBSERVED")
        }
        let createID = "finder-focus-create-1"
        let renameRevision: Int = try required(afterRename, "revision")
        let createdAction = try wire.request("act", ["operationId": createID, "targetId": targetID,
            "generation": generation, "expectedRevision": renameRevision,
            "action": ["kind": "press", "key": "Meta+Shift+N"]])
        guard wire.dispatched.contains(createID) else { throw HelperFailure(code: "FINDER_CREATE_NOT_DISPATCHED") }
        print("Finder create folder: outcome=\(createdAction["outcome"] ?? "unknown")")
        let afterCreate = try observation(wire, targetID: targetID, generation: generation)
        let createRevision: Int = try required(afterCreate, "revision")
        let nameID = "finder-focus-name-created-1"
        _ = try wire.request("act", ["operationId": nameID, "targetId": targetID,
            "generation": generation, "expectedRevision": createRevision,
            "action": ["kind": "typeText", "text": "emperor-cu-created.hkkl9E"]])
        guard wire.dispatched.contains(nameID) else { throw HelperFailure(code: "FINDER_NAME_NOT_DISPATCHED") }
        let afterName = try observation(wire, targetID: targetID, generation: generation)
        let nameRevision: Int = try required(afterName, "revision")
        let finishID = "finder-focus-finish-created-1"
        _ = try wire.request("act", ["operationId": finishID, "targetId": targetID,
            "generation": generation, "expectedRevision": nameRevision,
            "action": ["kind": "press", "key": "Return"]])
        guard wire.dispatched.contains(finishID) else { throw HelperFailure(code: "FINDER_FINISH_NOT_DISPATCHED") }
        _ = try observation(wire, targetID: targetID, generation: generation)
        guard FileManager.default.fileExists(atPath: created) else {
            throw HelperFailure(code: "FINDER_CREATE_NOT_OBSERVED")
        }
        _ = try wire.request("shutdown", [:], deadline: 2_000)
        print("PASS: Finder test folder renamed and a new folder created through bound-window keyboard actions")
        return
    }

    if appModeOnly {
        let appID = electronModeOnly ? "com.github.Electron" : "com.google.Chrome"
        let fixtureTitle = electronModeOnly ? "Emperor Electron AX Fixture" :
            "Emperor Chrome fixture - Google Chrome"
        let modeName = electronModeOnly ? "Electron" : "Chrome"
        if ProcessInfo.processInfo.environment["EMPEROR_FIXTURE_APP_MODE_ACTIVATE"] == "1" {
            guard let targetApp = NSRunningApplication.runningApplications(
                withBundleIdentifier: appID).first,
                targetApp.activate(options: []) else {
                throw HelperFailure(code: "APP_MODE_FIXTURE_ACTIVATE")
            }
            for _ in 0..<40 {
                if NSWorkspace.shared.frontmostApplication?.processIdentifier == targetApp.processIdentifier { break }
                RunLoop.current.run(until: Date().addingTimeInterval(0.05))
            }
            print("\(modeName) app mode activation: frontmost=\(NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? "unknown")")
        }
        if let seconds = Int(ProcessInfo.processInfo.environment["EMPEROR_FIXTURE_APP_MODE_WAIT_SECONDS"] ?? ""),
           (1...30).contains(seconds) {
            fputs("\(modeName) app mode: waiting \(seconds)s for foreground placement\n", stderr)
            sleep(UInt32(seconds))
        }
        let freshApps: [[String: Any]] = try required(try wire.request("apps.list", [:]), "apps")
        let targetApp = freshApps.first(where: { $0["appId"] as? String == appID })
        print("\(modeName) app mode: running=\(targetApp != nil), frontmost=\(targetApp?["frontmost"] ?? false), hidden=\(targetApp?["hidden"] ?? false)")
        var initialElectronMode: Bool?
        if electronModeOnly, let pid = targetApp?["pid"] as? Int {
            let application = AXUIElementCreateApplication(pid_t(pid))
            var mode: CFTypeRef?
            var windows: CFTypeRef?
            let modeStatus = AXUIElementCopyAttributeValue(application, "AXManualAccessibility" as CFString, &mode)
            let windowsStatus = AXUIElementCopyAttributeValue(application, "AXWindows" as CFString, &windows)
            print("Electron app mode pre-bind: modeStatus=\(modeStatus.rawValue), mode=\(mode.map(String.init(describing:)) ?? "nil"), windowsStatus=\(windowsStatus.rawValue), windowsCount=\((windows as? [AXUIElement])?.count ?? -1)")
            initialElectronMode = mode as? Bool
        }
        let appWindows: [[String: Any]] = try required(try wire.request("windows.list", [
            "appId": appID,
        ]), "windows")
        let matching = appWindows.filter { $0["title"] as? String == fixtureTitle }
        print("\(modeName) app mode: windows=\(appWindows.count), exactFixtureMatches=\(matching.count)")
        guard matching.count == 1, let windowRef = matching[0]["windowRef"] as? String else {
            throw HelperFailure(code: "APP_MODE_FIXTURE_WINDOW_NOT_UNIQUE")
        }
        guard let before = matching[0]["bounds"] as? [String: Double], !before.isEmpty else {
            throw HelperFailure(code: "APP_MODE_FIXTURE_BOUNDS_UNAVAILABLE")
        }
        let bound = try wire.request("target.bind", ["windowRef": windowRef])
        let targetID: String = try required(bound, "targetId")
        let generation: Int = try required(bound, "generation")
        var released = false
        defer {
            if !released { _ = try? wire.request("target.release", ["targetId": targetID]) }
        }
        let snapshot = try observation(wire, targetID: targetID, generation: generation)
        let elements: [[String: Any]] = try required(snapshot, "elements")
        guard !elements.isEmpty else { throw HelperFailure(code: "CHROME_AX_EMPTY") }
        print("\(modeName) app mode: bound fixture window; AX elements=\(elements.count), truncated=\(snapshot["truncated"] ?? false)")
        _ = try wire.request("target.release", ["targetId": targetID])
        released = true
        let afterWindows: [[String: Any]] = try required(try wire.request("windows.list", [
            "appId": appID,
        ]), "windows")
        let after = afterWindows.first(where: { $0["title"] as? String == fixtureTitle })?["bounds"] as? [String: Double] ?? [:]
        guard !after.isEmpty else { throw HelperFailure(code: "APP_MODE_FIXTURE_WINDOW_LOST") }
        print("\(modeName) app mode: released fixture window; boundsChanged=\(before != after)")
        if electronModeOnly, let pid = targetApp?["pid"] as? Int,
           let initialElectronMode {
            let application = AXUIElementCreateApplication(pid_t(pid))
            var modeAfter: CFTypeRef?
            let status = AXUIElementCopyAttributeValue(application,
                                                       "AXManualAccessibility" as CFString, &modeAfter)
            guard status == .success, modeAfter as? Bool == initialElectronMode else {
                throw HelperFailure(code: "ELECTRON_AX_MODE_NOT_RESTORED")
            }
            print("Electron app mode after release: matchesOriginal=true")
        }
        _ = try wire.request("shutdown", [:], deadline: 2_000)
        print("PASS: \(modeName) fixture bind, AX observe and release; inspect Helper APP_MODE stderr lines (EMPEROR_FIXTURE_HELPER_STDERR) for enable/restore")
        return
    }

    if ProcessInfo.processInfo.environment["EMPEROR_FIXTURE_TEXTEDIT_DISCOVERY_ONLY"] == "1" {
        let textEditWindows: [[String: Any]] = try required(try wire.request("windows.list", [
            "appId": "com.apple.TextEdit",
        ]), "windows")
        let titles = textEditWindows.compactMap { $0["title"] as? String }
        print("windows.list TextEdit titles: \(titles)")
        guard titles.contains("未命名") else { throw HelperFailure(code: "TEXTEDIT_WINDOW_MISSING") }
        _ = try wire.request("shutdown", [:], deadline: 2_000)
        print("PASS: background TextEdit window remains discoverable")
        return
    }

    let windows: [[String: Any]] = try required(try wire.request("windows.list", [
        "appId": "com.emperor.agent.axfixture",
    ]), "windows")
    print("windows.list fixture titles: \(windows.compactMap { $0["title"] as? String })")
    guard let window = windows.first(where: { $0["title"] as? String == "Emperor AX Fixture" }),
          let windowRef = window["windowRef"] as? String else { throw HelperFailure(code: "FIXTURE_WINDOW") }
    let bound = try wire.request("target.bind", ["windowRef": windowRef])
    let oldTargetID: String = try required(bound, "targetId")
    let reboundWindows: [[String: Any]] = try required(try wire.request("windows.list", [
        "appId": "com.emperor.agent.axfixture",
    ]), "windows")
    guard let reboundRef = reboundWindows.first(where: {
        $0["title"] as? String == "Emperor AX Fixture"
    })?["windowRef"] as? String else { throw HelperFailure(code: "REBOUND_WINDOW") }
    let rebound = try wire.request("target.bind", ["windowRef": reboundRef])
    let targetID: String = try required(rebound, "targetId")
    let generation: Int = try required(rebound, "generation")
    guard targetID != oldTargetID else { throw HelperFailure(code: "REBOUND_ID_REUSED") }
    do {
        _ = try observation(wire, targetID: oldTargetID, generation: generation)
        throw HelperFailure(code: "OLD_WINDOW_TARGET_ACCEPTED")
    } catch let error as HelperFailure where error.code == "STALE_TARGET" {
        print("target.bind: rebinding same AX window invalidated old target")
    }
    var snapshot = try observation(wire, targetID: targetID, generation: generation)
    let expectedRoles = ["Press Me", "Username", "Password", "Show Sheet", "Move Window"]
    for name in expectedRoles { _ = try element(snapshot, named: name) }
    let roleSet = Set((snapshot["elements"] as? [[String: Any]] ?? []).compactMap { $0["role"] as? String })
    guard ["button", "textbox", "combobox", "table"].allSatisfy(roleSet.contains) else {
        throw HelperFailure(code: "AX_ROLES")
    }
    let password = try element(snapshot, named: "Password")
    guard password["value"] as? String != "fixture-password", password["nativeRole"] as? String != nil else {
        throw HelperFailure(code: "SECURE_OBSERVATION")
    }
    print("observe.semantic: button, text, secure text, popup, table, scroll, sheet controls present")

    if ProcessInfo.processInfo.environment["EMPEROR_FIXTURE_SECURE_PREFLIGHT_ONLY"] == "1" {
        let secureRef: String = try required(password, "ref")
        let revision: Int = try required(snapshot, "revision")
        for (kind, payload) in [
            ("press", ["kind": "press", "key": "A", "ref": secureRef]),
            ("typeText", ["kind": "typeText", "text": "A", "ref": secureRef]),
        ] {
            let operationID = "fixture-secure-preflight-\(kind)"
            do {
                _ = try wire.request("act", ["operationId": operationID, "targetId": targetID,
                    "generation": generation, "expectedRevision": revision,
                    "action": payload])
                throw HelperFailure(code: "SECURE_KEY_ACCEPTED")
            } catch let error as HelperFailure where error.code == "SECURE_INPUT_ACTIVE" {
                guard !wire.dispatched.contains(operationID) else {
                    throw HelperFailure(code: "SECURE_KEY_DISPATCHED")
                }
            }
        }
        let clickID = "fixture-secure-focus-1"
        do {
            _ = try wire.request("act", ["operationId": clickID, "targetId": targetID,
                "generation": generation, "expectedRevision": revision,
                "action": ["kind": "click", "ref": secureRef]])
        } catch let error as HelperFailure where error.code == "OUTCOME_UNKNOWN" {
            // Focus may have changed even if the observer did not see a revision.
        }
        guard wire.dispatched.contains(clickID) else { throw HelperFailure(code: "SECURE_FOCUS_NOT_DISPATCHED") }
        var secureTargetID = targetID
        var secureGeneration = generation
        do {
            snapshot = try observation(wire, targetID: secureTargetID, generation: secureGeneration)
        } catch let error as HelperFailure where error.code == "STALE_TARGET" {
            // Bringing a window forward can change its geometry and retire
            // the old generation. Rebind once; never repeat the click.
            let currentWindows: [[String: Any]] = try required(try wire.request("windows.list", [
                "appId": "com.emperor.agent.axfixture",
            ]), "windows")
            guard let currentRef = currentWindows.first(where: {
                $0["title"] as? String == "Emperor AX Fixture"
            })?["windowRef"] as? String else { throw HelperFailure(code: "SECURE_FOCUS_WINDOW_LOST") }
            let refreshed = try wire.request("target.bind", ["windowRef": currentRef])
            secureTargetID = try required(refreshed, "targetId")
            secureGeneration = try required(refreshed, "generation")
            snapshot = try observation(wire, targetID: secureTargetID, generation: secureGeneration)
            print("secure field focus: rebound after window generation changed")
        }
        let focusedPassword = try element(snapshot, named: "Password")
        guard (focusedPassword["states"] as? [String] ?? []).contains("focused") else {
            throw HelperFailure(code: "SECURE_FOCUS_NOT_OBSERVED")
        }
        let focusedRevision: Int = try required(snapshot, "revision")
        for (kind, payload) in [
            ("press", ["kind": "press", "key": "A"]),
            ("typeText", ["kind": "typeText", "text": "A"]),
        ] {
            let operationID = "fixture-secure-focused-\(kind)"
            do {
                _ = try wire.request("act", ["operationId": operationID, "targetId": secureTargetID,
                    "generation": secureGeneration, "expectedRevision": focusedRevision,
                    "action": payload])
                throw HelperFailure(code: "SECURE_FOCUSED_KEY_ACCEPTED")
            } catch let error as HelperFailure where error.code == "SECURE_INPUT_ACTIVE" {
                guard !wire.dispatched.contains(operationID) else {
                    throw HelperFailure(code: "SECURE_FOCUSED_KEY_DISPATCHED")
                }
            }
        }
        snapshot = try observation(wire, targetID: secureTargetID, generation: secureGeneration)
        let finalElements: [[String: Any]] = try required(snapshot, "elements")
        let passwordCheck = finalElements.first(where: { item in
            (item["name"] as? String ?? "").contains("Password check:") ||
                (item["value"] as? String ?? "").contains("Password check:")
        })
        print("secure field fixture check: \(passwordCheck?["name"] ?? "") \(passwordCheck?["value"] ?? "")")
        guard (passwordCheck?["name"] as? String) == "Password check: empty" ||
              (passwordCheck?["value"] as? String) == "Password check: empty" else {
            throw HelperFailure(code: "SECURE_KEY_CHANGED_PASSWORD")
        }
        _ = try wire.request("shutdown", [:], deadline: 2_000)
        print("PASS: referenced and focused secure field reject press/typeText before dispatch")
        return
    }

    if ProcessInfo.processInfo.environment["EMPEROR_FIXTURE_PREFLIGHT_ONLY"] == "1" {
        let operationID = "fixture-modal-preflight-1"
        let revision: Int = try required(snapshot, "revision")
        do {
            _ = try wire.request("act", ["operationId": operationID, "targetId": targetID,
                "generation": generation, "expectedRevision": revision,
                "action": ["kind": "press", "key": "Tab"]])
            throw HelperFailure(code: "MODAL_PRESS_ACCEPTED")
        } catch let error as HelperFailure where error.code == "TARGET_NOT_VISIBLE" {
            guard !wire.dispatched.contains(operationID) else {
                throw HelperFailure(code: "PREMATURE_MODAL_DISPATCH")
            }
            print("act preflight: modal sheet blocked main-window key before dispatch")
        }
        _ = try wire.request("shutdown", [:], deadline: 2_000)
        print("PASS: modal foreground preflight")
        return
    }

    let screenshotOnly = ProcessInfo.processInfo.environment["EMPEROR_FIXTURE_SCREENSHOT_ONLY"] == "1"
    var fixture: NSRunningApplication?
    for _ in 0..<20 {
        fixture = NSRunningApplication.runningApplications(
            withBundleIdentifier: "com.emperor.agent.axfixture").first
        if fixture != nil { break }
        RunLoop.current.run(until: Date().addingTimeInterval(0.1))
    }
    guard let fixture else { throw HelperFailure(code: "FIXTURE_MISSING") }
    if !screenshotOnly {
        guard fixture.activate(options: []) else {
            throw HelperFailure(code: "FIXTURE_ACTIVATE")
        }
        usleep(1_000_000)
    }
    print("frontmost before screenshot: \(NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? "unknown")")
    let windowsBeforeCapture: [[String: Any]] = try required(try wire.request("windows.list", [
        "appId": "com.emperor.agent.axfixture",
    ]), "windows")
    for item in windowsBeforeCapture where item["title"] as? String == "Emperor AX Fixture" {
        print("fixture window before screenshot: minimized=\(item["minimized"] ?? "unknown"), bounds=\(item["bounds"] ?? "unknown")")
    }

    let firstCapture = try wire.request("observe.screenshot", [
        "targetId": targetID, "generation": generation, "modelCopy": false,
        "modelMaxEdge": 1600,
    ], deadline: 20_000)
    let blobID: String = try required(firstCapture, "blobId")
    let pngBytes = try wire.screenshotBlob(expectedID: blobID)
    guard pngBytes > 100 else { throw HelperFailure(code: "EMPTY_SCREENSHOT") }
    print("observe.screenshot: PNG \(pngBytes) bytes, width=\(firstCapture["width"] ?? "unknown"), height=\(firstCapture["height"] ?? "unknown")")
    if screenshotOnly {
        print("screenshot-only: fixture window=\(window["title"] ?? "unknown"), bounds=\(window["bounds"] ?? "unknown")")
        _ = try wire.request("shutdown", [:], deadline: 2_000)
        print("PASS: existing fixture window AX and screenshot acceptance")
        return
    }
    print("frontmost before actions: \(NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? "unknown")")
    snapshot = try observation(wire, targetID: targetID, generation: generation)

    if ProcessInfo.processInfo.environment["EMPEROR_FIXTURE_MODIFIER_ONLY"] == "1" {
        try runModifierExperiment(wire, targetID: targetID, generation: generation,
                                  snapshot: snapshot, keyEventPath: socketPath + ".keys")
        return
    }
    if ProcessInfo.processInfo.environment["EMPEROR_FIXTURE_POST_TO_PID_ONLY"] == "1" {
        try runPostToPidExperiment(wire, fixture: fixture, keyEventPath: socketPath + ".keys")
        return
    }

    let button = try element(snapshot, named: "Press Me")
    let buttonRef: String = try required(button, "ref")
    let revision: Int = try required(snapshot, "revision")
    let pressID = "fixture-press-1"
    do {
        _ = try wire.request("act", ["operationId": pressID, "targetId": targetID,
            "generation": generation, "expectedRevision": revision,
            "action": ["kind": "click", "ref": buttonRef]])
    } catch let error as HelperFailure where error.code == "OUTCOME_UNKNOWN" {
        // Re-observe after an uncertain action; never replay it.
    }
    guard wire.dispatched.contains(pressID) else { throw HelperFailure(code: "PRESS_NOT_DISPATCHED") }
    snapshot = try observation(wire, targetID: targetID, generation: generation)
    guard let elements = snapshot["elements"] as? [[String: Any]],
          elements.contains(where: { item in
              (item["name"] as? String)?.contains("Status: pressed 1") == true ||
              (item["value"] as? String)?.contains("Status: pressed 1") == true
          }) else {
        throw HelperFailure(code: "PRESS_NOT_OBSERVED")
    }
    print("act AXPress: observed button status")
    try runBackgroundRoutes(wire, targetID: targetID, generation: generation, fixture: fixture)
    snapshot = try observation(wire, targetID: targetID, generation: generation)

    guard let popup = (snapshot["elements"] as? [[String: Any]])?.first(where: {
        $0["role"] as? String == "combobox"
    }) else { throw HelperFailure(code: "POPUP_MISSING") }
    let popupRef: String = try required(popup, "ref")
    let popupRevision: Int = try required(snapshot, "revision")
    let popupID = "fixture-popup-select-1"
    do {
        _ = try wire.request("act", ["operationId": popupID, "targetId": targetID,
            "generation": generation, "expectedRevision": popupRevision,
            "action": ["kind": "select", "ref": popupRef, "option": "Second"]])
    } catch let error as HelperFailure where error.code == "OUTCOME_UNKNOWN" {
        // A dispatched selection is read back without replaying it.
    }
    guard wire.dispatched.contains(popupID) else { throw HelperFailure(code: "POPUP_NOT_DISPATCHED") }
    snapshot = try observation(wire, targetID: targetID, generation: generation)
    guard let afterPopup = (snapshot["elements"] as? [[String: Any]])?.first(where: {
        $0["role"] as? String == "combobox"
    }), afterPopup["value"] as? String == "Second" else {
        throw HelperFailure(code: "POPUP_NOT_OBSERVED")
    }
    print("act select: popup value Second observed")

    let username = try element(snapshot, named: "Username")
    let usernameRef: String = try required(username, "ref")
    let usernameRevision: Int = try required(snapshot, "revision")
    var binding: [String: Any] = ["bundleId": "com.emperor.agent.axfixture", "path": fixtureExecutable]
    if let fixtureTeamID { binding["teamId"] = fixtureTeamID }
    let usernameID = "fixture-username-1"
    let usernameFill = try wire.request("act.fillSecret", [
        "operationId": usernameID, "targetId": targetID, "generation": generation,
        "expectedRevision": usernameRevision, "ref": usernameRef, "field": "username",
        "secret": "fixture-user", "binding": binding,
    ])
    guard usernameFill["filled"] as? Bool == true,
          wire.dispatched.contains(usernameID) else { throw HelperFailure(code: "USERNAME_FILL") }
    print("act.fillSecret username: filled=true")
    snapshot = try observation(wire, targetID: targetID, generation: generation)
    let selectAllRef: String = try required(element(snapshot, named: "Username"), "ref")
    let selectAllRevision: Int = try required(snapshot, "revision")
    let selectAllID = "fixture-select-all-1"
    do {
        _ = try wire.request("act", ["operationId": selectAllID, "targetId": targetID,
            "generation": generation, "expectedRevision": selectAllRevision,
            "action": ["kind": "press", "key": "Meta+A", "ref": selectAllRef]])
    } catch let error as HelperFailure where error.code == "OUTCOME_UNKNOWN" {
        // A selection may have happened even when no revision was observed.
    }
    guard wire.dispatched.contains(selectAllID) else { throw HelperFailure(code: "KEY_NOT_DISPATCHED") }
    snapshot = try observation(wire, targetID: targetID, generation: generation)
    let typeRef: String = try required(element(snapshot, named: "Username"), "ref")
    let typeRevision: Int = try required(snapshot, "revision")
    let typeID = "fixture-unicode-1"
    let inputSourceBefore = currentInputSourceID()
    do {
        _ = try wire.request("act", ["operationId": typeID, "targetId": targetID,
            "generation": generation, "expectedRevision": typeRevision,
            "action": ["kind": "typeText", "text": "中A", "ref": typeRef]])
    } catch let error as HelperFailure where error.code == "OUTCOME_UNKNOWN" {
        // Re-observe and inspect the actual field value, without replay.
    }
    guard wire.dispatched.contains(typeID) else { throw HelperFailure(code: "TEXT_NOT_DISPATCHED") }
    snapshot = try observation(wire, targetID: targetID, generation: generation)
    guard try element(snapshot, named: "Username")["value"] as? String == "中A" else {
        throw HelperFailure(code: "KEYBOARD_OR_IME_MISMATCH")
    }
    let inputSourceAfter = currentInputSourceID()
    guard let inputSourceBefore, inputSourceBefore == inputSourceAfter else {
        throw HelperFailure(code: "INPUT_SOURCE_NOT_RESTORED")
    }
    print("act press/typeText: focus, Meta+A, mixed Unicode input observed; input source restored: \(inputSourceAfter ?? "unknown")")

    func clearUsername(_ operationID: String) throws {
        let ref: String = try required(element(snapshot, named: "Username"), "ref")
        let revision: Int = try required(snapshot, "revision")
        _ = try wire.request("act", ["operationId": operationID, "targetId": targetID,
            "generation": generation, "expectedRevision": revision,
            "action": ["kind": "fill", "ref": ref, "text": ""]])
        snapshot = try observation(wire, targetID: targetID, generation: generation)
        guard try element(snapshot, named: "Username")["value"] as? String ?? "" == "" else {
            throw HelperFailure(code: "TYPE_TARGET_NOT_EMPTY")
        }
    }
    try clearUsername("fixture-clear-for-long-type-1")
    let longText = "emperor-background-fixture-ABCDEFGHIJKLMNOPQRSTUVWXYZ-0123456789"
    let longRef: String = try required(element(snapshot, named: "Username"), "ref")
    let longRevision: Int = try required(snapshot, "revision")
    let longID = "fixture-long-type-1"
    do {
        _ = try wire.request("act", ["operationId": longID, "targetId": targetID,
            "generation": generation, "expectedRevision": longRevision,
            "action": ["kind": "typeText", "text": longText, "ref": longRef]])
    } catch let error as HelperFailure where error.code == "OUTCOME_UNKNOWN" {
        // Keys may have landed despite a delayed AX notification; inspect once, never replay them.
    }
    guard wire.dispatched.contains(longID) else { throw HelperFailure(code: "LONG_TYPE_NOT_DISPATCHED") }
    snapshot = try observation(wire, targetID: targetID, generation: generation)
    guard try element(snapshot, named: "Username")["value"] as? String == longText else {
        throw HelperFailure(code: "LONG_TYPE_MISMATCH")
    }
    print("act typeText: long text typed into the process, no clipboard")

    // Append keeps what is there: the field must read the old text plus the
    // appended one, with the app left where it is.
    let appendText = "+appended"
    let appendRef: String = try required(element(snapshot, named: "Username"), "ref")
    let appendRevision: Int = try required(snapshot, "revision")
    let appendID = "fixture-append-text-1"
    do {
        _ = try wire.request("act", ["operationId": appendID, "targetId": targetID,
            "generation": generation, "expectedRevision": appendRevision,
            "action": ["kind": "appendText", "text": appendText, "ref": appendRef]])
    } catch let error as HelperFailure where error.code == "OUTCOME_UNKNOWN" {
        // Inspect once, never replay.
    }
    guard wire.dispatched.contains(appendID) else { throw HelperFailure(code: "APPEND_NOT_DISPATCHED") }
    snapshot = try observation(wire, targetID: targetID, generation: generation)
    guard try element(snapshot, named: "Username")["value"] as? String == longText + appendText else {
        throw HelperFailure(code: "APPEND_MISMATCH")
    }
    print("act appendText: text inserted at the end, earlier text untouched")

    try clearUsername("fixture-clear-for-cancel-type-1")
    let cancelText = String(repeating: "emperor-cancel-", count: 30)
    let cancelRef: String = try required(element(snapshot, named: "Username"), "ref")
    let cancelRevision: Int = try required(snapshot, "revision")
    let cancelID = "fixture-cancel-type-1"
    do {
        _ = try wire.request("act", ["operationId": cancelID, "targetId": targetID,
            "generation": generation, "expectedRevision": cancelRevision,
            "action": ["kind": "typeText", "text": cancelText, "ref": cancelRef]],
            cancelOnDispatch: true)
        throw HelperFailure(code: "TYPE_CANCEL_NOT_REJECTED")
    } catch let error as HelperFailure where error.code == "USER_TAKEOVER" || error.code == "CANCELLED" {
        // Some chunks may have landed before the stop. Never replay the action.
    }
    guard wire.dispatched.contains(cancelID) else { throw HelperFailure(code: "TYPE_CANCEL_NOT_DISPATCHED") }
    snapshot = try observation(wire, targetID: targetID, generation: generation)
    let partial = try element(snapshot, named: "Username")["value"] as? String ?? ""
    guard partial.count < cancelText.count, cancelText.hasPrefix(partial) else {
        throw HelperFailure(code: "TYPE_CANCEL_NOT_PREFIX")
    }
    print("act typeText: stop between chunks left a strict prefix (\(partial.count) of \(cancelText.count) characters)")

    var pointCapture: [String: Any]?
    for attempt in 1...3 {
        do {
            pointCapture = try wire.request("observe.screenshot", [
                "targetId": targetID, "generation": generation, "modelCopy": false,
                "modelMaxEdge": 1600,
            ], deadline: 20_000)
            break
        } catch let error as HelperFailure where error.code == "STALE_TARGET" && attempt < 3 {
            snapshot = try observation(wire, targetID: targetID, generation: generation)
        }
    }
    guard let pointCapture else { throw HelperFailure(code: "CANVAS_SCREENSHOT_RETRY_EXHAUSTED") }
    _ = try wire.screenshotBlob(expectedID: required(pointCapture, "blobId"))
    let canvas = try element(snapshot, named: "Painted Canvas")
    let canvasBounds: [String: Double] = try required(canvas, "bounds")
    let windowBounds: [String: Double] = try required(window, "bounds")
    let screenshotID: String = try required(pointCapture, "screenshotId")
    let scale: Double = try required(pointCapture, "scale")
    guard let canvasX = canvasBounds["x"], let canvasY = canvasBounds["y"],
          let canvasWidth = canvasBounds["width"], let canvasHeight = canvasBounds["height"],
          let windowX = windowBounds["x"], let windowY = windowBounds["y"] else {
        throw HelperFailure(code: "CANVAS_BOUNDS")
    }
    let point: [String: Any] = ["screenshotId": screenshotID,
                                "x": (canvasX + canvasWidth / 2 - windowX) * scale,
                                "y": (canvasY + canvasHeight / 2 - windowY) * scale]
    let canvasRevision: Int = try required(snapshot, "revision")
    let canvasID = "fixture-canvas-1"
    do {
        _ = try wire.request("act", ["operationId": canvasID, "targetId": targetID,
            "generation": generation, "expectedRevision": canvasRevision,
            "action": ["kind": "clickPoint", "point": point]])
    } catch let error as HelperFailure where error.code == "OUTCOME_UNKNOWN" {
        // An uncertain click is re-observed and never replayed.
    }
    guard wire.dispatched.contains(canvasID) else { throw HelperFailure(code: "CANVAS_NOT_DISPATCHED") }
    snapshot = try observation(wire, targetID: targetID, generation: generation)
    guard let canvasElements = snapshot["elements"] as? [[String: Any]],
          canvasElements.contains(where: { item in
              (item["name"] as? String)?.contains("Status: canvas clicked") == true ||
              (item["value"] as? String)?.contains("Status: canvas clicked") == true
          }) else {
        throw HelperFailure(code: "CANVAS_CLICK_NOT_OBSERVED")
    }
    print("screenshot point click: window origin (\(windowX), \(windowY)), scale \(scale), canvas clicked")
    if ProcessInfo.processInfo.environment["EMPEROR_FIXTURE_LEFT_DISPLAY"] == "1", windowX >= 0 {
        print("left-display: NOT APPLICABLE, no display lies left of the main one")
    }
    print("act clickPoint: painted canvas status observed")

    let pointerPath = socketPath + ".pointer"
    let dragID = "fixture-cancel-held-drag-1"
    var dragCancelled = false
    for attempt in 1...3 {
        snapshot = try observation(wire, targetID: targetID, generation: generation)
        try? FileManager.default.removeItem(atPath: pointerPath)
        let dragRef: String = try required(element(snapshot, named: "Painted Canvas"), "ref")
        let dragRevision: Int = try required(snapshot, "revision")
        do {
            _ = try wire.request("act", ["operationId": dragID, "targetId": targetID,
                "generation": generation, "expectedRevision": dragRevision,
                "action": ["kind": "drag", "from": dragRef, "to": dragRef]],
                cancelWhenPointerDownAt: pointerPath,
                releaseAllAfterPointerCancel: true)
            throw HelperFailure(code: "HELD_DRAG_CANCEL_NOT_REJECTED")
        } catch let error as HelperFailure where error.code == "USER_TAKEOVER" || error.code == "CANCELLED" {
            // The disposable canvas may have received some drag events before cancellation.
            dragCancelled = true
            break
        } catch let error as HelperFailure where error.code == "STALE_TARGET" && attempt < 3 {
            // No event was sent, so only a fresh observation is needed.
            guard !wire.dispatched.contains(dragID) else { throw error }
        }
    }
    guard dragCancelled, wire.dispatched.contains(dragID) else {
        throw HelperFailure(code: "HELD_DRAG_NOT_CANCELLED_AFTER_DISPATCH")
    }
    let pointerUpDeadline = Date().addingTimeInterval(1)
    while Date() < pointerUpDeadline,
          (try? String(contentsOfFile: pointerPath, encoding: .utf8)) != "up" {
        usleep(1_000)
    }
    guard (try? String(contentsOfFile: pointerPath, encoding: .utf8)) == "up" else {
        throw HelperFailure(code: "HELD_DRAG_MOUSE_UP_MISSING")
    }
    snapshot = try observation(wire, targetID: targetID, generation: generation)
    print("act drag: cancel plus releaseAll acknowledged after real mouse down; mouse up delivered")

    snapshot = try observation(wire, targetID: targetID, generation: generation)
    let passwordRef: String = try required(element(snapshot, named: "Password"), "ref")
    let passwordRevision: Int = try required(snapshot, "revision")
    let passwordID = "fixture-password-1"
    var passwordWasDispatched = false
    do {
        let result = try wire.request("act.fillSecret", [
            "operationId": passwordID, "targetId": targetID, "generation": generation,
            "expectedRevision": passwordRevision, "ref": passwordRef, "field": "password",
            "secret": "fixture-password", "binding": binding,
        ])
        guard result["filled"] as? Bool == true else { throw HelperFailure(code: "PASSWORD_EMPTY") }
        passwordWasDispatched = true
        print("act.fillSecret password: filled=true (value never returned)")
    } catch let error as HelperFailure where error.code == "OUTCOME_UNKNOWN" {
        guard wire.dispatched.contains(passwordID) else {
            throw HelperFailure(code: "PASSWORD_NOT_DISPATCHED")
        }
        passwordWasDispatched = true
        print("act.fillSecret password: outcome unknown; checking fixture without replay")
    } catch let error as HelperFailure where error.code == "SECURE_INPUT_ACTIVE" {
        print("act.fillSecret password: SECURE_INPUT_ACTIVE (AX secure field refused setValue)")
    }

    usleep(200_000)
    snapshot = try observation(wire, targetID: targetID, generation: generation)
    if passwordWasDispatched {
        let checkElements: [[String: Any]] = try required(snapshot, "elements")
        guard checkElements.contains(where: { item in
            (item["name"] as? String)?.contains("Password check: matched") == true ||
            (item["value"] as? String)?.contains("Password check: matched") == true
        }) else { throw HelperFailure(code: "PASSWORD_NOT_APPLIED") }
        print("fixture password check: matched without exposing plaintext")
    }
    let secure = try element(snapshot, named: "Password")
    guard !String(describing: secure).contains("fixture-password") else {
        throw HelperFailure(code: "SECRET_LEAK")
    }
    print("observe.semantic: password plaintext absent")
    print("observe.screenshot: checking capture after password fill")
    var oldCapture: [String: Any]?
    for attempt in 1...3 {
        do {
            oldCapture = try wire.request("observe.screenshot", [
                "targetId": targetID, "generation": generation, "modelCopy": false,
                "modelMaxEdge": 1600,
            ], deadline: 20_000)
            break
        } catch let error as HelperFailure where error.code == "STALE_TARGET" && attempt < 3 {
            print("observe.screenshot: stale revision; refreshing observation")
            snapshot = try observation(wire, targetID: targetID, generation: generation)
        }
    }
    guard let oldCapture else { throw HelperFailure(code: "SCREENSHOT_RETRY_EXHAUSTED") }
    _ = try wire.screenshotBlob(expectedID: required(oldCapture, "blobId"))
    let oldScreenshotID: String = try required(oldCapture, "screenshotId")
    print("observe.screenshot: checking stale point after window movement")
    let oldRevision: Int = try required(snapshot, "revision")
    let moveRef: String = try required(element(snapshot, named: "Move Window"), "ref")
    let moveID = "fixture-move-1"
    do {
        _ = try wire.request("act", ["operationId": moveID, "targetId": targetID,
            "generation": generation, "expectedRevision": oldRevision,
            "action": ["kind": "click", "ref": moveRef]])
    } catch let error as HelperFailure where error.code == "OUTCOME_UNKNOWN" {
        // The target generation may have changed during this action.
    }
    guard wire.dispatched.contains(moveID) else { throw HelperFailure(code: "MOVE_NOT_DISPATCHED") }
    do {
        _ = try wire.request("act", ["operationId": "fixture-stale-point-1",
            "targetId": targetID, "generation": generation, "expectedRevision": oldRevision,
            "action": ["kind": "clickPoint", "point": [
                "screenshotId": oldScreenshotID, "x": point["x"]!, "y": point["y"]!,
            ]]])
        throw HelperFailure(code: "STALE_POINT_ACCEPTED")
    } catch let error as HelperFailure where error.code == "STALE_TARGET" {
        print("act clickPoint: old screenshot rejected after window movement")
    }
    _ = try wire.request("input.releaseAll", [:], deadline: 1_000)
    guard fixture.terminate() else { throw HelperFailure(code: "FIXTURE_TERMINATE") }
    for _ in 0..<20 where !wire.lostTargets.contains(targetID) {
        usleep(250_000)
        _ = try wire.request("permissions.status", [:], deadline: 2_000)
    }
    guard wire.lostTargets.contains(targetID) else { throw HelperFailure(code: "EXIT_TARGET_NOT_LOST") }
    print("target.lost: fixture process exit removed bound target")
    _ = try wire.request("shutdown", [:], deadline: 2_000)
    print("PASS: fixture AX roles, focus/IME, screenshot, AXPress, held-drag cancellation, credential fill, stale point, releaseAll, process exit")
}

do {
    try run()
} catch let failure as HelperFailure {
    fputs("FAIL: \(failure.code)\n", stderr)
    exit(1)
} catch {
    fputs("FAIL: integration runner unavailable\n", stderr)
    exit(1)
}
