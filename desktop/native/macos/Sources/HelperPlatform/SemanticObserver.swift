import ApplicationServices
import Foundation
import HelperCore

public enum SemanticObserver {
    private static let attributes = [
        "AXRole", "AXSubrole", "AXTitle", "AXDescription", "AXPlaceholderValue",
        "AXHelp", "AXIdentifier", "AXEnabled", "AXFocused", "AXSelected",
        "AXExpanded", "AXPosition", "AXSize", "AXChildren",
    ]

    public static func observe(
        target: BoundTarget, budget: ObservationBudget, query: [String: Any]?,
        includeText: Bool, cursor: String?, diffFrom: Int?
    ) throws -> [String: Any] {
        if let diffFrom, diffFrom == target.revision {
            return result(target: target, elements: [], redactions: 0, truncated: false, cursor: nil,
                          diffFrom: diffFrom, notes: [])
        }
        let offset = try cursorOffset(cursor, target: target)
        let roleFilter = query?["role"] as? String
        let nameFilter = query?["nameContains"] as? String
        let visibleOnly = query?["visibleOnly"] as? Bool ?? false
        var tracker = BudgetTracker(budget: budget)
        var queue: [(AXUIElement, Int)] = [(target.element, 0)]
        var index = 0
        var elements: [[String: Any]] = []
        var redactions = 0
        var truncated = false
        var depthLimited = false
        let started = ContinuousClock.now
        let maxTraversal = ObservationCursor.maxOffset
        while index < queue.count {
            if started.duration(to: .now) >= .milliseconds(budget.timeoutMs) ||
               index >= maxTraversal || tracker.usedElements >= budget.maxElements {
                truncated = true
                break
            }
            let (element, depth) = queue[index]
            let currentIndex = index
            index += 1
            if depth > budget.maxDepth { continue }
            AXUIElementSetMessagingTimeout(element, 0.5)
            let values = copyAttributes(element)
            let nativeRole = values["AXRole"] as? String ?? "AXUnknown"
            let subrole = values["AXSubrole"] as? String
            let role = AXRoleMapper.role(nativeRole, subrole: subrole)
            let secure = nativeRole == "AXSecureTextField" || subrole == "AXSecureTextField"
            let title = values["AXTitle"] as? String ?? ""
            let description = values["AXDescription"] as? String ?? ""
            let placeholder = values["AXPlaceholderValue"] as? String ?? ""
            let name = [title, description, placeholder].first { !$0.isEmpty } ?? ""
            let bounds = bounds(values)
            let visible = bounds.map { intersects($0, target.frame) } ?? true
            if let children = values["AXChildren"] as? [AXUIElement], depth >= budget.maxDepth,
               !children.isEmpty {
                truncated = true
                depthLimited = true
            }
            if let children = values["AXChildren"] as? [AXUIElement], depth < budget.maxDepth {
                let ordered = children.sorted { left, right in
                    let l = DesktopCatalog.frame(left).map { intersects($0, target.frame) } ?? true
                    let r = DesktopCatalog.frame(right).map { intersects($0, target.frame) } ?? true
                    return l && !r
                }
                // Never retain an unbounded AX child queue.
                let space = max(0, maxTraversal - queue.count)
                queue.append(contentsOf: ordered.prefix(space).map { ($0, depth + 1) })
                if ordered.count > space { truncated = true }
            }
            if currentIndex < offset { continue }
            if visibleOnly && !visible { continue }
            if let roleFilter, roleFilter != role { continue }
            if let nameFilter, !name.localizedCaseInsensitiveContains(nameFilter) { continue }

            var actions: [String] = []
            var rawActions: CFArray?
            if AXUIElementCopyActionNames(element, &rawActions) == .success {
                actions = (rawActions as? [String] ?? []).prefix(16).map { String($0.prefix(64)) }
            }
            if nativeRole == "AXGroup", name.isEmpty, actions.isEmpty,
               (values["AXChildren"] as? [AXUIElement])?.count == 1 {
                continue
            }
            var item: [String: Any] = [
                "ref": "r\(target.revision).\(currentIndex + 1)", "role": role,
                "nativeRole": String(nativeRole.prefix(64)), "actions": actions,
                "depth": depth,
            ]
            var remainingText = max(0, budget.maxTextBytes - tracker.usedTextBytes)
            let clippedName = prefixUTF8(name, maximum: min(1_024, remainingText))
            remainingText -= clippedName.utf8.count
            if !clippedName.isEmpty { item["name"] = clippedName }
            if let bounds {
                item["bounds"] = ["x": bounds.x, "y": bounds.y,
                                  "width": bounds.width, "height": bounds.height]
            }
            var states: [String] = []
            for (key, state) in [("AXEnabled", "enabled"), ("AXFocused", "focused"),
                                 ("AXSelected", "selected"), ("AXExpanded", "expanded")] {
                if values[key] as? Bool == true { states.append(state) }
            }
            if !states.isEmpty { item["states"] = states }
            var text = clippedName
            if secure {
                // Never read AXValue for a secure text field.
                let count = DesktopCatalog.attribute(element, "AXNumberOfCharacters") as? NSNumber
                let label = count.map { $0.intValue > 0 ? "[has content]" : "[empty]" } ?? "[redacted]"
                let clipped = prefixUTF8(label, maximum: remainingText)
                if !clipped.isEmpty { item["value"] = clipped; text += clipped }
                redactions += 1
            } else if includeText, remainingText > 0,
                      let raw = DesktopCatalog.attribute(element, "AXValue") as? String {
                // A terminal's newest output is at the end of its scrollback.
                let terminalOutput = role == "textbox" && nativeRole == "AXTextArea" &&
                    TextEntryPreflight.terminalEmulators.contains(target.bundleID)
                let clipped = terminalOutput
                    ? UTF8Text.tail(raw, maximumBytes: min(4_096, remainingText))
                    : prefixUTF8(raw, maximum: min(4_096, remainingText))
                if !clipped.isEmpty { item["value"] = clipped; text += clipped }
            }
            do {
                try tracker.consume(depth: depth, text: text)
            } catch {
                truncated = true
                index = currentIndex
                break
            }
            elements.append(item)
            if let ref = item["ref"] as? String { target.refElements[ref] = element }
        }
        let next = ObservationCursor.next(truncated: truncated, depthLimited: depthLimited,
                                          nextIndex: index, generation: target.generation,
                                          revision: target.revision)
        let notes = truncated ? [next != nil
            ? "Observation budget reached; continue with cursor"
            : "AX depth or traversal limit reached; narrow the query"] : []
        return result(target: target, elements: elements, redactions: redactions,
                      truncated: truncated, cursor: next, diffFrom: diffFrom, notes: notes)
    }

