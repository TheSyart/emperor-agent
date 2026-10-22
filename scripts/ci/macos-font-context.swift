import CoreText
import Foundation

func describe(_ font: CTFont) -> [String: Any] {
    [
        "family": CTFontCopyFamilyName(font) as String,
        "postscript": CTFontCopyPostScriptName(font) as String,
        "version": CTFontCopyName(font, kCTFontVersionNameKey) as String? ?? "unknown",
        "file": (CTFontCopyAttribute(font, kCTFontURLAttribute) as? URL)?.path ?? "unknown",
    ]
}

let families = CTFontManagerCopyAvailableFontFamilyNames() as! [String]
let text = "设置子智能体"
var records: [[String: Any]] = []
for name in ["PingFang SC", "Hiragino Sans GB", "Helvetica Neue"] {
    let font = CTFontCreateWithName(name as CFString, 14, nil)
    let fallback = CTFontCreateForString(font, text as CFString, CFRange(location: 0, length: text.utf16.count))
    records.append(["requested": name, "resolved": describe(font), "chinese": describe(fallback)])
}
if let font = CTFontCreateUIFontForLanguage(.system, 14, "zh-CN" as CFString) {
    let fallback = CTFontCreateForString(font, text as CFString, CFRange(location: 0, length: text.utf16.count))
    records.append(["requested": "system UI zh-CN", "resolved": describe(font), "chinese": describe(fallback)])
}
let globals = UserDefaults.standard.persistentDomain(forName: UserDefaults.globalDomain) ?? [:]
let result: [String: Any] = [
    "preferredLanguages": Locale.preferredLanguages,
    "availableChineseFamilies": families.filter { $0.contains("PingFang") || $0.contains("Heiti") || $0.contains("Songti") },
    "fontSmoothing": globals["AppleFontSmoothing"] ?? "default",
    "fonts": records,
]
let data = try JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys])
print(String(decoding: data, as: UTF8.self))
