# SYROTP Kotlin/JVM SDK

Official Kotlin SDK for the [Syrian Reverse OTP Protocol](https://github.com/SYR-ROOT/syrotp).
JVM target only; an Android-friendly Multiplatform variant ships in a
follow-up PR.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](../../LICENSE)
![jvm](https://img.shields.io/badge/jvm-17%2B-blue)

## Installation

When published to Maven Central:

```kotlin
// build.gradle.kts
dependencies {
    implementation("io.syrotp:syrotp-sdk:0.1.0")
}
```

For now (until the first published artifact), depend on the local
build:

```bash
cd packages/sdk-kotlin
gradle publishToMavenLocal
```

## Quickstart

```kotlin
import io.syrotp.sdk.SyrotpClient
import io.syrotp.sdk.VerificationStatus

SyrotpClient(
    baseUrl = "https://otp.example.com",
    apiKey = "sk_live_...",
).use { client ->
    val v = client.startVerification(phone = "+963991234567", purpose = "login")
    println("Send '${v.message}' to ${v.sendTo}")

    val final = client.waitForVerification(v.id)
    when (final.status) {
        VerificationStatus.VERIFIED  -> println("phone owned by sender")
        VerificationStatus.EXPIRED   -> println("user took too long")
        else                          -> println("status: ${final.status.wire}")
    }
}
```

A runnable version lives in [`src/main/kotlin/io/syrotp/sdk/examples/Quickstart.kt`](src/main/kotlin/io/syrotp/sdk/examples/Quickstart.kt).
Set `SYROTP_BASE_URL` and `SYROTP_SECRET_KEY` (or `SYROTP_PUBLIC_KEY`) and run:

```bash
gradle run --args="+963991234567 login"
```

## Server requirements

- **Minimum SYROTP server version:** `v0.3.0`.
- **Minimum JVM:** 17.
- The SDK is wire-compatible with any `0.x` server. Newer server fields
  are preserved on `Verification.extras`; newer status values surface
  as `VerificationStatus.UNKNOWN`. See
  [`docs/sdk-versioning.md`](../../docs/sdk-versioning.md) for the
  version skew matrix.

## Public surface

```kotlin
class SyrotpClient(
    baseUrl: String,
    apiKey: String,
    timeoutMs: Long = 15_000L,    // NEVER infinite
    retries: Int = 2,             // network / 5xx / 429 only
    userAgent: String? = null,
    okHttpClient: OkHttpClient? = null,
) : Closeable {

    fun startVerification(
        phone: String,
        purpose: String,
        clientRef: String? = null,
        locale: String? = null,
    ): Verification

    fun getVerification(verificationId: String): Verification
    fun cancelVerification(verificationId: String): Verification
    fun waitForVerification(
        verificationId: String,
        intervalMs: Long = 2500L,
        timeoutMs: Long = 5L * 60_000L,
    ): Verification

    override fun close()
}
```

Plus the typed error hierarchy:

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

## Conformance

This SDK is SYROTP-compliant per
[`docs/sdk-contract.md`](../../docs/sdk-contract.md). Every box is
checked:

- [x] Constructor accepts `baseUrl`, `apiKey`, `timeoutMs`, `retries`, `userAgent`.
- [x] Constructor rejects bad inputs with `SyrotpConfigError`.
- [x] `startVerification`, `getVerification`, `cancelVerification` return `Verification`.
- [x] `waitForVerification` polls until non-pending; raises `SyrotpTimeoutError` at the deadline.
- [x] All seven typed error classes exist and are raised in the right categories.
- [x] Default `timeoutMs = 15_000L` — finite.
- [x] Default `retries = 2`; retries on network / 5xx / 429 only.
- [x] `Retry-After` is honored on 429.
- [x] No retry on 4xx other than 429. No retry on auth / validation / config / timeout.
- [x] `cancelVerification` capped at one retry to avoid log noise.
- [x] `User-Agent` includes `syrotp-sdk-kotlin/<version>`.
- [x] Plain HTTP to a non-private host triggers a one-time warning at
      construction (no warning for `localhost` / RFC1918).
- [x] `apiKey` is never present in `toString(error)`, error rendering, or
      anywhere on the `syrotp` JUL logger.
- [x] Request bodies (which include the user's phone) are never logged.
- [x] Live cross-stack: every PR runs `./gradlew run` against the
      freshly-built TS server in CI's smoke job.

## Logging

The SDK logs to the `syrotp` `java.util.logging` logger. By default it
logs:

- A one-time `WARNING` on construction if `baseUrl` is plain HTTP to a
  non-private host.

The logger is **never** asked to log any of: `Authorization` header,
`apiKey` argument, request body, response body, `phone`, `message`, or
`sendTo`. If you wrap the SDK in something that does, you owned the
leak.

## Versioning

Follows [`docs/sdk-versioning.md`](../../docs/sdk-versioning.md):

- `MAJOR` tracks the protocol's `MAJOR`.
- `MINOR` adds backwards-compatible methods / options.
- `PATCH` is bug fixes only.

## Development

Requires a JDK 17+ on the path and Gradle (any 8.x; CI uses
`gradle/actions/setup-gradle@v3` to provision it):

```bash
cd packages/sdk-kotlin
gradle test                           # runs all unit tests
gradle run --args="+1 login"          # runs the live example (needs SYROTP_* env)
```

The unit tests use OkHttp's `MockWebServer` — no real network and no
running SYROTP server is needed for `gradle test`.

## License

MIT — see [`../../LICENSE`](../../LICENSE).
