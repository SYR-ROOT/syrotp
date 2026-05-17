import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:syrotp_flutter/syrotp_flutter.dart';

Verification mkVerification({
  String id = 'vrf_abc123',
  VerificationStatus status = VerificationStatus.pending,
  DateTime? expiresAt,
}) {
  return Verification(
    id: id,
    status: status,
    sendTo: '+963998887777',
    message: 'VERIFY 123456',
    phoneMasked: '+963 99* *** *567',
    expiresAt: expiresAt ?? DateTime.now().add(const Duration(minutes: 10)),
    verifiedAt: null,
  );
}

String pendingBody({DateTime? expiresAt}) => jsonEncode({
      'status': 'pending',
      'expires_at':
          (expiresAt ?? DateTime.now().add(const Duration(minutes: 10)))
              .toIso8601String(),
      'verified_at': null,
    });

Future<void> waitFor(
  bool Function() cond, {
  Duration timeout = const Duration(seconds: 3),
  Duration interval = const Duration(milliseconds: 10),
}) async {
  final deadline = DateTime.now().add(timeout);
  while (!cond()) {
    if (DateTime.now().isAfter(deadline)) {
      throw TimeoutException('condition not met within $timeout');
    }
    await Future<void>.delayed(interval);
  }
}

void main() {
  group('VerificationController', () {
    test('polls /v/:id/status against the configured baseUrl with trailing slash trimmed',
        () async {
      final completer = Completer<Uri>();
      final mock = MockClient((req) async {
        if (!completer.isCompleted) completer.complete(req.url);
        return http.Response(pendingBody(), 200);
      });
      final c = VerificationController(
        baseUrl: 'https://otp.example.com/',
        initial: mkVerification(),
        pollInterval: const Duration(milliseconds: 50),
        httpClient: mock,
      );
      c.start();
      final uri =
          await completer.future.timeout(const Duration(seconds: 2));
      expect(uri.toString(), 'https://otp.example.com/v/vrf_abc123/status');
      c.dispose();
    });

    test(
        'fires onVerified on the pending → verified transition and clears send_to/message',
        () async {
      final verifiedAt = DateTime.now().toUtc().toIso8601String();
      final mock = MockClient((req) async {
        return http.Response(
          jsonEncode({
            'status': 'verified',
            'expires_at': DateTime.now()
                .add(const Duration(minutes: 10))
                .toIso8601String(),
            'verified_at': verifiedAt,
          }),
          200,
        );
      });
      Verification? received;
      final c = VerificationController(
        baseUrl: 'https://otp.example.com',
        initial: mkVerification(),
        pollInterval: const Duration(milliseconds: 50),
        httpClient: mock,
        onVerified: (v) => received = v,
      );
      c.start();
      await waitFor(() => received != null);
      expect(received!.status, VerificationStatus.verified);
      expect(received!.sendTo, isNull);
      expect(received!.message, isNull);
      c.dispose();
    });

    test('fires onCancelled on the pending → cancelled transition', () async {
      final mock = MockClient((req) async {
        return http.Response(
          jsonEncode({
            'status': 'cancelled',
            'expires_at': DateTime.now()
                .add(const Duration(minutes: 10))
                .toIso8601String(),
            'verified_at': null,
          }),
          200,
        );
      });
      Verification? received;
      final c = VerificationController(
        baseUrl: 'https://otp.example.com',
        initial: mkVerification(),
        pollInterval: const Duration(milliseconds: 50),
        httpClient: mock,
        onCancelled: (v) => received = v,
      );
      c.start();
      await waitFor(() => received != null);
      expect(received!.status, VerificationStatus.cancelled);
      c.dispose();
    });

    test('fires onExpired when the server reports expired', () async {
      final mock = MockClient((req) async {
        return http.Response(
          jsonEncode({
            'status': 'expired',
            'expires_at': DateTime.now()
                .subtract(const Duration(seconds: 1))
                .toIso8601String(),
            'verified_at': null,
          }),
          200,
        );
      });
      Verification? received;
      final c = VerificationController(
        baseUrl: 'https://otp.example.com',
        initial: mkVerification(),
        pollInterval: const Duration(milliseconds: 50),
        httpClient: mock,
        onExpired: (v) => received = v,
      );
      c.start();
      await waitFor(() => received != null);
      c.dispose();
    });

    test('calls onError on HTTP failure but keeps state pending', () async {
      final mock = MockClient((req) async => http.Response('{}', 500));
      Object? err;
      final c = VerificationController(
        baseUrl: 'https://otp.example.com',
        initial: mkVerification(),
        pollInterval: const Duration(milliseconds: 50),
        httpClient: mock,
        onError: (e) => err = e,
      );
      c.start();
      await waitFor(() => err != null);
      expect(c.value.verification.status, VerificationStatus.pending);
      c.dispose();
    });

    test('does not poll when initial state is already terminal', () async {
      var hits = 0;
      final mock = MockClient((req) async {
        hits++;
        return http.Response(pendingBody(), 200);
      });
      final c = VerificationController(
        baseUrl: 'https://otp.example.com',
        initial: mkVerification(status: VerificationStatus.verified)
            .withTransition(
          status: VerificationStatus.verified,
          expiresAt: DateTime.now(),
          verifiedAt: DateTime.now(),
        ),
        pollInterval: const Duration(milliseconds: 30),
        httpClient: mock,
      );
      c.start();
      await Future<void>.delayed(const Duration(milliseconds: 120));
      expect(hits, 0);
      c.dispose();
    });

    test('local TTL fallback fires onExpired when expires_at passes', () async {
      // The mock client responds slowly enough that polling never lands a
      // verdict during the test window — the countdown coroutine drives
      // the transition instead.
      final mock = MockClient((req) async {
        await Future<void>.delayed(const Duration(seconds: 30));
        return http.Response(pendingBody(), 200);
      });

      var fakeNow = DateTime.fromMillisecondsSinceEpoch(0);
      final expiresAt = DateTime.fromMillisecondsSinceEpoch(2000);
      Verification? received;
      final c = VerificationController(
        baseUrl: 'https://otp.example.com',
        initial: mkVerification(expiresAt: expiresAt),
        pollInterval: const Duration(seconds: 30),
        httpClient: mock,
        onExpired: (v) => received = v,
        now: () => fakeNow,
      );
      c.start();
      // Step the clock past expires_at; the next 1Hz countdown tick
      // (real time) will see <= 0 and transition to expired.
      fakeNow = DateTime.fromMillisecondsSinceEpoch(3000);
      await waitFor(
        () => received != null,
        timeout: const Duration(seconds: 3),
      );
      expect(c.value.verification.status, VerificationStatus.expired);
      expect(received!.sendTo, isNull);
      expect(received!.message, isNull);
      c.dispose();
    });
  });
}
