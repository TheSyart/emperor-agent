import Foundation

public enum ActionInputError: Error { case invalidKey, staleElement }

public struct KeyChord: Equatable {
    public let virtualKey: UInt16
    public let modifiers: Set<String>
    /// The character a printable key types; nil for named keys and for
    /// chords with Command, Control or Option.
    public let text: String?

    public init(virtualKey: UInt16, modifiers: Set<String>, text: String? = nil) {
        self.virtualKey = virtualKey
        self.modifiers = modifiers
        self.text = text
    }

    public static func parse(_ text: String) throws -> KeyChord {
        let parts = text.split(separator: "+", omittingEmptySubsequences: false).map(String.init)
        guard (1...5).contains(parts.count),
              let key = parts.last, let code = KeyMapper.virtualKey(for: key) else {
            throw ActionInputError.invalidKey
        }
        var modifiers = Set<String>()
        for part in parts.dropLast() {
            guard let modifier = KeyMapper.modifier(part), modifiers.insert(modifier).inserted else {
                throw ActionInputError.invalidKey
            }
        }
        let text = modifiers.isSubset(of: ["shift"])
            ? KeyMapper.text(for: key, shift: modifiers.contains("shift")) : nil
        return KeyChord(virtualKey: code, modifiers: modifiers, text: text)
    }
}

public enum ElementReference {
    public static func isCurrent(_ ref: String, revision: Int) -> Bool {
        guard ref.first == "r", let dot = ref.firstIndex(of: ".") else { return false }
        let revisionText = ref[ref.index(after: ref.startIndex)..<dot]
        let indexText = ref[ref.index(after: dot)...]
        guard (1...9).contains(revisionText.count),
              (1...6).contains(indexText.count),
              revisionText.allSatisfy(\.isNumber), indexText.allSatisfy(\.isNumber),
              let refRevision = Int(revisionText), let index = Int(indexText),
              index > 0 else { return false }
        return refRevision == revision
    }
}
