// swift-tools-version: 6.0
import PackageDescription

// Upstream divkit-ios omits .macOS(...) in its Package.swift while vgsl declares .macOS(.v10_15),
// which SwiftPM's host-macOS graph validator rejects before evaluating .when(platforms: [.iOS]).
// Gate the package edge off plain host `swift test` while keeping Xcode and iOS Simulator builds active.
let xpcService = Context.environment["XPC_SERVICE_NAME"] ?? ""
let bundleId = Context.environment["__CFBundleIdentifier"] ?? ""
let enableIosDivKit = Context.environment["OMNISHELL_IOS_DIVKIT"] == "1"
    || Context.environment["XCODE_PRODUCT_BUILD_VERSION"] != nil
    || bundleId.contains("Xcode")
    || xpcService.contains("Xcode")
    || xpcService.contains("com.apple.dt")
    || xpcService.contains("SWB")

let package = Package(
    name: "Omnishell",
    platforms: [
        .macOS(.v13),
        .iOS(.v15)
    ],
    products: [
        .library(
            name: "Omnishell",
            targets: ["Omnishell"]
        ),
    ],
    dependencies: enableIosDivKit
        ? [
            .package(url: "https://github.com/divkit/divkit-ios.git", exact: "32.59.0"),
            .package(url: "https://github.com/yandex/vgsl.git", exact: "7.21.0")
        ]
        : [],
    targets: [
        .target(
            name: "Omnishell",
            dependencies: enableIosDivKit
                ? [
                    .product(name: "DivKit", package: "divkit-ios", condition: .when(platforms: [.iOS])),
                    .product(name: "DivKitSVG", package: "divkit-ios", condition: .when(platforms: [.iOS])),
                    .product(name: "VGSL", package: "vgsl", condition: .when(platforms: [.iOS]))
                ]
                : [],
            path: "Sources/Omnishell",
            linkerSettings: [
                .linkedFramework("JavaScriptCore"),
                .linkedFramework("QuartzCore"),
                .linkedFramework("Security"),
                .linkedLibrary("sqlite3")
            ]
        ),
        .testTarget(
            name: "OmnishellTests",
            dependencies: [
                "Omnishell"
            ] + (enableIosDivKit
                ? [
                    .product(name: "DivKit", package: "divkit-ios", condition: .when(platforms: [.iOS]))
                ]
                : []),
            path: "Tests/OmnishellTests"
        ),
    ],
    swiftLanguageModes: [.v5]
)
