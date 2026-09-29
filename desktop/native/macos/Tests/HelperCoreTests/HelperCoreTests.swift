import Foundation
import HelperCore
import XCTest

final class HelperCoreTests: XCTestCase {
    private var repository: URL {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<6 { url.deleteLastPathComponent() }
        return url
    }

    private func fixture(_ name: String) throws -> [String: Any] {
        let url = repository.appendingPathComponent("packages/core/src/harness/computer-use/protocol/fixtures/\(name).json")
        return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
    }

    private func bytes(hex: String) -> Data {
        Data(stride(from: 0, to: hex.count, by: 2).map { index in
            let begin = hex.index(hex.startIndex, offsetBy: index)
            let end = hex.index(begin, offsetBy: 2)
            return UInt8(hex[begin..<end], radix: 16)!
        })
    }

    func testSharedGoldenMessages() throws {
        let entries = try XCTUnwrap(fixture("messages")["messages"] as? [[String: Any]])
        XCTAssertGreaterThan(entries.count, 0)
        for entry in entries {
            let object = try XCTUnwrap(entry["message"] as? [String: Any])
            let wire = try HelperProtocol.encode(object)
            let decoded = try HelperProtocol.decode(wire)
            let left = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
            let right = try JSONSerialization.data(withJSONObject: decoded, options: [.sortedKeys])
            XCTAssertEqual(left, right, "fixture \(entry["name"] ?? "?")")
        }
    }

    func testSharedGoldenFrames() throws {
        let entries = try XCTUnwrap(fixture("frames")["frames"] as? [[String: Any]])
        for entry in entries {
            let raw = bytes(hex: try XCTUnwrap(entry["hex"] as? String))
            var decoder = FrameDecoder()
            XCTAssertTrue(try decoder.push(raw.prefix(2)).isEmpty)
            let frames = try decoder.push(raw.dropFirst(2))
            XCTAssertEqual(frames.count, 1)
            switch try XCTUnwrap(frames.first) {
            case .json(let data):
                let value = try HelperProtocol.decode(data)
                let encoded = try Framing.encodeJSON(HelperProtocol.encode(value))
                XCTAssertEqual(encoded, raw)
            case .blob(let id, let data):
                XCTAssertEqual(id, entry["blobId"] as? String)
                XCTAssertEqual(try Framing.encodeBlob(id: id, bytes: data), raw)
            }
        }
    }

    func testFramingLimitsAndPoisonedDecoder() throws {
        XCTAssertThrowsError(try Framing.encodeJSON(Data(repeating: 65, count: Framing.maxJSONBytes + 1)))
        XCTAssertThrowsError(try Framing.encodeBlob(id: "bad/id", bytes: Data()))
        var decoder = FrameDecoder()
        XCTAssertThrowsError(try decoder.push(Data([0x02, 0, 0, 1])))
        XCTAssertThrowsError(try decoder.push(Data()))
        XCTAssertLessThanOrEqual(decoder.pendingBytes, 4)
        var invalidUTF8 = FrameDecoder()
        XCTAssertThrowsError(try invalidUTF8.push(Data([0, 0, 0, 2, 1, 0xff])))
    }

    func testMessagesRejectUnknownKeysInvalidVersionAndExcessBudget() throws {
        XCTAssertThrowsError(try HelperProtocol.encode(["type": "ping", "seq": 1, "extra": true]))
        XCTAssertThrowsError(try HelperProtocol.encode(["type": "request", "id": 1,
            "method": "observe.semantic", "params": ["budget": ["maxElements": 201, "maxTextBytes": 0,
            "maxDepth": 8, "timeoutMs": 3000]], "deadlineMs": 5000]))
        XCTAssertThrowsError(try ObservationBudget(json: ["maxElements": true,
            "maxTextBytes": 0, "maxDepth": 8, "timeoutMs": 3000]))
        XCTAssertThrowsError(try HelperProtocol.decode(Data("[]".utf8)))
    }

    func testObservationBudget() throws {
        let deeper = try ObservationBudget(json: ["maxElements": 200, "maxTextBytes": 16_384,
            "maxDepth": 16, "timeoutMs": 3_000])
        XCTAssertEqual(deeper.maxDepth, 16)
        XCTAssertThrowsError(try ObservationBudget(json: ["maxElements": 200, "maxTextBytes": 16_384,
            "maxDepth": 17, "timeoutMs": 3_000]))
        var tracker = BudgetTracker(budget: ObservationBudget(maxElements: 2, maxTextBytes: 3, maxDepth: 2, timeoutMs: 3_000))
        try tracker.consume(depth: 0, text: "é")
        try tracker.consume(depth: 2, text: "x")
        XCTAssertEqual(tracker.usedTextBytes, 3)
        XCTAssertThrowsError(try tracker.consume(depth: 1, text: nil))
        var other = BudgetTracker(budget: ObservationBudget(maxElements: 2, maxTextBytes: 2, maxDepth: 2, timeoutMs: 3_000))
        XCTAssertThrowsError(try other.consume(depth: 0, text: "abc"))
        XCTAssertEqual(other.usedElements, 0)
    }

