# `syrotp_flutter` — basic example

Minimal Flutter app demonstrating `SyrotpVerificationWidget` with a
hardcoded verification (UI-only, no real SYROTP server needed).

## Run locally

The example ships only the source files (`pubspec.yaml`,
`lib/main.dart`). To run on a device or simulator, scaffold the
platform folders first:

```bash
cd packages/flutter/example
flutter create --platforms=android,ios,web,macos,linux,windows .
flutter pub get
flutter run -d <device>
```

The hardcoded verification's `baseUrl` is `http://localhost:3000` —
status polling is a no-op against that unless you also have an
SYROTP server running and reachable from your device. That's fine
for inspecting the UI.

In a real app, your backend calls `startVerification()` via the
secret SDK, forwards the result to the app, and the app passes it
to `SyrotpVerificationWidget`.
