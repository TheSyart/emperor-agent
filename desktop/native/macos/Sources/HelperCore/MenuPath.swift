import Foundation

/// A menu command named by its titles from the menu bar down, e.g.
/// ["View", "Command Palette..."]. Titles are matched exactly first, then
/// ignoring case, surrounding spaces and "…" versus "...".
public enum MenuPath {
    public static let maxDepth = 4
    public static let maxTitleBytes = 200

    public static func isValid(_ path: [String]) -> Bool {
        (1...maxDepth).contains(path.count) && path.allSatisfy {
            !$0.trimmingCharacters(in: .whitespaces).isEmpty && $0.utf8.count <= maxTitleBytes
        }
    }

    static func normalized(_ title: String) -> String {
        title.replacingOccurrences(of: "…", with: "...")
            .trimmingCharacters(in: .whitespaces)
            .lowercased()
    }

    /// The index of the one title that matches, or nil when none or several do.
    public static func match(_ wanted: String, in titles: [String]) -> Int? {
        // Separators have empty titles; they are never a command.
        guard !wanted.trimmingCharacters(in: .whitespaces).isEmpty else { return nil }
        let exact = titles.indices.filter { titles[$0] == wanted }
        if exact.count == 1 { return exact[0] }
        if exact.count > 1 { return nil }
        let key = normalized(wanted)
        let loose = titles.indices.filter { !titles[$0].isEmpty && normalized(titles[$0]) == key }
        return loose.count == 1 ? loose[0] : nil
    }

    /// Whether a menu item's shortcut (its AXMenuItemCmdChar and modifier
    /// bits) is exactly `key` with `modifiers` ("command", "shift", …).
    public static func shortcutMatches(character: String, modifierBits: Int,
                                       key: String, modifiers: Set<String>) -> Bool {
        let shown = character.trimmingCharacters(in: .whitespaces)
        guard !shown.isEmpty, shown.uppercased() == key.uppercased() else { return false }
        return (modifierBits & 8 == 0) == modifiers.contains("command") &&
            (modifierBits & 1 != 0) == modifiers.contains("shift") &&
            (modifierBits & 2 != 0) == modifiers.contains("option") &&
            (modifierBits & 4 != 0) == modifiers.contains("control")
    }

    /// AX menu-item modifier bits (kAXMenuItemModifier*) and the key as text.
    public static func shortcut(character: String, modifiers: Int) -> String? {
        let key = character.trimmingCharacters(in: .whitespaces)
        guard !key.isEmpty, key.utf8.count <= 8 else { return nil }
        var parts: [String] = []
        if modifiers & 4 != 0 { parts.append("Control") }
        if modifiers & 2 != 0 { parts.append("Option") }
        if modifiers & 1 != 0 { parts.append("Shift") }
        if modifiers & 8 == 0 { parts.append("Meta") }
        return (parts + [key.uppercased()]).joined(separator: "+")
    }
}
