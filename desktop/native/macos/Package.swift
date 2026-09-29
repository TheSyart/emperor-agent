// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "EmperorComputerHelper",
    platforms: [.macOS(.v14)],
    products: [
        .library(name: "HelperCore", targets: ["HelperCore"]),
        .executable(name: "emperor-computer-helper", targets: ["EmperorComputerHelper"]),
    ],
    targets: [
        .target(name: "HelperCore"),
        .target(name: "HelperPlatform", dependencies: ["HelperCore"]),
        .executableTarget(name: "EmperorComputerHelper", dependencies: ["HelperCore", "HelperPlatform"]),
        .testTarget(name: "HelperCoreTests", dependencies: ["HelperCore"]),
        .testTarget(name: "HelperPlatformTests", dependencies: ["HelperPlatform"]),
    ]
)
