// swift-tools-version: 6.0
import PackageDescription

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
    dependencies: [],
    targets: [
        .target(
            name: "Omnishell",
            dependencies: [],
            path: "Sources/Omnishell",
            linkerSettings: [
                .linkedFramework("JavaScriptCore"),
                .linkedLibrary("sqlite3")
            ]
        ),
        .testTarget(
            name: "OmnishellTests",
            dependencies: ["Omnishell"],
            path: "Tests/OmnishellTests"
        ),
    ]
)
