# SyrotpSwiftUI

SwiftUI verification component for the Syrian Reverse OTP Protocol.

Same wire contract and lifecycle as
[`@syrotp/react`](../react/),
[`@syrotp/web-component`](../web-component/),
[`syrotp-android-ui`](../android-ui/), and
[`syrotp_flutter`](../flutter/),
built on SwiftUI + URLSession + async/await.

iOS 15+ and macOS 12+. iPad universal. No UIKit wrapper, no AppKit
menu-bar app.

## Install

Add `SyrotpSwiftUI` as a Swift Package dependency in Xcode:

```
File → Add Package Dependencies… → https://github.com/SYR-ROOT/syrotp
```

Or in `Package.swift`:

```swift
dependencies: [
    .package(url: "https://github.com/SYR-ROOT/syrotp.git", from: "0.6.0"),
],
targets: [
    .target(
        name: "MyApp",
        dependencies: [
            .product(name: "SyrotpSwiftUI", package: "syrotp"),
        ]
    ),
]
```

## How the data flow works

`startVerification()` is a **secret-keyed** operation — it must run
on your backend, never in the mobile app. The view is a pure
consumer: it receives the full result object and polls the public
read endpoint for status changes.

```
[iOS/macOS app]                   [Your backend]                    [SYROTP server]
   │                                   │                                  │
   │   POST /api/start-verify ────────▶│                                  │
   │                                   │  client.startVerification(...) ──▶
   │                                   │◀──────────── { id, send_to,      │
   │                                   │              message, ... }      │
   │◀────────── verification ──────────│                                  │
   │                                                                      │
   │  VerificationView(verification: ..., baseUrl: ...)                   │
   │                                                                      │
   │  GET /v/:id/status (public, IP-rate-limited)  ───────────────────────▶
   │◀───────────────────────── { status, expires_at, verified_at }        │
```

## Usage

```swift
import SwiftUI
import SyrotpSwiftUI

struct VerifyScreen: View {
    let verification: Verification

    var body: some View {
        VerificationView(
            verification: verification,
            baseUrl: URL(string: "https://syrotp.example.com")!,
            webauthnFallbackUrl: URL(string: "https://app.example.com/passkey"),
            onVerified: { v in /* navigate forward */ },
            onExpired: { v in /* show retry CTA */ },
            onCancelled: { v in /* go back */ },
            onError: { e in /* surface to UI */ }
        )
    }
}
```

The `Verification` struct conforms to `Codable` and uses `CodingKeys`
that match the SYROTP wire format — your backend can return the JSON
directly:

```swift
let decoder = JSONDecoder()
decoder.dateDecodingStrategy = .iso8601
let verification = try decoder.decode(Verification.self, from: jsonData)
```

## Initializer parameters

| Parameter | Notes |
| --- | --- |
| `verification: Verification` | Full result of `startVerification()` from your backend. |
| `baseUrl: URL` | Origin of the SYROTP server. The view appends `/v/:id/status`. |
| `pollInterval: TimeInterval` | Default 2.5s. Polling stops on terminal status. |
| `initialInstruction: String` | Headline shown above the SMS message. Default: "Send this SMS to verify your phone." |
| `webauthnFallbackUrl: URL?` | Optional. When set, surfaces a "Use a passkey instead" link below the SMS section. The view itself does NOT implement WebAuthn — it just opens this URL via `@Environment(\.openURL)`. |
| `onVerified` / `onExpired` / `onCancelled` | Fired exactly once on the corresponding `pending → terminal` transition. |
| `onError: (Error) -> Void` | Fired on poll failures. The view keeps polling. |

## Headless controller

`VerificationController` is a `@MainActor ObservableObject`
exposing the polling/state-machine logic without UI. Useful when
you want a fully custom view:

```swift
@StateObject private var controller = VerificationController(
    baseUrl: baseUrl,
    initial: verification,
    onVerified: { v in /* ... */ }
)

var body: some View {
    VStack {
        Text("\(controller.state.verification.status.rawValue)")
        Text("\(controller.state.secondsLeft)s left")
    }
    .onAppear { controller.start() }
    .onDisappear { controller.stop() }
}
```

Or pass an existing controller directly to `VerificationView`:

```swift
VerificationView(controller: sharedController)
```

## Out of scope (intentional)

- **No iOS SMS reading.** This package does not request iOS SMS
  permissions and does not read user messages. The user taps
  "Open SMS app" and sends the message themselves — that's the
  reverse-OTP threat model. Auto-completion would require
  `kCFRuntimeMessageFilteringExtension` and breaks on Messages app
  filters.
- **No native passkey UI.** `webauthnFallbackUrl` only opens an
  operator-supplied URL. Inline `ASAuthorizationController` flows
  are a follow-up, not v0.6 PR 5.
- **No UIKit wrapper.** SwiftUI only. If your app is UIKit-based,
  embed via `UIHostingController(rootView: VerificationView(...))`.
- **No macOS menu-bar app.**
- **No server changes.** Polling reuses the public `/v/:id/status`
  shipped in SYROTP server v0.5.0.
