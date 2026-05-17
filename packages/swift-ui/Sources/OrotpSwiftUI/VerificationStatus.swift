import Foundation

/// The five lifecycle states a verification can be in. The wire
/// format spells them in lowercase; Swift's default `String`
/// rawValue for `case foo` is `"foo"` — which matches the wire
/// format byte-for-byte.
public enum VerificationStatus: String, Codable, Sendable, CaseIterable {
    case pending
    case verified
    case expired
    case cancelled
    case failed

    public var isTerminal: Bool { self != .pending }
}