    func testCoordinatesRolesKeysAndProtectedTargets() throws {
        let window = Rect(x: -500, y: 100, width: 400, height: 300)
        XCTAssertEqual(try Coordinates.screenshotToGlobal(pixel: Point(x: 200, y: 100), window: window, scale: 2),
                       Point(x: -400, y: 150))
        XCTAssertThrowsError(try Coordinates.screenshotToGlobal(pixel: Point(x: 800, y: 0), window: window, scale: 2))
        XCTAssertEqual(AXRoleMapper.role("AXTextField", subrole: "AXSearchField"), "searchbox")
        XCTAssertEqual(AXRoleMapper.role("AXSecureTextField"), "textbox")
        XCTAssertEqual(AXRoleMapper.role("AXRadioButton", parentRole: "AXTabGroup"), "tab")
        XCTAssertEqual(KeyMapper.virtualKey(for: "Enter"), 36)
        XCTAssertEqual(KeyMapper.modifier("Meta"), "command")
        XCTAssertTrue(ProtectedTargets.contains(bundleID: "com.emperor.agent.desktop.helper.Renderer"))
        XCTAssertTrue(ProtectedTargets.contains(bundleID: "com.apple.SecurityAgent"))
        XCTAssertTrue(ProtectedTargets.contains(bundleID: "com.apple.systempreferences.GeneralSettings"))
        XCTAssertTrue(ProtectedTargets.contains(bundleID: "com.apple.HeadphoneSettings"))
        XCTAssertFalse(ProtectedTargets.contains(bundleID: "com.apple.systempreferencesMalicious"))
        XCTAssertFalse(ProtectedTargets.contains(bundleID: "com.apple.TextEdit"))
        XCTAssertFalse(ProtectedTargets.contains(bundleID: "com.emperor.agent.desktop.evil.example".replacingOccurrences(of: "desktop.evil", with: "desktop-evil")))
    }

    func testProtectedTargetsCoverAuthorizationSettingsAndEmperorIdentities() {
        for bundleID in [
            "com.apple.CoreAuthUI", "com.apple.LocalAuthentication.UIAgent", "com.apple.UserNotificationCenter",
            "com.apple.keychainaccess", "com.apple.Passwords",
            "com.apple.loginwindow", "com.apple.ScreenSaver.Engine",
            "com.apple.systempreferences", "com.emperor.agent.desktop",
            "com.emperor.agent.desktop.computer-helper",
            "COM.EMPEROR.AGENT.DESKTOP.COMPUTER-HELPER",
        ] {
            XCTAssertTrue(ProtectedTargets.contains(bundleID: bundleID), bundleID)
        }
        // Exact identifiers do not grow into prefix or substring matches.
        for bundleID in [
            "com.apple.loginwindowx", "com.apple.keychainaccessory", "com.apple.PasswordsX",
            "com.apple.ScreenSaver", "com.emperor.agent.desktopx", "com.emperor.agent",
        ] {
            XCTAssertFalse(ProtectedTargets.contains(bundleID: bundleID), bundleID)
        }
        // The helper stays forbidden even if it shares the verified peer's pid.
        XCTAssertTrue(ProtectedTargets.blocksForegroundAction(
            bundleID: "com.emperor.agent.desktop.computer-helper", executablePath: nil,
            pid: 42, verifiedMainPID: 42))
    }

    func testProtectedTargetsMatchEmperorBundlesByExecutablePath() {
        let renamed = "com.example.renamed"
        for path in [
            "/Applications/Emperor Agent.app/Contents/MacOS/Emperor Agent",
            "/Applications/Emperor Agent.app/Contents/Frameworks/Emperor Agent Helper (Renderer).app/Contents/MacOS/Emperor Agent Helper (Renderer)",
            "/Users/a/.emperor/native-helpers/0123456789abcdef0123456789abcdef01234567/Emperor Computer Helper.app/Contents/MacOS/emperor-computer-helper",
            "/VOLUMES/X/EMPEROR AGENT.APP/CONTENTS/MACOS/EMPEROR AGENT",
        ] {
            XCTAssertTrue(ProtectedTargets.contains(bundleID: renamed, executablePath: path), path)
        }
        for path in [
            "/Applications/Emperor Agent Tools.app/Contents/MacOS/Tool",
            "/Applications/Emperor Agent.app",
            "/tmp/Emperor Computer Helper.app.bak/Contents/MacOS/emperor-computer-helper",
            "/Applications/TextEdit.app/Contents/MacOS/TextEdit",
        ] {
            XCTAssertFalse(ProtectedTargets.contains(bundleID: renamed, executablePath: path), path)
        }
        XCTAssertFalse(ProtectedTargets.contains(bundleID: renamed, executablePath: nil))
    }

