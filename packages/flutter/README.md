# syrotp_flutter

Flutter widget for the Syrian Reverse OTP Protocol verification flow.

Same wire contract and lifecycle as
[`@syrotp/react`](../react/),
[`@syrotp/web-component`](../web-component/), and
[`syrotp-android-ui`](../android-ui/), built on Flutter + Material 3
+ `http` + `url_launcher`. Multi-platform: Android, iOS, web, macOS,
Linux, Windows.

## Install

```yaml
# pubspec.yaml
dependencies:
  syrotp_flutter: ^0.1.0
```

## How the data flow works

`startVerification()` is a **secret-keyed** operation — it must run
on your backend, never in the mobile app. The widget is a pure
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
   │  SyrotpVerificationWidget(verification: ..., baseUrl: ...)           │
   │                                                                     │
   │  GET /v/:id/status (public, IP-rate-limited)  ──────────────────────▶
   │◀───────────────────────── { status, expires_at, verified_at }       │
```

## Usage

```dart
import 'package:flutter/material.dart';
import 'package:syrotp_flutter/syrotp_flutter.dart';

class VerifyScreen extends StatelessWidget {
  final Verification verification;
  const VerifyScreen({super.key, required this.verification});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Verify your phone')),
      body: SyrotpVerificationWidget(
        verification: verification,
        baseUrl: 'https://syrotp.example.com',
        onVerified: (v) => Navigator.of(context).pop(v),
        onExpired: (v) {/* show retry CTA */},
        onCancelled: (v) {/* go back */},
        onError: (e) {/* surface to UI */},
      ),
    );
  }
}
```

The `Verification` data class matches the SYROTP server wire format —
your backend can return the JSON directly, and the app decodes it
with `Verification.fromJson(jsonMap)`.

```dart
final json = await yourBackend.startVerification(...);
final verification = Verification.fromJson(json);
```

## Widget parameters

| Parameter | Notes |
| --- | --- |
| `verification: Verification` | Full result of `startVerification()` from your backend. |
| `baseUrl: String` | Origin of the SYROTP server. The widget appends `/v/:id/status`. |
| `pollInterval: Duration` | Default 2500ms. Polling stops on terminal status. |
| `initialInstruction: String` | Headline shown above the SMS message. Default: "Send this SMS to verify your phone." |
| `onVerified` / `onExpired` / `onCancelled` | Fired exactly once on the corresponding `pending → terminal` transition. |
| `onError: (Object) -> void` | Fired on poll failures. The widget keeps polling. |
| `httpClient: http.Client?` | Optional HTTP client override. Primarily a test seam — the widget creates and disposes its own internally if null. |

## Headless controller

`VerificationController` is a `ValueNotifier<VerificationState>`
exposing the polling/state-machine logic without the UI. Useful
when you want to drive a custom UI:

```dart
final controller = VerificationController(
  baseUrl: 'https://syrotp.example.com',
  initial: verification,
  onVerified: (v) {/* ... */},
);

controller.start();
ValueListenableBuilder<VerificationState>(
  valueListenable: controller,
  builder: (context, state, _) {
    return Text('${state.verification.status} — ${state.secondsLeft}s left');
  },
);

// On teardown:
controller.dispose();
```

## Out of scope (intentional)

- **No SMS reading.** This package does not request SMS permissions
  and does not read user messages. The user taps "Open SMS app" and
  sends the message themselves — that's the reverse-OTP threat model.
- **No Android Gateway plugin.** The receiver gateway lives in
  `apps/gsm-gateway/` (Python). This is a client-side widget only.
- **No server changes.** Polling reuses the public `/v/:id/status`
  endpoint shipped in SYROTP server v0.5.0.
- **No WebAuthn inline UI.**
- **No React Native** — see `@syrotp/react` for the React option.
