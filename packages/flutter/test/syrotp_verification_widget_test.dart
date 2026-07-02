import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:syrotp_flutter/syrotp_flutter.dart';

Verification mkVerification({
  VerificationStatus status = VerificationStatus.pending,
  String? sendTo = '+963998887777',
  String? message = 'VERIFY 654321',
}) {
  return Verification(
    id: 'vrf_abc123',
    status: status,
    sendTo: sendTo,
    message: message,
    phoneMasked: '+963 99* *** *567',
    expiresAt: DateTime.now().add(const Duration(minutes: 10)),
    verifiedAt: null,
  );
}

http.Client _alwaysPending() => MockClient((req) async {
      // Always reply "still pending" — same status as the initial prop,
      // so the widget never transitions during the test. No
      // `Future.delayed` here: that creates a fake-async Timer which
      // would leak past the widget's dispose and trip the test
      // framework's "pending timers" assertion.
      return http.Response(
        jsonEncode({
          'status': 'pending',
          'expires_at':
              DateTime.now().add(const Duration(minutes: 10)).toIso8601String(),
          'verified_at': null,
        }),
        200,
      );
    });

void main() {
  group('SyrotpVerificationWidget', () {
    testWidgets('renders message + send_to + countdown when pending',
        (tester) async {
      await tester.pumpWidget(MaterialApp(
        home: Scaffold(
          body: SyrotpVerificationWidget(
            verification: mkVerification(),
            baseUrl: 'https://otp.example.com',
            httpClient: _alwaysPending(),
          ),
        ),
      ));
      expect(find.text('VERIFY 654321'), findsOneWidget);
      expect(find.text('To: +963998887777'), findsOneWidget);
      expect(find.text('Copy'), findsOneWidget);
      expect(find.text('Open SMS app'), findsOneWidget);
      // Tear the tree down so the widget's controller disposes timers
      // before the test exits (avoids "pending timers" failures).
      await tester.pumpWidget(const SizedBox.shrink());
    });

    testWidgets('renders the verified state and never surfaces the message',
        (tester) async {
      await tester.pumpWidget(MaterialApp(
        home: Scaffold(
          body: SyrotpVerificationWidget(
            verification: mkVerification(
              status: VerificationStatus.verified,
              sendTo: null,
              message: null,
            ),
            baseUrl: 'https://otp.example.com',
            httpClient: _alwaysPending(),
          ),
        ),
      ));
      expect(find.text('Phone verified.'), findsOneWidget);
      expect(find.text('VERIFY 654321'), findsNothing);
      await tester.pumpWidget(const SizedBox.shrink());
    });

    testWidgets('renders the expired state', (tester) async {
      await tester.pumpWidget(MaterialApp(
        home: Scaffold(
          body: SyrotpVerificationWidget(
            verification: mkVerification(
              status: VerificationStatus.expired,
              sendTo: null,
              message: null,
            ),
            baseUrl: 'https://otp.example.com',
            httpClient: _alwaysPending(),
          ),
        ),
      ));
      expect(find.textContaining('expired'), findsOneWidget);
      await tester.pumpWidget(const SizedBox.shrink());
    });

    testWidgets('renders the cancelled state', (tester) async {
      await tester.pumpWidget(MaterialApp(
        home: Scaffold(
          body: SyrotpVerificationWidget(
            verification: mkVerification(
              status: VerificationStatus.cancelled,
              sendTo: null,
              message: null,
            ),
            baseUrl: 'https://otp.example.com',
            httpClient: _alwaysPending(),
          ),
        ),
      ));
      expect(find.text('Verification cancelled.'), findsOneWidget);
      await tester.pumpWidget(const SizedBox.shrink());
    });

    testWidgets('respects a custom initialInstruction', (tester) async {
      await tester.pumpWidget(MaterialApp(
        home: Scaffold(
          body: SyrotpVerificationWidget(
            verification: mkVerification(),
            baseUrl: 'https://otp.example.com',
            initialInstruction: 'Send the SMS now to confirm.',
            httpClient: _alwaysPending(),
          ),
        ),
      ));
      expect(find.text('Send the SMS now to confirm.'), findsOneWidget);
      await tester.pumpWidget(const SizedBox.shrink());
    });
  });
}