    func testHeartbeatToleratesThreeMissedPingsBeforeDeclaringThePeerLost() {
        var heartbeat = HeartbeatTracker(maxMissed: 3)
        XCTAssertEqual(heartbeat.nextPing(), 1)
        XCTAssertEqual(heartbeat.nextPing(), 2)
        XCTAssertEqual(heartbeat.nextPing(), 3)
        XCTAssertEqual(heartbeat.outstanding, 3)
        // The fourth ping falls due with three unanswered: the peer is lost.
        XCTAssertNil(heartbeat.nextPing())
        XCTAssertNil(heartbeat.nextPing())

        var answered = HeartbeatTracker(maxMissed: 3)
        for expected in 1...10 {
            XCTAssertEqual(answered.nextPing(), expected)
            answered.acknowledge(expected)
        }
        XCTAssertEqual(answered.outstanding, 0)

        // A late pong clears only the pings up to it; later ones still count.
        var late = HeartbeatTracker(maxMissed: 3)
        _ = late.nextPing(); _ = late.nextPing(); _ = late.nextPing()
        late.acknowledge(1)
        XCTAssertEqual(late.outstanding, 2)
        XCTAssertEqual(late.nextPing(), 4)
        XCTAssertNil(late.nextPing())

        // Duplicate, stale, and never-sent sequence numbers are ignored.
        var strict = HeartbeatTracker(maxMissed: 3)
        _ = strict.nextPing(); _ = strict.nextPing()
        strict.acknowledge(7)
        XCTAssertEqual(strict.outstanding, 2)
        strict.acknowledge(2)
        strict.acknowledge(1)
        XCTAssertEqual(strict.outstanding, 0)
        XCTAssertEqual(strict.nextPing(), 3)
        strict.acknowledge(2)
        XCTAssertEqual(strict.outstanding, 1)
    }

    func testObservationCursorIsBoundToGenerationRevisionAndRange() {
        let cursor = ObservationCursor.encode(generation: 2, revision: 5, offset: 17)
        XCTAssertEqual(cursor, "g2-r5-o17")
        XCTAssertEqual(ObservationCursor.offset(cursor, generation: 2, revision: 5), 17)
        XCTAssertNil(ObservationCursor.offset(cursor, generation: 3, revision: 5))
        XCTAssertNil(ObservationCursor.offset(cursor, generation: 2, revision: 6))
        XCTAssertNil(ObservationCursor.offset("g2-r55-o1", generation: 2, revision: 5))
        for malformed in ["g2-r5-o", "g2-r5-o-1", "g2-r5-o+1", "g2-r5-o1x", "g2-r5-o 1",
                          "g2-r5-o10000", "g2-r5-o999999999999999999999"] {
            XCTAssertNil(ObservationCursor.offset(malformed, generation: 2, revision: 5), malformed)
        }
        XCTAssertEqual(ObservationCursor.offset("g2-r5-o9999", generation: 2, revision: 5), 9_999)

        XCTAssertEqual(ObservationCursor.next(truncated: true, depthLimited: false, nextIndex: 40,
                                              generation: 2, revision: 5), "g2-r5-o40")
        XCTAssertNil(ObservationCursor.next(truncated: false, depthLimited: false, nextIndex: 40,
                                            generation: 2, revision: 5))
        // Depth truncation and the traversal cap cannot be resumed by cursor.
        XCTAssertNil(ObservationCursor.next(truncated: true, depthLimited: true, nextIndex: 40,
                                            generation: 2, revision: 5))
        XCTAssertNil(ObservationCursor.next(truncated: true, depthLimited: false,
                                            nextIndex: ObservationCursor.maxOffset,
                                            generation: 2, revision: 5))
    }

