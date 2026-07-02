import Foundation

/// The five known verification statuses, plus `unknown` for forward
/// compat. The string form matches the wire (`pending`, `verified`, …).
public enum VerificationStatus: String, Sendable, CaseIterable {
    case pending
    case verified
    case expired
    case cancelled
    case failed

    /// Returned for any wire value this SDK doesn't know about. Lets a
    /// server bump introduce a new status without breaking older SDKs —
    /// see `docs/sdk-versioning.md` §4.
    case unknown

    /// Map a wire string to the enum, collapsing unknown values to
    /// `.unknown` instead of throwing. Critical for version-skew compat.
    public static func from(wire: String?) -> VerificationStatus {
        guard let w = wire else { return .unknown }
        return VerificationStatus(rawValue: w) ?? .unknown
    }
}

/// Minimal JSON value used for forward-compat extras only. Application
/// code reads `extras["future_field"]` and pattern-matches as needed.
public enum JSONValue: Sendable, Equatable {
    case string(String)
    case int(Int)
    case double(Double)
    case bool(Bool)
    case array([JSONValue])
    case object([String: JSONValue])
    case null
}

/// A verification record from the server.
///
/// Field names track [openapi.yaml's Verification schema](../../openapi.yaml).
///
/// `extras` captures any field the server returned that this SDK
/// version doesn't know about — important so application code can
/// read newer optional fields without an SDK upgrade.
public struct Verification: Sendable, Equatable {
    public let id: String
    public let status: VerificationStatus
    public let phoneMasked: String
    public let expiresAt: String
    public let createdAt: String
    public let sendTo: String?
    public let message: String?
    public let clientRef: String?
    public let purpose: String?
    public let verifiedAt: String?
    public let attempts: Int?
    public let extras: [String: JSONValue]

    public init(
        id: String,
        status: VerificationStatus,
        phoneMasked: String,
        expiresAt: String,
        createdAt: String,
        sendTo: String? = nil,
        message: String? = nil,
        clientRef: String? = nil,
        purpose: String? = nil,
        verifiedAt: String? = nil,
        attempts: Int? = nil,
        extras: [String: JSONValue] = [:]
    ) {
        self.id = id
        self.status = status
        self.phoneMasked = phoneMasked
        self.expiresAt = expiresAt
        self.createdAt = createdAt
        self.sendTo = sendTo
        self.message = message
        self.clientRef = clientRef
        self.purpose = purpose
        self.verifiedAt = verifiedAt
        self.attempts = attempts
        self.extras = extras
    }

    /// Build a Verification from a parsed JSON object. Throws an
    /// `SyrotpError` (not a Swift error case) if a required field is
    /// missing — the SDK's error type is the only one application code
    /// should see.
    static func from(jsonObject: [String: Any]) throws -> Verification {
        func requireString(_ key: String) throws -> String {
            guard let s = jsonObject[key] as? String else {
                throw SyrotpError(
                    code: "bad_response",
                    message: "missing or non-string '\(key)' in response"
                )
            }
            return s
        }

        let known: Set<String> = [
            "id", "status", "phone_masked", "expires_at", "created_at",
            "send_to", "message", "client_ref", "purpose", "verified_at", "attempts",
        ]

        var extras: [String: JSONValue] = [:]
        for (k, v) in jsonObject where !known.contains(k) {
            extras[k] = JSONValue.fromAny(v)
        }

        return Verification(
            id: try requireString("id"),
            status: VerificationStatus.from(wire: jsonObject["status"] as? String),
            phoneMasked: try requireString("phone_masked"),
            expiresAt: try requireString("expires_at"),
            createdAt: try requireString("created_at"),
            sendTo: jsonObject["send_to"] as? String,
            message: jsonObject["message"] as? String,
            clientRef: jsonObject["client_ref"] as? String,
            purpose: jsonObject["purpose"] as? String,
            verifiedAt: jsonObject["verified_at"] as? String,
            attempts: jsonObject["attempts"] as? Int,
            extras: extras
        )
    }
}

extension JSONValue {
    static func fromAny(_ value: Any) -> JSONValue {
        switch value {
        case let s as String: return .string(s)
        case let b as Bool: return .bool(b)  // must precede Int (NSNumber bool/int conflation)
        case let i as Int: return .int(i)
        case let d as Double: return .double(d)
        case let arr as [Any]: return .array(arr.map(JSONValue.fromAny))
        case let dict as [String: Any]:
            var out: [String: JSONValue] = [:]
            for (k, v) in dict { out[k] = JSONValue.fromAny(v) }
            return .object(out)
        case is NSNull: return .null
        default: return .null
        }
    }
}
