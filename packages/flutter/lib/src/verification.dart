import 'verification_status.dart';

/// The shape returned by `startVerification()` in any SYROTP server
/// SDK and required as input for [SyrotpVerificationWidget].
///
/// The developer's backend calls the secret-keyed SDK to create the
/// verification, then forwards this object to the mobile client (do
/// NOT hold a secret key in the app — the secret stays server-side).
///
/// [sendTo] and [message] are server-emitted only while the row is
/// pending; they go null on terminal states. The widget mirrors that
/// contract so a stale verify code never lingers in the UI after a
/// verified / expired / cancelled transition.
class Verification {
  final String id;
  final VerificationStatus status;
  final String? sendTo;
  final String? message;
  final String phoneMasked;
  final DateTime expiresAt;
  final DateTime? verifiedAt;

  const Verification({
    required this.id,
    required this.status,
    required this.sendTo,
    required this.message,
    required this.phoneMasked,
    required this.expiresAt,
    this.verifiedAt,
  });

  /// Decode from the SYROTP wire JSON shape. Field names use the
  /// server's snake_case (`send_to`, `phone_masked`, ...).
  factory Verification.fromJson(Map<String, dynamic> json) {
    final verifiedAtRaw = json['verified_at'];
    return Verification(
      id: json['id'] as String,
      status: VerificationStatus.fromWire(json['status'] as String),
      sendTo: json['send_to'] as String?,
      message: json['message'] as String?,
      phoneMasked: json['phone_masked'] as String,
      expiresAt: DateTime.parse(json['expires_at'] as String),
      verifiedAt:
          verifiedAtRaw == null ? null : DateTime.parse(verifiedAtRaw as String),
    );
  }

  /// Build a successor verification for a status transition. Mirrors
  /// the server contract: `sendTo` and `message` are nulled on any
  /// non-pending status.
  Verification withTransition({
    required VerificationStatus status,
    required DateTime expiresAt,
    DateTime? verifiedAt,
  }) {
    final isPending = status == VerificationStatus.pending;
    return Verification(
      id: id,
      status: status,
      sendTo: isPending ? sendTo : null,
      message: isPending ? message : null,
      phoneMasked: phoneMasked,
      expiresAt: expiresAt,
      verifiedAt: verifiedAt,
    );
  }

  Verification withExpiresAt(DateTime expiresAt) {
    return Verification(
      id: id,
      status: status,
      sendTo: sendTo,
      message: message,
      phoneMasked: phoneMasked,
      expiresAt: expiresAt,
      verifiedAt: verifiedAt,
    );
  }
}