    func testTerminalTextKeepsTheNewestOutput() {
        XCTAssertEqual(UTF8Text.tail("short", maximumBytes: 10), "short")
        XCTAssertEqual(UTF8Text.tail("old line\nnew line", maximumBytes: 11), "…new line")
        XCTAssertEqual(UTF8Text.tail("x中文", maximumBytes: 7), "x中文")
        XCTAssertEqual(UTF8Text.tail("x中文", maximumBytes: 6), "…文")
        XCTAssertEqual(UTF8Text.tail("abcdef", maximumBytes: 3), "")
        // A combining sequence is never split.
        XCTAssertEqual(UTF8Text.tail("abc e\u{301}", maximumBytes: 6), "…e\u{301}")
    }

    func testObservationTextClipsWholeCharactersWithinUTF8Budget() {
        XCTAssertEqual(UTF8Text.prefix("abc", maximumBytes: 0), "")
        XCTAssertEqual(UTF8Text.prefix("abc", maximumBytes: -1), "")
        XCTAssertEqual(UTF8Text.prefix("abc", maximumBytes: 10), "abc")
        XCTAssertEqual(UTF8Text.prefix("aé中", maximumBytes: 2), "a")
        XCTAssertEqual(UTF8Text.prefix("aé中", maximumBytes: 3), "aé")
        XCTAssertEqual(UTF8Text.prefix("aé中", maximumBytes: 5), "aé")
        XCTAssertEqual(UTF8Text.prefix("aé中", maximumBytes: 6), "aé中")
        // A combining sequence or emoji is never split into invalid parts.
        XCTAssertEqual(UTF8Text.prefix("e\u{301}x", maximumBytes: 2), "")
        XCTAssertEqual(UTF8Text.prefix("e\u{301}x", maximumBytes: 3), "e\u{301}")
        XCTAssertEqual(UTF8Text.prefix("👍🏽ok", maximumBytes: 7), "")
        XCTAssertEqual(UTF8Text.prefix("👍🏽ok", maximumBytes: 9), "👍🏽o")
    }

    func testDiagnosticLinesCarryOnlyStableTokens() {
        XCTAssertEqual(HelperDiagnostic.line("PEER_REJECTED", ["reason": "nonce"]),
                       "Emperor Computer Helper: PEER_REJECTED reason=nonce")
        XCTAssertEqual(HelperDiagnostic.line("APP_MODE", ["pid": "42", "activePIDs": "1,2", "ok": "true"]),
                       "Emperor Computer Helper: APP_MODE pid=42 activePIDs=1,2 ok=true")
        // Paths, spaces, newlines, quotes and non-ASCII cannot pass through.
        let line = HelperDiagnostic.line("bad code\n", ["k\ney": "/Users/a b/\"x\"\nFAKE é"])
        XCTAssertFalse(line.contains("\n"))
        XCTAssertFalse(line.contains("/"))
        XCTAssertFalse(line.contains(" b"))
        XCTAssertTrue(line.hasPrefix("Emperor Computer Helper: "))
        XCTAssertEqual(line.split(separator: " ").count, 5)
        let long = HelperDiagnostic.line("X", ["v": String(repeating: "a", count: 500)])
        XCTAssertLessThanOrEqual(long.utf8.count, "Emperor Computer Helper: X v=".utf8.count + 64)
        XCTAssertEqual(HelperDiagnostic.line("", ["": ""]), "Emperor Computer Helper: UNKNOWN field=-")
    }

    func testVerifiedMainAppForegroundDoesNotBlockActionsOnAnotherBoundTarget() {
        XCTAssertFalse(ProtectedTargets.blocksForegroundAction(
            bundleID: "com.emperor.agent.desktop", executablePath: "/tmp/Emperor Agent.app/Contents/MacOS/Emperor Agent",
            pid: 42, verifiedMainPID: 42))
        XCTAssertTrue(ProtectedTargets.contains(bundleID: "com.emperor.agent.desktop"))
        XCTAssertTrue(ProtectedTargets.blocksForegroundAction(
            bundleID: "com.emperor.agent.desktop", executablePath: nil,
            pid: 42, verifiedMainPID: nil))
        XCTAssertTrue(ProtectedTargets.blocksForegroundAction(
            bundleID: "com.emperor.agent.desktop", executablePath: "/tmp/Emperor Agent.app/Contents/MacOS/Emperor Agent",
            pid: 43, verifiedMainPID: 42))
        XCTAssertTrue(ProtectedTargets.blocksForegroundAction(
            bundleID: "com.apple.SecurityAgent", executablePath: nil,
            pid: 43, verifiedMainPID: 42))
        XCTAssertTrue(ProtectedTargets.blocksForegroundAction(
            bundleID: "com.emperor.agent.desktop.helper.Renderer", executablePath: nil,
            pid: 42, verifiedMainPID: 42))
        XCTAssertFalse(ProtectedTargets.blocksForegroundAction(
            bundleID: "com.apple.TextEdit", executablePath: nil,
            pid: 43, verifiedMainPID: 42))
    }

