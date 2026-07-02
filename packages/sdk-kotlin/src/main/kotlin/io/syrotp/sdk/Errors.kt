package io.syrotp.sdk

/**
 * Typed error hierarchy. Mirrors `docs/sdk-contract.md` §5.
 *
 * Every error carries:
 *  - [code] : short stable string (e.g. "validation_error")
 *  - [message] : human-readable; never contains the api_key or request body
 *  - [httpStatus] : HTTP status, or 0 for purely-local failures
 *  - [requestId] : the server-issued request_id when present
 *
 * `toString()` deliberately surfaces only those four attributes so a
 * naive `log.error(syrotpError.toString())` cannot leak credentials.
 */
public open class SyrotpError(
    public val code: String,
    message: String,
    public val httpStatus: Int = 0,
    public val requestId: String? = null,
    cause: Throwable? = null,
) : RuntimeException(message, cause) {

    override fun toString(): String = buildString {
        append(this@SyrotpError::class.simpleName)
        append('(')
        append("code=").append(code)
        append(", message=").append(message)
        append(", httpStatus=").append(httpStatus)
        append(", requestId=").append(requestId)
        append(')')
    }
}

/** Construction-time validation failure. NOT retriable. */
public class SyrotpConfigError(
    message: String,
    code: String = "config_error",
) : SyrotpError(code, message, httpStatus = 0)

/** HTTP 401 / 403. NOT retriable — keys don't fix themselves. */
public class SyrotpAuthError(
    code: String,
    message: String,
    httpStatus: Int,
    requestId: String? = null,
) : SyrotpError(code, message, httpStatus, requestId)

/** HTTP 400 or local input validation. NOT retriable. */
public class SyrotpValidationError(
    code: String,
    message: String,
    httpStatus: Int = 400,
    requestId: String? = null,
) : SyrotpError(code, message, httpStatus, requestId)

/**
 * HTTP 429. Carries [retryAfterSeconds] parsed from `Retry-After`.
 *
 * Retriable, bounded, respects the server's hint.
 */
public class SyrotpRateLimitError(
    code: String,
    message: String,
    httpStatus: Int = 429,
    requestId: String? = null,
    public val retryAfterSeconds: Int? = null,
) : SyrotpError(code, message, httpStatus, requestId)

/** DNS, TLS, connection refused / reset, broken response. Retriable. */
public class SyrotpNetworkError(
    code: String = "network_error",
    message: String,
    cause: Throwable? = null,
) : SyrotpError(code, message, httpStatus = 0, requestId = null, cause = cause)

/** HTTP 5xx. Retriable. */
public class SyrotpServerError(
    code: String,
    message: String,
    httpStatus: Int,
    requestId: String? = null,
) : SyrotpError(code, message, httpStatus, requestId)

/**
 * The per-request deadline ([SyrotpClient.timeoutMs]) elapsed.
 *
 * NOT retriable by the SDK — the caller's deadline already expired.
 */
public class SyrotpTimeoutError(
    message: String = "request timed out",
    cause: Throwable? = null,
) : SyrotpError(code = "timeout", message = message, httpStatus = 0, requestId = null, cause = cause)
