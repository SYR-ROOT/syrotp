import 'dart:async';
import 'dart:convert';
import 'dart:io' show HttpException;

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;

import 'verification.dart';
import 'verification_status.dart';

/// Snapshot of the verification + countdown shown to the user on
/// each tick. Held by [VerificationController] (a [ValueNotifier]);
/// the widget binds to it via [ValueListenableBuilder].
@immutable
class VerificationState {
  final Verification verification;
  final int secondsLeft;
  const VerificationState({required this.verification, required this.secondsLeft});

  @override
  bool operator ==(Object other) =>
      other is VerificationState &&
      other.verification == verification &&
      other.secondsLeft == secondsLeft;

  @override
  int get hashCode => Object.hash(verification, secondsLeft);
}

/// State machine driving the SYROTP verification lifecycle on Flutter.
/// Polls `${baseUrl}/v/:id/status` (the public, IP-rate-limited
/// endpoint shipped in SYROTP server v0.5.0), runs a 1Hz countdown,
/// and emits a fresh [VerificationState] on every visible change.
///
/// Lifecycle: call [start] once; the controller manages its own
/// timers and HTTP calls. Call [dispose] on teardown to cancel
/// timers and close the HTTP client.
///
/// The constructor takes a `now` clock function for testability —
/// pass a fake clock to drive the local TTL fallback path
/// deterministically.
class VerificationController extends ValueNotifier<VerificationState> {
  final String baseUrl;
  final Duration pollInterval;
  final http.Client _http;
  final void Function(Verification) onVerified;
  final void Function(Verification) onExpired;
  final void Function(Verification) onCancelled;
  final void Function(Object) onError;
  final DateTime Function() _now;

  Timer? _pollTimer;
  Timer? _countdownTimer;
  bool _started = false;
  bool _disposed = false;
  VerificationStatus _prevStatus;

  VerificationController({
    required this.baseUrl,
    required Verification initial,
    this.pollInterval = const Duration(milliseconds: 2500),
    http.Client? httpClient,
    void Function(Verification)? onVerified,
    void Function(Verification)? onExpired,
    void Function(Verification)? onCancelled,
    void Function(Object)? onError,
    DateTime Function()? now,
  })  : _http = httpClient ?? http.Client(),
        onVerified = onVerified ?? _noopV,
        onExpired = onExpired ?? _noopV,
        onCancelled = onCancelled ?? _noopV,
        onError = onError ?? _noopE,
        _now = now ?? DateTime.now,
        _prevStatus = initial.status,
        super(VerificationState(
          verification: initial,
          secondsLeft: _calcSecondsLeft(initial.expiresAt, now ?? DateTime.now),
        ));

  /// Start polling + countdown. Idempotent — calling start() a
  /// second time is a no-op.
  void start() {
    if (_started || _disposed) return;
    _started = true;
    if (value.verification.status.isTerminal) return;
    _countdownTimer = Timer.periodic(const Duration(seconds: 1), (_) => _onTick());
    // Fire one immediate poll so a fast-completing verification
    // surfaces without waiting a full interval.
    unawaited(_pollOnce());
    _pollTimer = Timer.periodic(pollInterval, (_) => unawaited(_pollOnce()));
  }

  @override
  void dispose() {
    _disposed = true;
    _pollTimer?.cancel();
    _countdownTimer?.cancel();
    _http.close();
    super.dispose();
  }

  void _onTick() {
    if (_disposed) return;
    final v = value.verification;
    if (v.status.isTerminal) return;
    final secs = _calcSecondsLeft(v.expiresAt, _now);
    if (secs <= 0) {
      _transition(v.withTransition(
        status: VerificationStatus.expired,
        expiresAt: v.expiresAt,
      ));
      return;
    }
    if (secs != value.secondsLeft) {
      value = VerificationState(verification: v, secondsLeft: secs);
    }
  }

  Future<void> _pollOnce() async {
    if (_disposed) return;
    final v = value.verification;
    if (v.status.isTerminal) return;
    final url =
        '${baseUrl.replaceAll(RegExp(r'/+$'), '')}/v/${Uri.encodeComponent(v.id)}/status';
    try {
      final res = await _http.get(
        Uri.parse(url),
        headers: const {'Accept': 'application/json'},
      );
      if (_disposed) return;
      if (res.statusCode < 200 || res.statusCode >= 300) {
        throw HttpException('status poll failed: HTTP ${res.statusCode}');
      }
      final body = jsonDecode(res.body) as Map<String, dynamic>;
      final newStatus = VerificationStatus.fromWire(body['status'] as String);
      final newExpiresAt = DateTime.parse(body['expires_at'] as String);
      final verifiedRaw = body['verified_at'];
      final newVerifiedAt =
          verifiedRaw == null ? null : DateTime.parse(verifiedRaw as String);

      final current = value.verification;
      if (newStatus == current.status) {
        if (newExpiresAt != current.expiresAt) {
          final updated = current.withExpiresAt(newExpiresAt);
          value = VerificationState(
            verification: updated,
            secondsLeft: _calcSecondsLeft(newExpiresAt, _now),
          );
        }
        return;
      }
      _transition(current.withTransition(
        status: newStatus,
        expiresAt: newExpiresAt,
        verifiedAt: newVerifiedAt,
      ));
    } catch (e) {
      if (_disposed) return;
      onError(e);
    }
  }

  void _transition(Verification next) {
    final prev = _prevStatus;
    _prevStatus = next.status;
    value = VerificationState(
      verification: next,
      secondsLeft: _calcSecondsLeft(next.expiresAt, _now),
    );
    if (prev != next.status && prev == VerificationStatus.pending) {
      switch (next.status) {
        case VerificationStatus.verified:
          onVerified(next);
          break;
        case VerificationStatus.expired:
          onExpired(next);
          break;
        case VerificationStatus.cancelled:
          onCancelled(next);
          break;
        case VerificationStatus.pending:
        case VerificationStatus.failed:
          break;
      }
    }
    if (next.status.isTerminal) {
      _pollTimer?.cancel();
      _countdownTimer?.cancel();
      _pollTimer = null;
      _countdownTimer = null;
    }
  }

  static int _calcSecondsLeft(DateTime expiresAt, DateTime Function() now) {
    final diff = expiresAt.difference(now()).inSeconds;
    return diff < 0 ? 0 : diff;
  }

  static void _noopV(Verification _) {}
  static void _noopE(Object _) {}
}