    func testScreenshotWindowMatchRequiresUniquePIDFrameAndTitle() {
        let ax = WindowFingerprint(pid: 42, title: "Document", frame: Rect(x: 10, y: 20, width: 300, height: 200))
        let correct = ScreenshotWindow(id: 5, pid: 42, title: "Document", frame: Rect(x: 10.5, y: 20, width: 300, height: 200))
        let otherPID = ScreenshotWindow(id: 6, pid: 43, title: "Document", frame: correct.frame)
        let otherTitle = ScreenshotWindow(id: 7, pid: 42, title: "Other", frame: correct.frame)
        XCTAssertEqual(WindowMatcher.uniqueMatch(ax: ax, candidates: [otherPID, otherTitle, correct]), 5)
        XCTAssertNil(WindowMatcher.uniqueMatch(ax: ax, candidates: [correct, correct]))
        XCTAssertNil(WindowMatcher.uniqueMatch(ax: ax, candidates: [otherPID, otherTitle]))
        XCTAssertNil(WindowMatcher.uniqueMatch(ax: ax, candidates: [
            ScreenshotWindow(id: 8, pid: 42, title: "Document",
                             frame: Rect(x: 11.1, y: 20, width: 300, height: 200)),
        ]))
    }

    func testScreenshotPrefersTheBoundWindowWhileCoreGraphicsStillTiesItToTheTarget() {
        let ax = WindowFingerprint(pid: 42, title: "Document", frame: Rect(x: 0, y: 33, width: 720, height: 832))
        let cg = ScreenshotWindow(id: 5, pid: 42, title: "Document", frame: ax.frame)
        // ScreenCaptureKit reports the same window a few points off.
        let scOff = ScreenshotWindow(id: 5, pid: 42, title: "Document",
                                     frame: Rect(x: 0, y: 38, width: 720, height: 832))
        XCTAssertEqual(WindowMatcher.screenshotWindowID(ax: ax, boundID: 5, cgCandidates: [cg],
                                                        scCandidates: [scOff]), 5)
        // Without a bound ID, or once CoreGraphics no longer ties it uniquely,
        // only an exact ScreenCaptureKit match counts.
        XCTAssertNil(WindowMatcher.screenshotWindowID(ax: ax, boundID: nil, cgCandidates: [cg],
                                                      scCandidates: [scOff]))
        XCTAssertNil(WindowMatcher.screenshotWindowID(ax: ax, boundID: 5, cgCandidates: [cg, cg],
                                                      scCandidates: [scOff]))
        XCTAssertNil(WindowMatcher.screenshotWindowID(ax: ax, boundID: 9, cgCandidates: [cg],
                                                      scCandidates: [scOff]))
        XCTAssertEqual(WindowMatcher.screenshotWindowID(ax: ax, boundID: nil, cgCandidates: [],
                                                        scCandidates: [cg]), 5)
    }

    func testBoundWindowIdentitySurvivesAXListOmissionOnlyForItsOriginalCGWindow() {
        let ax = WindowFingerprint(pid: 42, title: "Fixture", frame: Rect(x: 10, y: 20, width: 300, height: 200))
        let original = ScreenshotWindow(id: 17, pid: 42, title: "Fixture", frame: ax.frame)
        let replacement = ScreenshotWindow(id: 18, pid: 42, title: "Fixture", frame: ax.frame)
        XCTAssertTrue(WindowMatcher.matchesBoundWindow(id: 17, ax: ax, candidates: [original]))
        XCTAssertFalse(WindowMatcher.matchesBoundWindow(id: 17, ax: ax, candidates: [replacement]))
        XCTAssertFalse(WindowMatcher.matchesBoundWindow(id: 17, ax: ax, candidates: []))
        XCTAssertFalse(WindowMatcher.matchesBoundWindow(id: 17, ax: ax, candidates: [original, original]))
        XCTAssertFalse(WindowMatcher.matchesBoundWindow(id: 17, ax: ax, candidates: [
            ScreenshotWindow(id: 17, pid: 43, title: "Fixture", frame: ax.frame),
        ]))
    }

