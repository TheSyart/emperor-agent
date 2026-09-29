import Foundation
import HelperCore

public struct NativeReply {
    public let result: [String: Any]
    public let blobs: [(String, Data)]
    public init(result: [String: Any], blobs: [(String, Data)] = []) {
        self.result = result; self.blobs = blobs
    }
}

public final class ReadOnlyDispatcher {
    private let catalog: DesktopCatalog
    private let verifiedMainPID: pid_t?
    private lazy var actionExecutor = DesktopActionExecutor(catalog: catalog, verifiedMainPID: verifiedMainPID)
    private lazy var secretFillExecutor = SecretFillExecutor(catalog: catalog, verifiedMainPID: verifiedMainPID)
    private let captures = TargetCaptureStreams()
    private var lastPermissions = DesktopPermissions.status()
    private var lastPermissionPoll = ContinuousClock.now

    public init(verifiedMainPID: pid_t? = nil) {
        self.verifiedMainPID = verifiedMainPID
        catalog = DesktopCatalog(mainPID: verifiedMainPID)
    }
    public var targetCount: Int { catalog.targetCount }

    /// Keeps the capture streams in line with the bound targets (helper loop).
    public func maintainCaptures() async {
        let catalog = self.catalog
        await captures.maintain { id, generation in try? catalog.target(id: id, generation: generation) }
    }

    public func events() -> [[String: Any]] {
        var events = catalog.pollEvents()
        events += captures.drainEvents()
        if lastPermissionPoll.duration(to: .now) >= .seconds(2) {
            lastPermissionPoll = .now
            let current = DesktopPermissions.status()
            if current != lastPermissions {
                lastPermissions = current
                events.append(["type": "event", "name": "permissions.changed",
                               "data": ["permissions": current]])
            }
        }
        return events
    }

