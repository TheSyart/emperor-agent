import Foundation

public enum AXRoleMapper {
    public static func role(_ nativeRole: String, subrole: String? = nil, parentRole: String? = nil) -> String {
        if subrole == "AXSearchField" { return "searchbox" }
        if subrole == "AXDialog" { return "dialog" }
        if nativeRole == "AXRadioButton", parentRole == "AXTabGroup" { return "tab" }
        switch nativeRole {
        case "AXButton", "AXMenuButton": return "button"
        case "AXLink": return "link"
        case "AXTextField", "AXTextArea", "AXSecureTextField": return "textbox"
        case "AXCheckBox": return "checkbox"
        case "AXRadioButton": return "radio"
        case "AXPopUpButton", "AXComboBox": return "combobox"
        case "AXList", "AXOutline": return "listbox"
        case "AXMenu", "AXMenuBar": return "menu"
        case "AXMenuItem", "AXMenuBarItem": return "menuitem"
        case "AXSlider": return "slider"
        case "AXTable": return "table"
        case "AXRow": return "row"
        case "AXCell": return "cell"
        case "AXImage": return "image"
        case "AXStaticText": return "text"
        case "AXWindow", "AXSheet": return "window"
        default: return "generic"
        }
    }
}

/// Hardware-independent virtual key codes for named keys. Printable Unicode
/// text is intentionally handled separately by the platform input layer.
public enum KeyMapper {
    private static let keys: [String: UInt16] = [
        "A": 0, "S": 1, "D": 2, "F": 3, "H": 4, "G": 5,
        "Z": 6, "X": 7, "C": 8, "V": 9, "B": 11,
        "Q": 12, "W": 13, "E": 14, "R": 15, "Y": 16, "T": 17,
        "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23,
        "9": 25, "7": 26, "8": 28, "0": 29,
        "O": 31, "U": 32, "I": 34, "P": 35,
        "L": 37, "J": 38, "K": 40, "N": 45, "M": 46,
        "Enter": 36, "Return": 36, "Tab": 48, "Space": 49,
        "Backspace": 51, "Delete": 117, "Escape": 53,
        "Left": 123, "Right": 124, "Down": 125, "Up": 126,
        "Home": 115, "End": 119, "PageUp": 116, "PageDown": 121,
        "F1": 122, "F2": 120, "F3": 99, "F4": 118,
        "F5": 96, "F6": 97, "F7": 98, "F8": 100,
        "F9": 101, "F10": 109, "F11": 103, "F12": 111,
        // ANSI punctuation, by name and by the character itself.
        "Comma": 43, ",": 43, "Period": 47, ".": 47, "Slash": 44, "/": 44,
        "Backslash": 42, "\\": 42, "Semicolon": 41, ";": 41, "Quote": 39, "'": 39,
        "Minus": 27, "-": 27, "Equal": 24, "=": 24, "BracketLeft": 33, "[": 33,
        "BracketRight": 30, "]": 30, "Backquote": 50, "`": 50,
    ]

    /// What a punctuation key types on an ANSI (US) layout: plain and shifted.
    private static let punctuation: [String: (plain: String, shifted: String)] = [
        "Comma": (",", "<"), "Period": (".", ">"), "Slash": ("/", "?"),
        "Backslash": ("\\", "|"), "Semicolon": (";", ":"), "Quote": ("'", "\""),
        "Minus": ("-", "_"), "Equal": ("=", "+"), "BracketLeft": ("[", "{"),
        "BracketRight": ("]", "}"), "Backquote": ("`", "~"),
    ]
    private static let shiftedDigits: [Character: String] = [
        "1": "!", "2": "@", "3": "#", "4": "$", "5": "%",
        "6": "^", "7": "&", "8": "*", "9": "(", "0": ")",
    ]

    public static func virtualKey(for name: String) -> UInt16? {
        keys[name.count == 1 ? name.uppercased() : name]
    }