    func testKeyChordAndElementRefRejectStaleOrUnknownInput() throws {
        let chord = try KeyChord.parse("Meta+Shift+P")
        XCTAssertEqual(chord.virtualKey, KeyMapper.virtualKey(for: "P"))
        XCTAssertEqual(chord.modifiers, ["command", "shift"])
        XCTAssertNil(chord.text)
        XCTAssertThrowsError(try KeyChord.parse("Meta+UnknownKey"))
        XCTAssertThrowsError(try KeyChord.parse("Meta+Meta+A"))
        XCTAssertTrue(ElementReference.isCurrent("r4.12", revision: 4))
        XCTAssertFalse(ElementReference.isCurrent("r3.12", revision: 4))
        XCTAssertFalse(ElementReference.isCurrent("r4.0", revision: 4))
    }

    func testCredentialAppBindingRequiresExactSignedOrUnsignedIdentity() {
        let signed = AppCodeSignature.signed(bundleID: "com.example.fixture", teamID: "TEAM123", executablePath: "/Applications/Fixture.app/Contents/MacOS/Fixture")
        XCTAssertTrue(AppBindingPolicy.matches(signature: signed,
                    expected: AppCredentialBinding(bundleID: "com.example.fixture", teamID: "TEAM123", path: nil)))
        XCTAssertTrue(AppBindingPolicy.matches(signature: signed,
                    expected: AppCredentialBinding(bundleID: "com.example.fixture", teamID: "TEAM123", path: "/Applications/Fixture.app/Contents/MacOS/Fixture")))
        XCTAssertFalse(AppBindingPolicy.matches(signature: signed,
                    expected: AppCredentialBinding(bundleID: "com.example.fixture", teamID: "TEAM123", path: "/Applications/Fake.app/Contents/MacOS/Fixture")))
        XCTAssertFalse(AppBindingPolicy.matches(signature: signed,
                    expected: AppCredentialBinding(bundleID: "com.example.fixture", teamID: "OTHER", path: nil)))
        XCTAssertFalse(AppBindingPolicy.matches(signature: signed,
                    expected: AppCredentialBinding(bundleID: "com.example.fixture", teamID: nil, path: "/Applications/Fixture.app/Contents/MacOS/Fixture")))
        let unsigned = AppCodeSignature.unsigned(bundleID: "com.example.fixture", executablePath: "/tmp/Fixture.app/Contents/MacOS/Fixture")
        XCTAssertTrue(AppBindingPolicy.matches(signature: unsigned,
                    expected: AppCredentialBinding(bundleID: "com.example.fixture", teamID: nil, path: "/tmp/Fixture.app/Contents/MacOS/Fixture")))
        XCTAssertFalse(AppBindingPolicy.matches(signature: unsigned,
                    expected: AppCredentialBinding(bundleID: "com.example.fixture", teamID: "TEAM123", path: "/tmp/Fixture.app/Contents/MacOS/Fixture")))
        XCTAssertFalse(AppBindingPolicy.matches(signature: unsigned,
                    expected: AppCredentialBinding(bundleID: "com.example.fixture", teamID: nil, path: "/tmp/Fake.app/Contents/MacOS/Fixture")))
        XCTAssertTrue(SecretFieldPolicy.accepts(field: "password", role: "AXTextField", subrole: "AXSecureTextField"))
        XCTAssertFalse(SecretFieldPolicy.accepts(field: "password", role: "AXTextField", subrole: ""))
        XCTAssertFalse(SecretFieldPolicy.accepts(field: "username", role: "AXSecureTextField", subrole: ""))
        XCTAssertTrue(SecretFieldPolicy.accepts(field: "totp", role: "AXTextField", subrole: ""))
    }

    func testCrashRecoveryReleasesOnlyHeldKeysAndCoversModifiers() {
        let keys = KeyMapper.recoveryKeys
        XCTAssertEqual(keys, Array(Set(keys)).sorted())
        for modifier: UInt16 in [55, 56, 58, 59] { XCTAssertTrue(keys.contains(modifier)) }
        XCTAssertTrue(keys.contains(KeyMapper.virtualKey(for: "Enter")!))
        let held: Set<UInt16> = [55, 36]
        XCTAssertEqual(RecoveryRelease.stuckKeys(keys) { held.contains($0) }, [36, 55])
        XCTAssertEqual(RecoveryRelease.stuckKeys(keys) { _ in false }, [])
    }

    func testMainProcessIsForbiddenByPidEvenUnderAnotherBundleID() {
        XCTAssertTrue(ProtectedTargets.forbidsTarget(bundleID: "com.github.Electron", executablePath: nil,
                                                     pid: 4242, mainPID: 4242))
        XCTAssertFalse(ProtectedTargets.forbidsTarget(bundleID: "com.github.Electron", executablePath: nil,
                                                      pid: 4243, mainPID: 4242))
        XCTAssertTrue(ProtectedTargets.forbidsTarget(bundleID: "com.apple.keychainaccess", executablePath: nil,
                                                     pid: 7, mainPID: nil))
        XCTAssertFalse(ProtectedTargets.forbidsTarget(bundleID: "com.example.App", executablePath: nil,
                                                      pid: 0, mainPID: 0))
    }

