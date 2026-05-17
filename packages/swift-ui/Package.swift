// swift-tools-version: 5.9
//
// Syrian Reverse OTP Protocol — SwiftUI verification component.
//
// Same wire contract and lifecycle as `@syrotp/react`,
// `@syrotp/web-component`, `syrotp-android-ui`, and `syrotp_flutter`,
// built on SwiftUI + URLSession + async/await. iOS 15+ and
// macOS 12+ — no UIKit wrapper, no AppKit menu-bar app.
//
// This package does NOT depend on `SyrotpSDK` (the secret-keyed Swift
// SDK in `packages/sdk-swift`). The polling endpoint
// `/v/:id/status` is public + IP-rate-limited; mixing the two would
// force consumers to provide a secret key just to display status.
import PackageDescription

let package = Package(
    name: "SyrotpSwiftUI",
    platforms: [
        .iOS(.v15),
        .macOS(.v12),
    ],
    products: [
        .library(
            name: "SyrotpSwiftUI",
            targets: ["SyrotpSwiftUI"]
        ),
    ],
    targets: [
        .target(
            name: "SyrotpSwiftUI",
            path: "Sources/SyrotpSwiftUI"
        ),
        .testTarget(
            name: "SyrotpSwiftUITests",
            dependencies: ["SyrotpSwiftUI"],
            path: "Tests/SyrotpSwiftUITests"
        ),
    ]
)
