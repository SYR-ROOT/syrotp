/// The five lifecycle states a verification can be in. Wire format
/// is the lowercase string; this enum matches that one-to-one via
/// [fromWire] / [toWire].
enum VerificationStatus {
  pending,
  verified,
  expired,
  cancelled,
  failed;

  /// Decode from the wire string (lowercase). Throws [ArgumentError]
  /// for unknown values rather than silently mapping to [pending].
  static VerificationStatus fromWire(String s) {
    switch (s) {
      case 'pending':
        return VerificationStatus.pending;
      case 'verified':
        return VerificationStatus.verified;
      case 'expired':
        return VerificationStatus.expired;
      case 'cancelled':
        return VerificationStatus.cancelled;
      case 'failed':
        return VerificationStatus.failed;
      default:
        throw ArgumentError('unknown verification status: $s');
    }
  }

  String toWire() => name;

  bool get isTerminal => this != VerificationStatus.pending;
}
