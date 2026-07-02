import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Centralizes the retry policy and the HTTP-status-to-exception mapping.
///
/// Tests can replace `sleeper` with a no-op closure to skip wall-clock
/// time without spinning real Tasks.
///
/// Retries happen on:
///  - `SyrotpNetworkError`   (DNS / TLS / connection failures)
///  - `SyrotpServerError`    (HTTP 5xx)
///  - `SyrotpRateLimitError` (HTTP 429, honoring `Retry-After`)
///
/// Never retries on:
///  - `SyrotpAuthError`
///  - `SyrotpValidationError`
///  - `SyrotpTimeoutError`
///  - any other non-retriable `SyrotpError`
struct HttpExecutor {
    let maxRetries: Int
    let sleeper: @Sendable (TimeInterval) async -> Void

    init(
        maxRetries: Int,
        sleeper: @escaping @Sendable (TimeInterval) async -> Void = { seconds in
            let nanos = UInt64(max(0, seconds) * 1_000_000_000)
            try? await Task.sleep(nanoseconds: nanos)
        }
    ) {
        precondition(maxRetries >= 0, "maxRetries must be >= 0")
        self.maxRetries = maxRetries
        self.sleeper = sleeper
    }

    /// Run `transport()` up to `maxRetries + 1` times. On retriable
    /// failures, sleep with backoff and try again.
    ///
    /// `parse` is called only on 2xx; the executor itself maps non-2xx
    /// responses to typed errors and decides whether to retry.
    func execute<T>(
        transport: @Sendable () async throws -> (Data, HTTPURLResponse),
        parse: @Sendable (Data, HTTPURLResponse) throws -> T
    ) async throws -> T {
        var attempt = 0
        while true {
            let data: Data
            let response: HTTPURLResponse
            do {
                (data, response) = try await transport()
            } catch let urlError as URLError where urlError.code == .timedOut {
                // Per the contract: SDK does NOT auto-retry timeouts —
                // the caller's deadline already expired.
                throw SyrotpTimeoutError(
                    message: urlError.localizedDescription,
                    underlying: urlError
                )
            } catch let urlError as URLError where urlError.code == .cancelled {
                // Caller cancelled their Task — bubble it as
                // CancellationError, NOT a timeout.
                throw CancellationError()
            } catch {
                let err = SyrotpNetworkError(
                    message: error.localizedDescription,
                    underlying: error
                )
                if attempt < maxRetries {
                    await sleeper(Backoff.seconds(for: attempt + 1))
                    attempt += 1
                    continue
                }
                throw err
            }

            // 2xx: parse and return.
            if (200..<300).contains(response.statusCode) {
                return try parse(data, response)
            }

            // Non-2xx: map to typed error. Retry if retriable and budget remains.
            let typed = errorFromResponse(data: data, response: response)
            if attempt < maxRetries, isRetriable(typed) {
                let sleepSeconds: TimeInterval
                if let rate = typed as? SyrotpRateLimitError, let retryAfter = rate.retryAfterSeconds {
                    // Sleep at LEAST Retry-After; jitter MAY make it longer.
                    sleepSeconds = max(Backoff.seconds(for: attempt + 1), TimeInterval(retryAfter))
                } else {
                    sleepSeconds = Backoff.seconds(for: attempt + 1)
                }
                await sleeper(sleepSeconds)
                attempt += 1
                continue
            }
            throw typed
        }
    }

    private func isRetriable(_ error: SyrotpError) -> Bool {
        switch error {
        case is SyrotpNetworkError, is SyrotpServerError, is SyrotpRateLimitError:
            return true
        default:
            return false
        }
    }

    private func errorFromResponse(data: Data, response: HTTPURLResponse) -> SyrotpError {
        let status = response.statusCode
        var code = "http_\(status)"
        var message = "request failed with status \(status)"
        var requestId: String? = nil

        if !data.isEmpty {
            if let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let errObj = parsed["error"] as? [String: Any] {
                if let c = errObj["code"] as? String { code = c }
                if let m = errObj["message"] as? String { message = m }
                if let r = errObj["request_id"] as? String { requestId = r }
            } else if (try? JSONSerialization.jsonObject(with: data)) == nil {
                code = "bad_response"
                message = "non-JSON response (status \(status))"
            }
        }

        switch status {
        case 401, 403:
            return SyrotpAuthError(code: code, message: message, httpStatus: status, requestId: requestId)
        case 400:
            return SyrotpValidationError(code: code, message: message, httpStatus: status, requestId: requestId)
        case 429:
            let retryAfter = parseRetryAfter(response.value(forHTTPHeaderField: "Retry-After"))
            return SyrotpRateLimitError(
                code: code,
                message: message,
                httpStatus: 429,
                requestId: requestId,
                retryAfterSeconds: retryAfter
            )
        case 500...599:
            return SyrotpServerError(code: code, message: message, httpStatus: status, requestId: requestId)
        default:
            return SyrotpError(code: code, message: message, httpStatus: status, requestId: requestId)
        }
    }

    private func parseRetryAfter(_ value: String?) -> Int? {
        guard let v = value?.trimmingCharacters(in: .whitespaces), !v.isEmpty else { return nil }
        guard let n = Int(v) else { return nil }
        return max(0, n)
    }
}
