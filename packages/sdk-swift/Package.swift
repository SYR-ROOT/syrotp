// swift-tools-version: 5.9
//
// Syrian Reverse OTP Protocol — Swift SDK.
//
// Targets are sized for the v0.4 PR 4 scope: a sync client surface
// (in Swift idiom that means async/await — the user-facing methods are
// `func async throws`), no UI components, no SMS gateway, no Keychain
// integration.
import PackageDescription

let package = Package(
    name: "SyrotpSDK",
    platforms: [
        .macOS(.v12),
        .iOS(.v15),
        .tvOS(.v15),
        .watchOS(.v8),
    ],
    products: [
        .library(
            name: "SyrotpSDK",
            targets: ["SyrotpSDK"]
        ),
        .executable(
            name: "Quickstart",
            targets: ["Quickstart"]
        ),
    ],
    targets: [
        .target(
            name: "SyrotpSDK",
            path: "Sources/SyrotpSDK"
        ),
        .executableTarget(
            name: "Quickstart",
            dependencies: ["SyrotpSDK"],
            path: "Sources/Quickstart"
        ),
        .testTarget(
            name: "SyrotpSDKTests",
            dependencies: ["SyrotpSDK"],
            path: "Tests/SyrotpSDKTests"
        ),
    ]
)
