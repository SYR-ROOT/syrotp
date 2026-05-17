/// Flutter widget for the Syrian Reverse OTP Protocol verification flow.
///
/// Same wire contract and lifecycle as the React, Web Component, and
/// Android Compose UI packages: the developer's backend creates the
/// verification (secret-keyed) and forwards the result to the mobile
/// client; the widget polls the public `/v/:id/status` endpoint and
/// fires the appropriate callback on each transition.
library;

export 'src/verification.dart';
export 'src/verification_status.dart';
export 'src/verification_controller.dart' show VerificationController, VerificationState;
export 'src/syrotp_verification_widget.dart' show SyrotpVerificationWidget;
export 'src/sms_intent.dart' show SmsIntent;
