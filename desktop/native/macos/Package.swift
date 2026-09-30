// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "EmperorComputerHelper",
    platforms: [.macOS(.v14)],
    products: [
        .library(name: "HelperCore", targets: ["HelperCore"]),
        .executable(name: "emperor-computer-helper", targets: ["EmperorComputerHelper"]),
        .executable(name: "emperor-dictation-helper", targets: ["EmperorDictationHelper"]),
    ],
    targets: [
        .target(name: "HelperCore"),
        .target(name: "HelperPlatform", dependencies: ["HelperCore"]),
        .executableTarget(name: "EmperorComputerHelper", dependencies: ["HelperCore", "HelperPlatform"]),
        .testTarget(name: "HelperCoreTests", dependencies: ["HelperCore"]),
        .testTarget(name: "HelperPlatformTests", dependencies: ["HelperPlatform"]),
        // Editor dictation (VO-01): its own helper, microphone and speech only.
        .target(name: "DictationCore"),
        .target(
            name: "DictationPlatform",
            dependencies: ["DictationCore"],
            // AVFoundation and Speech callbacks are not Sendable-annotated.
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .executableTarget(
            name: "EmperorDictationHelper",
            dependencies: ["DictationCore", "DictationPlatform"],
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .testTarget(name: "DictationCoreTests", dependencies: ["DictationCore"]),
        .testTarget(
            name: "DictationPlatformTests",
            dependencies: ["DictationPlatform"],
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
    ]
)
