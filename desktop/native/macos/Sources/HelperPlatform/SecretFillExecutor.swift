import ApplicationServices
import Foundation
import HelperCore

enum SecretFillPostcondition {
    static func confirm(expected: String, isSecure: Bool,
                        observedValue: String?, observedCharacterCount: Int?) throws -> Bool {
        if isSecure, let observedCharacterCount, observedCharacterCount > 0 { return true }
        if !isSecure, observedValue == expected { return true }
        throw NativeError.denied(code: "OUTCOME_UNKNOWN", message: "Cannot confirm credential field content")
    }
}

public final class SecretFillExecutor {
    private let catalog: DesktopCatalog
    private let verifiedMainPID: pid_t?
    private var dispatchedOperations = Set<String>()

    public init(catalog: DesktopCatalog, verifiedMainPID: pid_t? = nil) {
        self.catalog = catalog
        self.verifiedMainPID = verifiedMainPID
    }

    public func execute(params: [String: Any],
                        beforeSideEffect: (String, [String: Any]?) throws -> Void) throws -> [String: Any] {
        guard let operationID = Self.identifier(params["operationId"]),
              let targetID = Self.identifier(params["targetId"]),
              let generation = Self.integer(params["generation"]), generation > 0,
              let expectedRevision = Self.integer(params["expectedRevision"]), expectedRevision >= 0,
              let ref = params["ref"] as? String,
              let field = params["field"] as? String,
              ["username", "password", "totp"].contains(field),
              let text = params["secret"] as? String,
              !text.isEmpty, text.count <= 4_096, text.utf8.count <= 16_384,
              let rawBinding = params["binding"] as? [String: Any] else {
            throw Self.invalid()
        }
        let binding = try Self.binding(rawBinding)
        let secret = SecretBytes(text)
        defer { secret.wipe() }
        let input = InputController.shared
        input.begin()
        defer { input.releaseAll() }

        let target = try catalog.target(id: targetID, generation: generation)
        guard target.revision == expectedRevision else {
            throw NativeError.denied(code: "STALE_TARGET", message: "Target revision is stale")
        }
        try AppCodeIdentity.verify(pid: target.pid, bundleID: target.bundleID,
                                   executablePath: target.executablePath, binding: binding)
        try DesktopActionExecutor.requireUnprotectedForeground(verifiedMainPID: verifiedMainPID)
        let element = try Self.validField(ref: ref, field: field, target: target)
        var settable: DarwinBoolean = false
        guard AXUIElementIsAttributeSettable(element, "AXValue" as CFString, &settable) == .success,
              settable.boolValue else {
            throw NativeError.denied(code: "SECURE_INPUT_ACTIVE", message: "This field does not accept AX value setting")
        }

        // Check the live target and code identity once more at the precise
        // dispatch boundary, after any potentially slow AX inspections.
        try input.checkCancellation()
        let current = try catalog.target(id: targetID, generation: generation)
        guard current.revision == expectedRevision else {
            throw NativeError.denied(code: "STALE_TARGET", message: "Target changed before credential fill")
        }
        try AppCodeIdentity.verify(pid: current.pid, bundleID: current.bundleID,
                                   executablePath: current.executablePath, binding: binding)
        try DesktopActionExecutor.requireUnprotectedForeground(verifiedMainPID: verifiedMainPID)
        _ = try Self.validField(ref: ref, field: field, target: current)
        guard dispatchedOperations.count < 10_000, !dispatchedOperations.contains(operationID) else {
            throw Self.invalid()
        }
        // No pointer for a secret: nothing draws attention to the field.
        try beforeSideEffect(operationID, nil)
        dispatchedOperations.insert(operationID)

        let status = try secret.withCFString { value in
            AXUIElementSetAttributeValue(element, "AXValue" as CFString, value)
        }
        guard status == .success else {
            if status == .cannotComplete {
                throw NativeError.denied(code: "OUTCOME_UNKNOWN", message: "Credential write outcome is unknown")
            }
            throw NativeError.denied(code: "SECURE_INPUT_ACTIVE", message: "This field did not accept AX value setting")
        }
        try input.checkCancellation()
        do {
            let after = try catalog.target(id: targetID, generation: generation)
            try AppCodeIdentity.verify(pid: after.pid, bundleID: after.bundleID,
                                       executablePath: after.executablePath, binding: binding)
        } catch {
            throw NativeError.denied(code: "OUTCOME_UNKNOWN", message: "Target changed after credential write")
        }
        // Never read AXValue for a secure field. NSSecureTextField generally
        // exposes only AXNumberOfCharacters; a missing count is unknown.
        let secure = DesktopActionExecutor.isSecure(element)
        let count = (DesktopCatalog.attribute(element, "AXNumberOfCharacters") as? NSNumber)?.intValue
        let value = secure ? nil : DesktopCatalog.attribute(element, "AXValue") as? String
        return ["filled": try SecretFillPostcondition.confirm(
            expected: text, isSecure: secure,
            observedValue: value, observedCharacterCount: count)]
    }

    private static func validField(ref: String, field: String, target: BoundTarget) throws -> AXUIElement {
        let element = try DesktopActionExecutor.resolveElement(ref: ref, target: target)
        let role = DesktopCatalog.text(element, "AXRole")
        let subrole = DesktopCatalog.text(element, "AXSubrole")
        guard SecretFieldPolicy.accepts(field: field, role: role, subrole: subrole) else {
            throw NativeError.denied(code: "STALE_ELEMENT", message: "Credential field role changed")
        }
        return element
    }

    private static func binding(_ raw: [String: Any]) throws -> AppCredentialBinding {
        guard Set(raw.keys).isSubset(of: ["bundleId", "teamId", "path"]),
              let bundleID = raw["bundleId"] as? String,
              !bundleID.isEmpty, bundleID.utf8.count <= 256 else { throw invalid() }
        let teamID = raw["teamId"] as? String
        if raw["teamId"] != nil && (teamID == nil || !(3...32).contains(teamID!.utf8.count) ||
                                      !teamID!.utf8.allSatisfy({ (65...90).contains($0) || (48...57).contains($0) })) {
            throw invalid()
        }
        let path = raw["path"] as? String
        if raw["path"] != nil && (path == nil || path!.isEmpty || path!.utf8.count > 4_096 || !path!.hasPrefix("/")) {
            throw invalid()
        }
        guard teamID != nil || path != nil else { throw invalid() }
        return AppCredentialBinding(bundleID: bundleID, teamID: teamID, path: path)
    }

    private static func identifier(_ value: Any?) -> String? {
        guard let text = value as? String, !text.isEmpty, text.utf8.count <= 256 else { return nil }
        return text
    }

    private static func integer(_ value: Any?) -> Int? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
        return Int(number.stringValue)
    }

    private static func invalid() -> NativeError {
        .denied(code: "INVALID_REQUEST", message: "Invalid credential fill request")
    }
}
