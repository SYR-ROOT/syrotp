# syrotp-android-ui

Jetpack Compose verification screen for the Syrian Reverse OTP Protocol.

Same wire contract and lifecycle as
[`@syrotp/react`](../react/) and [`@syrotp/web-component`](../web-component/),
built on Compose + Material 3 + OkHttp.

This Gradle project is two modules:

- **`:library`** — `dev.syrotp:ui` (publishable Android library AAR).
  Exposes `SyrotpVerificationScreen` (the @Composable), `Verification`,
  `VerificationStatus`, `VerificationController`, and `SmsIntent`.
- **`:demo`** — `dev.syrotp.ui.demo` (runnable APK). Hardcoded
  verification, lets you see the UI without an SYROTP server.

## Build & test

```bash
cd packages/android-ui
gradle :library:testDebugUnitTest    # controller unit tests (JVM, MockWebServer)
gradle :library:assembleRelease      # publishable AAR
gradle :demo:assembleDebug           # debug APK for sideloading
```

Android Studio: open `packages/android-ui/` as a Gradle project,
pick the `:demo` run configuration.

## How the data flow works

`startVerification()` is a **secret-keyed** operation — it must run
on your backend, never in the mobile app. The screen is a pure
consumer: it receives the full result object and polls the public
read endpoint for status changes.

```
[Mobile app]                     [Your backend]                    [SYROTP server]
   │                                  │                                  │
   │   POST /api/start-verify ───────▶│                                  │
   │                                  │  client.startVerification(...) ──▶
   │                                  │◀──────────── { id, send_to,      │
   │                                  │              message, ... }      │
   │◀────────── verification ─────────│                                  │
   │                                                                     │
   │  SyrotpVerificationScreen(verification = ..., baseUrl = ...)         │
   │                                                                     │
   │  GET /v/:id/status (public, IP-rate-limited)  ──────────────────────▶
   │◀───────────────────────── { status, expires_at, verified_at }       │
```

## Usage

```kotlin
import dev.syrotp.ui.SyrotpVerificationScreen
import dev.syrotp.ui.Verification

setContent {
    MaterialTheme {
        SyrotpVerificationScreen(
            verification = verification,         // from your backend
            baseUrl = "https://syrotp.example.com",
            onVerified = { v -> /* navigate forward */ },
            onExpired = { v -> /* show retry CTA */ },
            onCancelled = { v -> /* go back */ },
            onError = { e -> /* surface to UI */ },
        )
    }
}
```

The `Verification` data class matches the SYROTP server wire format —
your backend can `Json.encodeToString(verification)` and your app can
`Json.decodeFromString<Verification>(jsonString)`.

## Composable parameters

| Parameter | Notes |
| --- | --- |
| `verification: Verification` | Full result of `startVerification()` from your backend. |
| `baseUrl: String` | Origin of the SYROTP server. The screen appends `/v/:id/status`. |
| `pollIntervalMs: Long` | Default 2500ms. Polling stops on terminal status. |
| `initialInstruction: String` | Headline shown above the SMS message. Default: "Send this SMS to verify your phone." |
| `onVerified` / `onExpired` / `onCancelled` | Fired exactly once on the corresponding `pending → terminal` transition. |
| `onError: (Throwable) -> Unit` | Fired on poll failures. The screen keeps polling. |

## Headless controller

`VerificationController` is a pure-Kotlin state machine for the
verification lifecycle. Useful when you want to build a custom UI:

```kotlin
val controller = VerificationController(
    baseUrl = "https://syrotp.example.com",
    initial = verification,
    onVerified = { v -> /* ... */ },
)

// In a CoroutineScope (e.g., a ViewModel's viewModelScope):
controller.start(viewModelScope)
controller.state.collect { state ->
    // state.verification, state.secondsLeft
}

// On teardown:
controller.stop()
```

## Out of scope (intentional)

- **No SMS reading.** This library does not request SMS permissions
  and does not read user messages. The user taps "Open SMS app" and
  sends the message themselves — that's the whole point of reverse
  OTP. Auto-completion would require `RECEIVE_SMS` permission, which
  is restricted on Google Play and is not the SYROTP threat model.
- **No Android Gateway changes.** The receiver gateway lives in
  `apps/gsm-gateway/` (Python). This package is a client-side UI
  only.
- **No server changes.** Polling reuses the public `/v/:id/status`
  endpoint shipped in SYROTP server v0.5.0.
- **No Compose UI tests.** The controller is JVM-tested. Compose UI
  tests would need Robolectric or instrumented tests; that's a
  follow-up if the screen grows enough complexity to warrant it.