    func testMenuPathMatchesOneTitleExactlyThenLoosely() {
        let titles = ["File", "Edit", "Selection", "View", "Go", ""]
        XCTAssertEqual(MenuPath.match("View", in: titles), 3)
        XCTAssertEqual(MenuPath.match(" view ", in: titles), 3)
        XCTAssertNil(MenuPath.match("Window", in: titles))
        XCTAssertNil(MenuPath.match("", in: titles))
        XCTAssertEqual(MenuPath.match("Command Palette...", in: ["Command Palette…", "Open View..."]), 0)
        XCTAssertNil(MenuPath.match("copy", in: ["Copy", "COPY"]))
        XCTAssertEqual(MenuPath.match("Copy", in: ["Copy", "COPY"]), 0)
    }

    func testMenuPathIsShortAndNamed() {
        XCTAssertTrue(MenuPath.isValid(["View", "Command Palette..."]))
        XCTAssertFalse(MenuPath.isValid([]))
        XCTAssertFalse(MenuPath.isValid(["View", " "]))
        XCTAssertFalse(MenuPath.isValid(["a", "b", "c", "d", "e"]))
        XCTAssertFalse(MenuPath.isValid([String(repeating: "x", count: 201)]))
    }

    func testMenuShortcutsUseToolKeyNames() {
        XCTAssertEqual(MenuPath.shortcut(character: "P", modifiers: 1), "Shift+Meta+P")
        XCTAssertEqual(MenuPath.shortcut(character: "q", modifiers: 0), "Meta+Q")
        XCTAssertEqual(MenuPath.shortcut(character: "T", modifiers: 8 | 4), "Control+T")
        XCTAssertNil(MenuPath.shortcut(character: "", modifiers: 0))
    }

    func testCaptureStreamsStaySmallAndEven() {
        let wide = CaptureStreamPlan.size(width: 1218, height: 776)
        XCTAssertEqual(wide.width, 640)
        XCTAssertEqual(wide.height, 406)
        let tall = CaptureStreamPlan.size(width: 720, height: 832)
        XCTAssertEqual(tall.height, 640)
        XCTAssertEqual(tall.width % 2, 0)
        let small = CaptureStreamPlan.size(width: 301, height: 201)
        XCTAssertEqual(small.width, 300)
        XCTAssertEqual(small.height, 200)
        XCTAssertEqual(CaptureStreamPlan.size(width: 0, height: 10).width, 2)
        XCTAssertEqual(CaptureStreamPlan.size(width: .nan, height: 10).height, 2)
    }

    func testCaptureStreamRetriesBackOffToThirtySeconds() {
        XCTAssertEqual((0...7).map(CaptureStreamPlan.retryDelay(failures:)), [0, 2, 4, 8, 16, 30, 30, 30])
    }

    func testOnlyTheMenuBarStopCountsAsTheUserStoppingSharing() {
        let domain = "com.apple.ScreenCaptureKit.SCStreamErrorDomain"
        XCTAssertEqual(CaptureStreamPlan.stopReason(domain: domain, code: -3817), "user")
        XCTAssertEqual(CaptureStreamPlan.stopReason(domain: domain, code: -3815), "error")
        XCTAssertEqual(CaptureStreamPlan.stopReason(domain: "NSCocoaErrorDomain", code: -3817), "error")
    }

    func testPunctuationKeysPressByNameOrCharacter() throws {
        for (name, alias, code) in [("Comma", ",", 43), ("Period", ".", 47), ("Slash", "/", 44),
                                    ("Backslash", "\\", 42), ("Semicolon", ";", 41), ("Quote", "'", 39),
                                    ("Minus", "-", 27), ("Equal", "=", 24), ("BracketLeft", "[", 33),
                                    ("BracketRight", "]", 30), ("Backquote", "`", 50)] {
            XCTAssertEqual(KeyMapper.virtualKey(for: name), UInt16(code), name)
            XCTAssertEqual(KeyMapper.virtualKey(for: alias), UInt16(code), alias)
        }
        XCTAssertTrue(KeyMapper.recoveryKeys.contains(43))
    }

