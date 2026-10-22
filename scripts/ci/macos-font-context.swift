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

final class FontMatchState: @unchecked Sendable {
    private let lock = NSLock()
    private var finished = false
    private var failed = false
    func complete(_ failure: Bool) { lock.lock(); failed = failed || failure; finished = true; lock.unlock() }
    func status() -> (Bool, Bool) { lock.lock(); defer { lock.unlock() }; return (finished, failed) }
}

func ensureDocumentFonts() throws {
    let state = FontMatchState()
    let names = ["PingFangSC-Regular", "PingFangSC-Medium", "PingFangSC-Semibold"]
    let descriptors = names.map { name in
        CTFontDescriptorCreateWithAttributes([kCTFontNameAttribute: name, kCTFontDownloadableAttribute: true] as CFDictionary)
    }
    let mandatory = Set([kCTFontNameAttribute as String, kCTFontDownloadableAttribute as String]) as CFSet
    let started = CTFontDescriptorMatchFontDescriptorsWithProgressHandler(descriptors as CFArray, mandatory) { phase, details in
        if phase == .didFailWithError {
            FileHandle.standardError.write(Data("font match failed: \(String(describing: details).prefix(1500))\n".utf8))
            state.complete(true)
        } else if phase == .didFinish { state.complete(false) }
        return true
    }
    let deadline = Date().addingTimeInterval(180)
    while started && !state.status().0 && Date() < deadline {
        RunLoop.current.run(until: Date().addingTimeInterval(0.1))
    }
    guard started && state.status().0 && !state.status().1 else {
        throw NSError(domain: "FontPreflight", code: 1, userInfo: [NSLocalizedDescriptionKey: "Apple document font match failed or timed out"])
    }
}


if CommandLine.arguments.contains("--ensure-document-fonts") {
    guard ProcessInfo.processInfo.environment["GITHUB_ACTIONS"] == "true" else {
        FileHandle.standardError.write(Data("Font preparation is restricted to the disposable CI runner.\n".utf8))
        exit(64)
    }
    try ensureDocumentFonts()
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
