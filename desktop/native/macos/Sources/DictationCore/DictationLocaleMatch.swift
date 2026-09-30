import Foundation

/// Which on-device locale serves a request: the one asked for, or the
/// system's when none is. Tags are compared loosely (`zh_CN`, `zh-CN` and
/// `zh-Hans-CN` all mean Mandarin in mainland China); when only the language
/// matches, the first available locale of that language serves. `nil` means
/// the machine cannot recognize it on device, and the helper says so rather
/// than falling back to the network.
public enum DictationLocaleMatch {
    private struct Tag {
        let language: String
        let script: String?
        let region: String?

        init(_ raw: String) {
            let pieces = raw.replacingOccurrences(of: "_", with: "-")
                .split(separator: "-").map(String.init)
            language = pieces.first?.lowercased() ?? ""
            var script: String?
            var region: String?
            for piece in pieces.dropFirst() {
                // A singleton (`-u-`, `-x-`) starts extensions: `en-u-mu-celsius`.
                if piece.count == 1 { break }
                if piece.count == 4 {
                    script = piece.capitalized
                } else if piece.count == 2 || piece.count == 3, region == nil {
                    region = piece.uppercased()
                }
            }
            self.script = script
            self.region = region
        }

        /// Same language and region; scripts must agree when both name one.
        func matches(_ other: Tag) -> Bool {
            guard language == other.language, region == other.region else { return false }
            guard let script, let otherScript = other.script else { return true }
            return script == otherScript
        }
    }

    public static func resolve(
        requested: String?, systemLocale: String, available: [DictationLocale]
    ) -> DictationLocale? {
        let wanted = Tag(requested ?? systemLocale)
        guard !wanted.language.isEmpty else { return nil }
        if let exact = available.first(where: { Tag($0.id).matches(wanted) }) {
            return exact
        }
        // Someone asking for a specific locale gets that locale or nothing.
        if requested != nil, wanted.region != nil { return nil }
        return available.first { Tag($0.id).language == wanted.language }
    }
}
