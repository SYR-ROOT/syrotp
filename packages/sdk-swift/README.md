# SYROTP Swift SDK

Official Swift SDK for the [Syrian Reverse OTP Protocol](https://github.com/SYR-ROOT/syrotp).
Async/await on Apple platforms (iOS 15+/macOS 12+/tvOS 15+/watchOS 8+) and on
Linux server-side Swift via `FoundationNetworking`.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](../../LICENSE)
![swift](https://img.shields.io/badge/swift-5.9%2B-blue)

## Installation

Swift Package Manager:

```swift
// Package.swift
.package(url: "https://github.com/SYR-ROOT/syrotp.git", from: "0.4.0"),
```

```swift
.product(name: "SyrotpSDK", package: "syrotp"),
```

## Quickstart

```swift
import SyrotpSDK

let client = try SyrotpClient(
    baseURL: URL(string: "https://otp.example.com")!,
    apiKey: "sk_live_..."
)

let v = try await client.startVerification(phone: "+963991234567", purpose: "login")
print("Send '\(v.message ?? "")' to \(v.sendTo ?? "")")

let final = try await client.waitForVerification(v.id)
switch final.status {
case .verified:  print("phone owned by sender")
case .expired:   print("user took too long")
case .cancelled: print("operation cancelled")
case .failed:    print("server rejected")
default:         print("status: \(final.status.rawValue)")
}
```

A runnable version is the `Quickstart` executable target. Set
`SYROTP_BASE_URL` + `SYROTP_SECRET_KEY` (or `SYROTP_PUBLIC_KEY`) and run:

```bash
swift run Quickstart "+963991234567" login
```

## Server requirements

- **Minimum SYROTP server version:** `v0.3.0`.
- The SDK is wire-compatible with any `0.x` server. Newer server
  fields are preserved on `Verification.extras`; newer status values
  surface as `VerificationStatus.unknown`. See
  [`docs/sdk-versioning.md`](../../docs/sdk-versioning.md) for the
  version skew matrix.

## Public surface

```swift
public final class SyrotpClient {
    public init(
        baseURL: URL,
        apiKey: String,
        timeoutSeconds: TimeInterval = 15.0,    // NEVER infinite
        retries: Int = 2,                       // network / 5xx / 429 only
        userAgent: String? = nil,
        session: URLSession? = nil,
        logHandler: (@Sendable (String) -> Void)? = nil
    ) throws

    public func startVerification(
        phone: String,
        purpose: String,
        clientRef: String? = nil,
        locale: String? = nil
    ) async throws -> Verification

    public func getVerification(_ id: String) async throws -> Verification
    public func cancelVerification(_ id: String) async throws -> Verification

    public func waitForVerification(
        _ id: String,
        intervalSeconds: TimeInterval = 2.5,
        timeoutSeconds: TimeInterval = 5 * 60
    ) async throws -> Verification
}
```

The seven typed error classes:

```
SyrotpError                          // base; catch this for "anything went wrong"
├── SyrotpConfigError                // bad construction args
├── SyrotpAuthError                  // 401 / 403  — NEVER retried
├── SyrotpValidationError            // 400 / local input check  — NEVER retried
├── SyrotpRateLimitError             // 429 (carries retryAfterSeconds)
├── SyrotpNetworkError               // DNS / TLS / connection failures
├── SyrotpServerError                // 5xx
└── SyrotpTimeoutError               // per-request deadline expired
```

Pattern-match by category:

```swift
do {
    _ = try await client.startVerification(phone: "...", purpose: "login")
} catch let e as SyrotpRateLimitError {
    let wait = e.retryAfterSeconds ?? 1
    try await Task.sleep(nanoseconds: UInt64(wait) * 1_000_000_000)
    // retry…
} catch let e as SyrotpValidationError {
    presentError(e.message)
} catch let e as SyrotpError {
    log.error("syrotp call failed: \(e)")
}
```

Caller cancellation propagates as `CancellationError` (per Swift's
structured concurrency rules) — distinct from `SyrotpTimeoutError`,
which surfaces only when the SDK's own per-request deadline elapses.

## Conformance

This SDK is SYROTP-compliant per
[`docs/sdk-contract.md`](../../docs/sdk-contract.md). Every box is
checked:

- [x] Constructor accepts `baseURL`, `apiKey`, `timeoutSeconds`, `retries`, `userAgent`.
- [x] Constructor rejects bad inputs with `SyrotpConfigError`.
- [x] `startVerification`, `getVerification`, `cancelVerification`, `waitForVerification` all return `Verification`.
- [x] All seven typed error classes exist and are raised in the right categories.
- [x] Default `timeoutSeconds = 15.0` — finite.
- [x] Default `retries = 2`; retries on network / 5xx / 429 only.
- [x] `Retry-After` is honored on 429.
- [x] No retry on 4xx other than 429. No retry on auth / validation / config / timeout.
- [x] `cancelVerification` capped at one retry to avoid log noise.
- [x] `User-Agent` includes `syrotp-sdk-swift/<version>`.
- [x] Plain HTTP to a non-private host triggers a one-time warning at
      construction (no warning for `localhost` / RFC1918).
- [x] `apiKey` is never present in `error.description`, error rendering, or
      anywhere on the SDK's log handler.
- [x] Request bodies (which include the user's phone) are never logged.
- [x] Caller `Task` cancellation aborts in-flight requests and surfaces
      as `CancellationError` (NOT `SyrotpTimeoutError`).

## Logging

The SDK's `logHandler` is invoked with a single string per warning. By
default the handler writes to `os.Logger` on Apple platforms and to
stderr elsewhere. Pass your own handler to integrate with your
preferred logging system:

```swift
let client = try SyrotpClient(
    baseURL: ...,
    apiKey: ...,
    logHandler: { line in myAppLogger.warning("\(line)") }
)
```

The SDK never asks the handler to log any of: `Authorization` header,
`apiKey` argument, request body, response body, `phone`, `message`, or
`sendTo`. If you wrap the SDK in something that does, you owned the
leak.

## Versioning

Follows [`docs/sdk-versioning.md`](../../docs/sdk-versioning.md):

- `MAJOR` tracks the protocol's `MAJOR`.
- `MINOR` adds backwards-compatible methods / options.
- `PATCH` is bug fixes only.

## Development

```bash
cd packages/sdk-swift
swift test                    # all unit tests, no real server needed
swift run Quickstart "+1" x   # live example (needs SYROTP_* env)
```

The unit tests register a custom `URLProtocol` so requests never touch
the network.

## License

MIT — see [`../../LICENSE`](../../LICENSE).