    /// The single character a menu shortcut shows for this key, if any.
    public static func character(forVirtualKey code: UInt16) -> String? {
        keys.first { $0.value == code && $0.key.count == 1 }?.key
    }

    /// The character a key types on an ANSI layout, or nil for named keys
    /// (Enter, Tab, arrows…). A posted key that carries this text types
    /// exactly it, whatever input source is active (E-M6c).
    public static func text(for name: String, shift: Bool) -> String? {
        if name == "Space" { return " " }
        if let pair = punctuation[name] { return shift ? pair.shifted : pair.plain }
        guard name.count == 1, let character = name.first else { return nil }
        if let pair = punctuation.values.first(where: { $0.plain == name }) {
            return shift ? pair.shifted : pair.plain
        }
        if character.isLetter, character.isASCII {
            return shift ? name.uppercased() : name.lowercased()
        }
        if character.isNumber, character.isASCII {
            return shift ? shiftedDigits[character] : name
        }
        return nil
    }

    /// Modifier keys (left and right Command, Shift, Option, Control, Fn).
    public static let modifierKeys: [UInt16] = [55, 54, 56, 60, 58, 61, 59, 62, 63]

    /// Every key the helper can press, plus the modifiers: what a restarted
    /// helper checks after a crash (00 §12), sorted and unique.
    public static var recoveryKeys: [UInt16] {
        Array(Set(keys.values).union(modifierKeys)).sorted()
    }
    public static func modifier(_ name: String) -> String? {
        switch name {
        case "Meta", "Command": return "command"
        case "Control": return "control"
        case "Alt", "Option": return "option"
        case "Shift": return "shift"
        default: return nil
        }
    }
}

/// Fail closed for Emperor and OS authorization surfaces. Case-folding only
/// accounts for bundle identifier casing; no substring matching is used.
public enum ProtectedTargets {
    private static let exact: Set<String> = [
        "com.apple.securityagent", "com.apple.usernotificationcenter",
        "com.apple.coreauthui", "com.apple.localauthentication.uiagent", "com.apple.keychainaccess",
        "com.apple.passwords", "com.apple.systempreferences", "com.apple.headphonesettings",
        "com.apple.loginwindow", "com.apple.screensaver.engine",
    ]

    public static func contains(bundleID: String, executablePath: String? = nil) -> Bool {
        let id = bundleID.lowercased()
        if id == "com.emperor.agent.desktop" || id.hasPrefix("com.emperor.agent.desktop.") { return true }
        if id.hasPrefix("com.apple.systempreferences.") { return true }
        if exact.contains(id) { return true }
        if let path = executablePath?.lowercased(),
           path.contains("/emperor agent.app/contents/") ||
           path.contains("/emperor computer helper.app/contents/") { return true }
        return false
    }

    /// A listable or bindable target (00 §6.5: bundle ID, executable path and
    /// process ID). Emperor's main process is refused by pid as well, which
    /// matters for development builds whose bundle ID is Electron's.
    public static func forbidsTarget(bundleID: String, executablePath: String?,
                                     pid: Int32, mainPID: Int32?) -> Bool {
        if pid > 0, pid == mainPID { return true }
        return contains(bundleID: bundleID, executablePath: executablePath)
    }

    /// The verified socket peer may be foreground while it dispatches an
    /// action to another bound window. It remains forbidden as a target.
    public static func blocksForegroundAction(bundleID: String, executablePath: String?,
                                              pid: Int32, verifiedMainPID: Int32?) -> Bool {
        if pid > 0, pid == verifiedMainPID,
           bundleID.lowercased() == "com.emperor.agent.desktop" {
            return false
        }
        return contains(bundleID: bundleID, executablePath: executablePath)
    }
}

/// Crash recovery (00 §12): a new helper cannot know what a crashed one held
/// down, so it releases whatever the session still reports as pressed.
public enum RecoveryRelease {
    public static func stuckKeys(_ candidates: [UInt16], isDown: (UInt16) -> Bool) -> [UInt16] {
        candidates.filter(isDown)
    }
}
