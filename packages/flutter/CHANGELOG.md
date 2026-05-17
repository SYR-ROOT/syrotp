# Changelog

All notable changes to `syrotp_flutter` are documented here.

For the full project history (server, gateways, all SDKs and UI
packages), see the repository-wide changelog at
<https://github.com/SYR-ROOT/syrotp/blob/main/CHANGELOG.md>.

## 0.1.0

- Initial release of `syrotp_flutter` — Flutter widget for the
  Syrian Reverse OTP Protocol verification flow.
- Multi-platform: Android, iOS, web, macOS, Linux, Windows.
- Ships `SyrotpVerificationWidget` (Material 3 StatefulWidget),
  `VerificationController` (a `ValueNotifier<VerificationState>`),
  `Verification` / `VerificationStatus` (manual `fromJson`
  matching the SYROTP wire format), and `SmsIntent` (`%20`-encoded
  body, cross-stack-byte-identical with the React, Web Component,
  Android-UI, and SwiftUI packages).
- SMS handoff via `url_launcher`; clipboard via Flutter's
  built-in `Clipboard`. Zero SMS permissions.
