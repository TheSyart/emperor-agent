import ApplicationServices
import Foundation
import HelperCore

/// The bound app's own menu bar. AXPress on a menu item runs its command
/// without opening the menu or activating the app, so menu commands work
/// while the app stays in the background. The Apple menu (system commands
/// such as Restart and Log Out) is never listed or pressed.
enum MenuBarAccess {
    struct Node {
        let element: AXUIElement
        let title: String
    }

    static let maxItems = 100

    static func topLevel(pid: pid_t) throws -> [Node] {
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, 0.5)
        guard let raw = DesktopCatalog.attribute(app, "AXMenuBar"),
              CFGetTypeID(raw) == AXUIElementGetTypeID() else {
            throw NativeError.denied(code: "CAPABILITY_DISABLED", message: "App has no menu bar")
        }
        let bar = unsafeDowncast(raw, to: AXUIElement.self)
        let items = DesktopCatalog.attribute(bar, "AXChildren") as? [AXUIElement] ?? []
        // The first menu bar item is always the Apple menu.
        return items.dropFirst().map { Node(element: $0, title: DesktopCatalog.text($0, "AXTitle")) }
    }

    /// The items of the menu under `item`, or nil when it opens no menu.
    static func submenu(of item: AXUIElement) -> [Node]? {
        guard let children = DesktopCatalog.attribute(item, "AXChildren") as? [AXUIElement],
              let menu = children.first(where: { DesktopCatalog.text($0, "AXRole") == "AXMenu" }) else {
            return nil
        }
        let entries = DesktopCatalog.attribute(menu, "AXChildren") as? [AXUIElement] ?? []
        return entries.map { Node(element: $0, title: DesktopCatalog.text($0, "AXTitle")) }
    }

    /// The menu command whose shortcut is exactly `key` with `modifiers`,
    /// searched through the menu bar (Apple menu excluded). An enabled match
    /// wins over one the app greys out.
    static func item(forShortcut key: String, modifiers: Set<String>, pid: pid_t) -> AXUIElement? {
        var queue = (try? topLevel(pid: pid))?.compactMap { submenu(of: $0.element) }.flatMap { $0 } ?? []
        var visited = 0
        var greyed: AXUIElement?
        while !queue.isEmpty, visited < 2_000 {
            let node = queue.removeFirst()
            visited += 1
            if let nested = submenu(of: node.element) {
                queue += nested
                continue
            }
            let character = DesktopCatalog.text(node.element, "AXMenuItemCmdChar")
            let bits = (DesktopCatalog.attribute(node.element, "AXMenuItemCmdModifiers") as? NSNumber)?.intValue ?? 0
            if MenuPath.shortcutMatches(character: character, modifierBits: bits, key: key, modifiers: modifiers) {
                if DesktopCatalog.bool(node.element, "AXEnabled") { return node.element }
                if greyed == nil { greyed = node.element }
            }
        }
        return greyed
    }

    static func resolve(path: [String], pid: pid_t) throws -> AXUIElement {
        var level = try topLevel(pid: pid)
        var found: AXUIElement?
        for (depth, title) in path.enumerated() {
            guard let index = MenuPath.match(title, in: level.map(\.title)) else {
                throw NativeError.denied(code: "INVALID_REQUEST", message: "Menu item not found")
            }
            found = level[index].element
            if depth < path.count - 1 {
                guard let next = submenu(of: level[index].element) else {
                    throw NativeError.denied(code: "INVALID_REQUEST", message: "Menu item not found")
                }
                level = next
            }
        }
        return found!
    }

    /// Titled entries under `path` (the menu bar itself when empty).
    static func list(path: [String], pid: pid_t) throws -> (items: [[String: Any]], truncated: Bool) {
        let entries: [Node]
        if path.isEmpty {
            entries = try topLevel(pid: pid)
        } else {
            guard let next = submenu(of: try resolve(path: path, pid: pid)) else {
                throw NativeError.denied(code: "INVALID_REQUEST", message: "Menu path names a command, not a menu")
            }
            entries = next
        }
        let titled = entries.filter { !$0.title.isEmpty }
        let items: [[String: Any]] = titled.prefix(maxItems).map { node in
            var item: [String: Any] = [
                "title": String(node.title.prefix(MenuPath.maxTitleBytes)),
                "enabled": DesktopCatalog.bool(node.element, "AXEnabled"),
                "submenu": path.isEmpty || submenu(of: node.element) != nil,
            ]
            let character = DesktopCatalog.text(node.element, "AXMenuItemCmdChar")
            let modifiers = (DesktopCatalog.attribute(node.element, "AXMenuItemCmdModifiers") as? NSNumber)?.intValue ?? 0
            if let shortcut = MenuPath.shortcut(character: character, modifiers: modifiers) {
                item["shortcut"] = shortcut
            }
            return item
        }
        return (items, titled.count > maxItems)
    }
}