    private static func copyAttributes(_ element: AXUIElement) -> [String: Any] {
        var raw: CFArray?
        let names = attributes.map { $0 as CFString } as CFArray
        guard AXUIElementCopyMultipleAttributeValues(element, names, [], &raw) == .success,
              let array = raw as? [Any] else { return [:] }
        var result: [String: Any] = [:]
        for (index, name) in attributes.enumerated() where index < array.count {
            let value = array[index]
            if value is NSNull { continue }
            if CFGetTypeID(value as CFTypeRef) == AXValueGetTypeID(),
               AXValueGetType(unsafeDowncast(value as AnyObject, to: AXValue.self)) == .axError {
                continue
            }
            result[name] = value
        }
        return result
    }

    private static func bounds(_ values: [String: Any]) -> Rect? {
        guard let position = values["AXPosition"], let size = values["AXSize"],
              CFGetTypeID(position as CFTypeRef) == AXValueGetTypeID(),
              CFGetTypeID(size as CFTypeRef) == AXValueGetTypeID() else { return nil }
        var point = CGPoint.zero, dimensions = CGSize.zero
        guard AXValueGetValue(unsafeDowncast(position as AnyObject, to: AXValue.self), .cgPoint, &point),
              AXValueGetValue(unsafeDowncast(size as AnyObject, to: AXValue.self), .cgSize, &dimensions) else {
            return nil
        }
        return Rect(x: point.x, y: point.y, width: dimensions.width, height: dimensions.height)
    }

    private static func intersects(_ bounds: Rect, _ window: Rect?) -> Bool {
        guard let window else { return true }
        return bounds.x < window.x + window.width && bounds.x + bounds.width > window.x &&
               bounds.y < window.y + window.height && bounds.y + bounds.height > window.y
    }

    private static func prefixUTF8(_ text: String, maximum: Int) -> String {
        UTF8Text.prefix(text, maximumBytes: maximum)
    }

    private static func cursorOffset(_ cursor: String?, target: BoundTarget) throws -> Int {
        guard let cursor else { return 0 }
        guard let offset = ObservationCursor.offset(cursor, generation: target.generation,
                                                    revision: target.revision) else {
            throw NativeError.denied(code: "STALE_TARGET", message: "Observation cursor is stale")
        }
        return offset
    }

    private static func result(
        target: BoundTarget, elements: [[String: Any]], redactions: Int,
        truncated: Bool, cursor: String?, diffFrom: Int?, notes: [String]
    ) -> [String: Any] {
        let frame = target.frame
        var output: [String: Any] = [
            "generation": target.generation, "revision": target.revision,
            "title": target.title, "urlOrApp": target.bundleID,
            "focus": DesktopCatalog.bool(target.element, "AXFocused"),
            "frameOrWindowId": target.id,
            "viewport": ["width": frame?.width ?? 0, "height": frame?.height ?? 0,
                         "scale": 1] as [String: Double],
            "elements": elements, "truncated": truncated, "redactions": redactions,
        ]
        if let cursor { output["cursor"] = cursor }
        if let diffFrom { output["diffFrom"] = diffFrom }
        if !notes.isEmpty { output["notes"] = notes }
        return output
    }
}
