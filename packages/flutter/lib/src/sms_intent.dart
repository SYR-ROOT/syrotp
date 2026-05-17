/// Build an `sms:` URI that opens the user's default SMS app
/// pre-filled with the verification message addressed to the
/// receiver msisdn.
///
/// Encoding rules match the React / Web Component / Android UI
/// packages: the body is percent-encoded the same way JavaScript's
/// `encodeURIComponent` produces — Dart's [Uri.encodeComponent]
/// happens to match that contract byte-for-byte (no space-as-`+`
/// quirk like Java's `URLEncoder`), so no patching is needed.
class SmsIntent {
  /// Build the `sms:` URI string. Public so consumers building their
  /// own intent can call this directly.
  static Uri buildSmsUri(String recipient, String body) {
    return Uri.parse('sms:$recipient?body=${encodeSmsBody(body)}');
  }

  /// Pure-Dart percent-encoding helper. Exposed so tests can pin the
  /// cross-stack contract (`%20` for spaces, percent-encoded `?`/`&`/`#`).
  static String encodeSmsBody(String body) => Uri.encodeComponent(body);
}
