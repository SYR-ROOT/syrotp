import Foundation

/// The shape returned by `startVerification()` in any SYROTP server
/// SDK and required as input for ``VerificationView``.
///
/// The developer's backend calls the secret-keyed SDK to create the
/// verification, then forwards this object to the mobile client (do
/// NOT hold a secret key in the app — the secret stays server-side).
///
/// `sendTo` and `message` are server-emitted only while the row is
/// pending; they go nil on terminal states. The view mirrors that
/// contract so a stale verify code never lingers in the UI after a
/// verified / expired / cancelled transition.
///
/// Field names use the wire format (`send_to`, `phone_masked`, ...)
/// via `CodingKeys`, so JSON from the SYROTP API decodes directly.
public struct Verification: Codable, Sendable, Equatable {
    public let id: String
    public let status: VerificationStatus
    public let sendTo: String?
    public let message: String?
    public let phoneMasked: String
    public let expiresAt: Date
    public let verifiedAt: Date?

    enum CodingKeys: String, CodingKey {
        case id
        case status
        case sendTo = "send_to"
        case message
        case phoneMasked = "phone_masked"
        case expiresAt = "expires_at"
        case verifiedAt = "verified_at"
    }

    public init(
        id: String,
        status: VerificationStatus,
        sendTo: String?,
        message: String?,
        phoneMasked: String,
        expiresAt: Date,
        verifiedAt: Date? = nil
    ) {
        self.id = id
        self.status = status
        self.sendTo = sendTo
        self.message = message
        self.phoneMasked = phoneMasked
        self.expiresAt = expiresAt
        self.verifiedAt = verifiedAt
    }

    /// Build a successor verification for a status transition.
    /// Mirrors the server contract: `sendTo` and `message` are
    /// nilled on any non-pending status.
    public func transition(
        status: VerificationStatus,
        expiresAt: Date,
        verifiedAt: Date? = nil
    ) -> Verification {
        let isPending = status == .pending
        return Verification(
            id: id,
            status: status,
            sendTo: isPending ? sendTo : nil,
            message: isPending ? message : nil,
            phoneMasked: phoneMasked,
            expiresAt: expiresAt,
            verifiedAt: verifiedAt
        )
    }

    public func withExpiresAt(_ expiresAt: Date) -> Verification {
        return Verification(
            id: id,
            status: status,
            sendTo: sendTo,
            message: message,
            phoneMasked: phoneMasked,
            expiresAt: expiresAt,
            verifiedAt: verifiedAt
        )
    }
}