    public func handle(method: String, params raw: Any,
                       beforeSideEffect: ((String, [String: Any]?) throws -> Void)? = nil) async throws -> NativeReply {
        guard let params = raw as? [String: Any] else { throw invalid("Expected object params") }
        switch method {
        case "act":
            try keys(params, required: ["operationId", "targetId", "generation", "expectedRevision", "action"],
                     optional: ["bringForward"])
            if params["bringForward"] != nil && boolean(params["bringForward"]) == nil {
                throw invalid("Invalid bringForward")
            }
            guard let beforeSideEffect else { throw invalid("Action dispatch callback is missing") }
            return NativeReply(result: try actionExecutor.execute(params: params, beforeSideEffect: beforeSideEffect))
        case "act.fillSecret":
            try keys(params, required: ["operationId", "targetId", "generation", "expectedRevision",
                                         "ref", "field", "secret", "binding"])
            guard let beforeSideEffect else { throw invalid("Action dispatch callback is missing") }
            // No stream or preview of a window that is about to hold a secret.
            await captures.block(targetID: try identifier(params, "targetId"))
            return NativeReply(result: try secretFillExecutor.execute(params: params, beforeSideEffect: beforeSideEffect))
        case "permissions.status":
            try keys(params, required: [])
            return NativeReply(result: ["permissions": DesktopPermissions.status()])
        case "permissions.request":
            try keys(params, required: ["permission"])
            guard let permission = params["permission"] as? String else { throw invalid("Invalid permission") }
            let opened = try await DesktopPermissions.request(permission)
            return NativeReply(result: ["opened": opened])
        case "apps.list":
            try keys(params, required: [])
            return NativeReply(result: ["apps": catalog.apps()])
        case "windows.list":
            try keys(params, required: [], optional: ["appId"])
            let appID = params["appId"] as? String
            if params["appId"] != nil && (appID == nil || appID!.isEmpty || appID!.utf8.count > 256) {
                throw invalid("Invalid appId")
            }
            return NativeReply(result: ["windows": try catalog.windows(appID: appID)])
        case "target.bind":
            try keys(params, required: ["windowRef"])
            return NativeReply(result: try catalog.bind(windowRef: identifier(params, "windowRef")))
        case "target.release":
            try keys(params, required: ["targetId"])
            let targetID = try identifier(params, "targetId")
            await captures.forget(targetID: targetID)
            try catalog.release(targetID: targetID)
            return NativeReply(result: [:])
        case "front.restore":
            try keys(params, required: ["targetId", "generation"])
            guard let generation = positiveInteger(params["generation"]) else {
                throw invalid("Invalid restore arguments")
            }
            let target = try catalog.target(id: identifier(params, "targetId"), generation: generation)
            return NativeReply(result: ["restored": FrontRestorePolicy.restore(target, mainPID: verifiedMainPID)])
        case "target.capture":
            try keys(params, required: ["targetId", "generation", "active"])
            guard let generation = positiveInteger(params["generation"]),
                  let active = boolean(params["active"]) else { throw invalid("Invalid capture arguments") }
            let target = try catalog.target(id: identifier(params, "targetId"), generation: generation)
            return NativeReply(result: ["active": await captures.set(active: active, target: target)])
        case "target.preview":
            try keys(params, required: ["targetId", "generation", "maxEdge"], optional: ["afterSeq"])
            guard let generation = positiveInteger(params["generation"]),
                  let maxEdge = positiveInteger(params["maxEdge"]), (64...1_024).contains(maxEdge) else {
                throw invalid("Invalid preview arguments")
            }
            let afterSeq = params["afterSeq"] == nil ? nil : nonnegativeInteger(params["afterSeq"])
            if params["afterSeq"] != nil && afterSeq == nil { throw invalid("Invalid preview sequence") }
            let target = try catalog.target(id: identifier(params, "targetId"), generation: generation)
            guard let frame = captures.preview(targetID: target.id, maxEdge: maxEdge, afterSeq: afterSeq) else {
                return NativeReply(result: ["seq": 0, "live": false])
            }
            guard let jpeg = frame.jpeg else {
                return NativeReply(result: ["seq": frame.sequence, "live": true])
            }
            let blobID = "b-" + UUID().uuidString
            return NativeReply(result: ["seq": frame.sequence, "live": true, "blobId": blobID,
                                        "width": frame.width, "height": frame.height],
                               blobs: [(blobID, jpeg)])
        case "observe.semantic":
            try keys(params, required: ["targetId", "generation", "budget", "includeText"],
                     optional: ["query", "diffFrom", "cursor"])
            guard let generation = positiveInteger(params["generation"]),
                  let budgetObject = params["budget"] as? [String: Any],
                  let includeText = boolean(params["includeText"]) else { throw invalid("Invalid observation arguments") }
            let budget = try ObservationBudget(json: budgetObject)
            let query = params["query"] as? [String: Any]
            if params["query"] != nil && query == nil { throw invalid("Invalid observation query") }
            if let query {
                try keys(query, required: [], optional: ["role", "nameContains", "frameId", "visibleOnly"])
                for (key, maximum) in [("role", 32), ("nameContains", 200), ("frameId", 128)] where query[key] != nil {
                    guard let text = query[key] as? String, !text.isEmpty,
                          text.utf8.count <= maximum else { throw invalid("Invalid query text") }
                }
                if query["visibleOnly"] != nil && boolean(query["visibleOnly"]) == nil {
                    throw invalid("Invalid visibility flag")
                }
                if query["frameId"] != nil { throw invalid("Desktop targets do not have frame IDs") }
            }
            let diffFrom = params["diffFrom"] == nil ? nil : nonnegativeInteger(params["diffFrom"])
            if params["diffFrom"] != nil && diffFrom == nil { throw invalid("Invalid diffFrom") }
            let cursor = params["cursor"] as? String
            if params["cursor"] != nil && (cursor == nil || cursor!.utf8.count > 256) { throw invalid("Invalid cursor") }
            let target = try catalog.target(id: identifier(params, "targetId"), generation: generation)
            let beforeRevision = target.revision
            if let diffFrom, diffFrom != beforeRevision,
               (target.lastObservedRevision != diffFrom || query != nil || cursor != nil) {
                throw NativeError.denied(code: "STALE_TARGET", message: "No complete prior observation for diff")
            }
            var result = try SemanticObserver.observe(target: target, budget: budget, query: query,
                                                      includeText: includeText, cursor: cursor,
                                                      diffFrom: diffFrom == beforeRevision ? diffFrom : nil)
            let after = try catalog.target(id: target.id, generation: generation)
            guard after.revision == beforeRevision else {
                throw NativeError.denied(code: "STALE_TARGET", message: "Window changed during observation")
            }
            if let diffFrom, diffFrom != beforeRevision {
                result["diffFrom"] = diffFrom
                result["removed"] = target.lastObservedRefs
            }
            if diffFrom != beforeRevision, query == nil, cursor == nil,
               result["truncated"] as? Bool == false {
                target.lastObservedRevision = target.revision
                target.lastObservedRefs = (result["elements"] as? [[String: Any]] ?? [])
                    .compactMap { $0["ref"] as? String }
            }
            return NativeReply(result: result)
        case "observe.menu":
            try keys(params, required: ["targetId", "generation", "path"])
            guard let generation = positiveInteger(params["generation"]),
                  let path = params["path"] as? [String],
                  path.isEmpty || MenuPath.isValid(path) else { throw invalid("Invalid menu path") }
            let target = try catalog.target(id: identifier(params, "targetId"), generation: generation)
            let listing = try MenuBarAccess.list(path: path, pid: target.pid)
            return NativeReply(result: ["items": listing.items, "truncated": listing.truncated])
        case "observe.screenshot":
            try keys(params, required: ["targetId", "generation", "modelCopy", "modelMaxEdge"])
            guard let generation = positiveInteger(params["generation"]),
                  let modelCopy = boolean(params["modelCopy"]),
                  let maxEdge = positiveInteger(params["modelMaxEdge"]),
                  (64...4_096).contains(maxEdge) else { throw invalid("Invalid screenshot arguments") }
            let target = try catalog.target(id: identifier(params, "targetId"), generation: generation)
            let beforeRevision = target.revision
            let capture = try await ScreenCapture.capture(target: target, modelCopy: modelCopy,
                                                          modelMaxEdge: maxEdge)
            // ScreenCaptureKit is asynchronous; do not return pixels if the
            // target changed during capture.
            let after = try catalog.target(id: target.id, generation: generation)
            try DesktopPermissions.requireScreenRecording()
            guard after.revision == beforeRevision else {
                throw NativeError.denied(code: "STALE_TARGET", message: "Window changed during capture")
            }
            if let screenshotID = capture.result["screenshotId"] as? String,
               let scale = capture.result["scale"] as? Double,
               let frame = target.frame {
                target.lastScreenshot = ScreenshotBinding(id: screenshotID, revision: beforeRevision,
                                                          generation: generation, frame: frame, scale: scale)
            }
            return NativeReply(result: capture.result, blobs: capture.blobs)
        default:
            throw NativeError.denied(code: "DRIVER_UNAVAILABLE", message: "Method is not available in this helper build")
        }
    }

