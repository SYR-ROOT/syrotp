import Foundation

/// Typed error hierarchy. Mirrors `docs/sdk-contract.md` §5.
///
/// Application code is expected to catch by category:
///
///     do {
///         _ = try await client.startVerification(phone: "+963...", purpose: "login")
///     } catch let e as SyrotpRateLimitError {
///         try await Task.sleep(nanoseconds: UInt64(e.retryAfterSeconds ?? 1) * 1_000_000_000)
///     } catch let e as SyrotpValidationError {
///         // surface to user; do NOT auto-retry
///     } catch let e as SyrotpError {
///         // catch-all for any other Syrotp* category
///     }
///
/// Every error carries:
///  - `code`        : short stable string (e.g. `"validation_error"`)
///  - `message`     : human-readable; never contains the api_key
///  - `httpStatus`  : HTTP status, or 0 for purely-local failures
///  - `requestId`   : the server-issued request_id when present
///
/// `description` deliberately surfaces only those four attributes so
/// `print(error)` cannot leak credentials.
public class SyrotpError: Error, CustomStringConvertible, LocalizedError {
    public let code: String
    public let message: String
    public let httpStatus: Int
    public let requestId: String?
    public let underlying: Error?

    public init(
        code: String,
        message: String,
        httpStatus: Int = 0,
        requestId: String? = nil,
        underlying: Error? = nil
    ) {
        self.code = code
        self.message = message
        self.httpStatus = httpStatus
        self.requestId = requestId
        self.underlying = underlying
    }

    public var description: String {
        let cls = String(describing: type(of: self))
        if let rid = requestId {
            return "\(cls)(code=\(code), message=\(message), httpStatus=\(httpStatus), requestId=\(rid))"
        }
        return "\(cls)(code=\(code), message=\(message), httpStatus=\(httpStatus))"
    }

    public var errorDescription: String? { description }
}

/// Construction-time validation failure. NOT retriable.
public final class SyrotpConfigError: SyrotpError {
    public init(_ message: String, code: String = "config_error") {
        super.init(code: code, message: message)
    }
}

/// HTTP 401 / 403. NOT retriable — keys don't fix themselves.
public final class SyrotpAuthError: SyrotpError {
    public override init(
        code: String,
        message: String,
        httpStatus: Int = 401,
        requestId: String? = nil,
        underlying: Error? = nil
    ) {
        super.init(
            code: code, message: message,
            httpStatus: httpStatus, requestId: requestId, underlying: underlying
        )
    }
}

/// HTTP 400 or local input validation. NOT retriable.
public final class SyrotpValidationError: SyrotpError {
    public override init(
        code: String,
        message: String,
        httpStatus: Int = 400,
        requestId: String? = nil,
        underlying: Error? = nil
    ) {
        super.init(
            code: code, message: message,
            httpStatus: httpStatus, requestId: requestId, underlying: underlying
        )
    }
}

/// HTTP 429. Carries `retryAfterSeconds` parsed from `Retry-After`.
/// Retriable, bounded, respects the server's hint.
public final class SyrotpRateLimitError: SyrotpError {
    public let retryAfterSeconds: Int?

    public init(
        code: String,
        message: String,
        httpStatus: Int = 429,
        requestId: String? = nil,
        retryAfterSeconds: Int? = nil
    ) {
        self.retryAfterSeconds = retryAfterSeconds
        super.init(code: code, message: message, httpStatus: httpStatus, requestId: requestId)
    }
}

/// DNS, TLS, connection refused / reset, broken response. Retriable.
public final class SyrotpNetworkError: SyrotpError {
    public init(message: String, code: String = "network_error", underlying: Error? = nil) {
        super.init(code: code, message: message, httpStatus: 0, underlying: underlying)
    }
}

/// HTTP 5xx. Retriable.
public final class SyrotpServerError: SyrotpError {
    public override init(
        code: String,
        message: String,
        httpStatus: Int,
        requestId: String? = nil,
        underlying: Error? = nil
    ) {
        super.init(
            code: code, message: message,
            httpStatus: httpStatus, requestId: requestId, underlying: underlying
        )
    }
}

/// The per-request deadline (`SyrotpClient.timeoutSeconds`) elapsed.
/// NOT retriable by the SDK — the caller's deadline already expired.
public final class SyrotpTimeoutError: SyrotpError {
    public init(message: String = "request timed out", underlying: Error? = nil) {
        super.init(code: "timeout", message: message, httpStatus: 0, underlying: underlying)
    }
}
