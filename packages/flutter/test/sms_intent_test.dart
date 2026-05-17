import 'package:flutter_test/flutter_test.dart';
import 'package:syrotp_flutter/syrotp_flutter.dart';

void main() {
  group('SmsIntent', () {
    test('encodeSmsBody percent-encodes spaces as %20 (cross-stack contract)',
        () {
      expect(SmsIntent.encodeSmsBody('VERIFY 123456'), 'VERIFY%20123456');
    });

    test('encodeSmsBody percent-encodes special characters', () {
      expect(SmsIntent.encodeSmsBody('a&b'), 'a%26b');
      expect(SmsIntent.encodeSmsBody('a?b'), 'a%3Fb');
      expect(SmsIntent.encodeSmsBody('a#b'), 'a%23b');
    });

    test('encodeSmsBody keeps ASCII letters and digits as-is', () {
      expect(SmsIntent.encodeSmsBody('ABC123abc'), 'ABC123abc');
    });

    test('buildSmsUri produces sms: scheme with encoded body', () {
      final uri = SmsIntent.buildSmsUri('+963998887777', 'VERIFY 123456');
      expect(uri.scheme, 'sms');
      // Dart's Uri.parse decodes the body parameter for queryParameters,
      // so we assert against the decoded value.
      expect(uri.queryParameters['body'], 'VERIFY 123456');
      // The toString preserves the encoded form.
      expect(uri.toString(), 'sms:+963998887777?body=VERIFY%20123456');
    });
  });
}