    private func keys(_ params: [String: Any], required: Set<String>, optional: Set<String> = []) throws {
        guard required.isSubset(of: Set(params.keys)),
              Set(params.keys).isSubset(of: required.union(optional)) else {
            throw invalid("Invalid method arguments")
        }
    }

    private func identifier(_ params: [String: Any], _ key: String) throws -> String {
        guard let value = params[key] as? String, !value.isEmpty, value.utf8.count <= 256 else {
            throw invalid("Invalid identifier")
        }
        return value
    }

    private func positiveInteger(_ value: Any?) -> Int? {
        guard let number = value as? NSNumber,
              CFGetTypeID(number) != CFBooleanGetTypeID(),
              let value = Int(number.stringValue), value > 0 else { return nil }
        return value
    }

    private func nonnegativeInteger(_ value: Any?) -> Int? {
        guard let number = value as? NSNumber,
              CFGetTypeID(number) != CFBooleanGetTypeID(),
              let value = Int(number.stringValue), value >= 0 else { return nil }
        return value
    }

    private func boolean(_ value: Any?) -> Bool? {
        guard let number = value as? NSNumber,
              CFGetTypeID(number) == CFBooleanGetTypeID() else { return nil }
        return number.boolValue
    }

    private func invalid(_ message: String) -> NativeError {
        .denied(code: "INVALID_REQUEST", message: message)
    }
}