    func testPrintableKeysCarryTheCharacterTheyType() throws {
        XCTAssertEqual(try KeyChord.parse("A").text, "a")
        XCTAssertEqual(try KeyChord.parse("Shift+A").text, "A")
        XCTAssertEqual(try KeyChord.parse("Comma").text, ",")
        XCTAssertEqual(try KeyChord.parse("Shift+Comma").text, "<")
        XCTAssertEqual(try KeyChord.parse("Shift+/").text, "?")
        XCTAssertEqual(try KeyChord.parse("Shift+2").text, "@")
        XCTAssertEqual(try KeyChord.parse("7").text, "7")
        XCTAssertEqual(try KeyChord.parse("Space").text, " ")
        XCTAssertEqual(try KeyChord.parse("Shift+Quote").text, "\"")
        // Named keys and shortcut chords type nothing themselves.
        XCTAssertNil(try KeyChord.parse("Enter").text)
        XCTAssertNil(try KeyChord.parse("Tab").text)
        XCTAssertNil(try KeyChord.parse("Meta+A").text)
        XCTAssertNil(try KeyChord.parse("Control+Comma").text)
        XCTAssertNil(try KeyChord.parse("Option+Shift+A").text)
    }

    func testThePointerIsVisibleOnlyWhereTheTargetWindowIsFrontmost() {
        let main: Int32 = 10, target: Int32 = 42
        let point = Point(x: 100, y: 100)
        let targetWindow = ScreenWindow(id: 7, pid: target, layer: 0,
                                        frame: Rect(x: 0, y: 0, width: 500, height: 500), alpha: 1)
        let overlay = ScreenWindow(id: 1, pid: main, layer: 1000,
                                   frame: Rect(x: 90, y: 90, width: 32, height: 32), alpha: 1)
        let emperorWindow = ScreenWindow(id: 2, pid: main, layer: 0,
                                         frame: Rect(x: 50, y: 50, width: 300, height: 300), alpha: 1)
        let other = ScreenWindow(id: 3, pid: 99, layer: 0,
                                 frame: Rect(x: 80, y: 80, width: 40, height: 40), alpha: 1)
        let invisible = ScreenWindow(id: 4, pid: 99, layer: 0,
                                     frame: Rect(x: 0, y: 0, width: 999, height: 999), alpha: 0)
        func visible(_ windows: [ScreenWindow], id: UInt32? = 7) -> Bool {
            PointerVisibility.visible(at: point, windows: windows, targetWindowID: id,
                                      targetPID: target, mainPID: main)
        }
        // Emperor's own overlay and a transparent window do not hide the point.
        XCTAssertTrue(visible([overlay, invisible, targetWindow]))
        // Emperor's main window or another app's window in front hides it.
        XCTAssertFalse(visible([emperorWindow, targetWindow]))
        XCTAssertFalse(visible([other, targetWindow]))
        // Without a known window ID, the owning process decides.
        XCTAssertTrue(visible([targetWindow], id: nil))
        // Off every window: not visible.
        XCTAssertFalse(PointerVisibility.visible(at: Point(x: 900, y: 900), windows: [targetWindow],
                                                 targetWindowID: 7, targetPID: target, mainPID: main))
    }

    func testMenuShortcutsMatchOnlyTheExactChord() {
        // Undo: Command+Z (bits 0 = Command only).
        XCTAssertTrue(MenuPath.shortcutMatches(character: "Z", modifierBits: 0, key: "z", modifiers: ["command"]))
        // Redo: Shift+Command+Z does not match plain Command+Z, and back.
        XCTAssertFalse(MenuPath.shortcutMatches(character: "Z", modifierBits: 1, key: "Z", modifiers: ["command"]))
        XCTAssertTrue(MenuPath.shortcutMatches(character: "Z", modifierBits: 1, key: "Z", modifiers: ["command", "shift"]))
        // Option and Control are part of the chord; bit 8 means no Command.
        XCTAssertFalse(MenuPath.shortcutMatches(character: "T", modifierBits: 2, key: "T", modifiers: ["command"]))
        XCTAssertTrue(MenuPath.shortcutMatches(character: "T", modifierBits: 8 | 4, key: "T", modifiers: ["control"]))
        XCTAssertFalse(MenuPath.shortcutMatches(character: "", modifierBits: 0, key: "Z", modifiers: ["command"]))
        XCTAssertFalse(MenuPath.shortcutMatches(character: "X", modifierBits: 0, key: "Z", modifiers: ["command"]))
    }

    func testKeysReportTheCharacterTheirMenuShortcutShows() {
        XCTAssertEqual(KeyMapper.character(forVirtualKey: 6), "Z")
        XCTAssertEqual(KeyMapper.character(forVirtualKey: 43), ",")
        XCTAssertEqual(KeyMapper.character(forVirtualKey: 18), "1")
        XCTAssertNil(KeyMapper.character(forVirtualKey: 36)) // Return has no character
    }
}
