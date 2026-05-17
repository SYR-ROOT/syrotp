import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
#if canImport(os)
import os
#endif

/// Async SYROTP client.
///
/// Conforms to `docs/sdk-contract.md`. Uses Swift Concurrency
/// (`async/await` + `Task`) — caller cancellation propagates as
/// `CancellationError` per `sdk-contract.md` §7.
///
/// ```swift
/// let client = try SyrotpClient(
///     baseURL: URL(string: "https://otp.example.com")!,
///     apiKey: "sk_live_..."
/// )
/// let v = try await client.startVerification(phone: "+963991234567", purpose: "login")
/// print("Send '\(v.message ?? "")' to \(v.sendTo ?? "")")
/// ```
///
/// All public methods are `async throws` and respect Swift's structured
/// concurrency cancellation. There is no separate close()/teardown —
/// the underlying URLSession is owned by the client and released when
/// the client is deallocated.
public final class SyrotpClient: @unchecked Sendable {

    // ---- public configuration --------------------------------------------

    public let baseURL: URL
    public let timeoutSeconds: TimeInterval
    public let retries: Int
    public let userAgent: String

    // ---- internals --------------------------------------------------------

    private let apiKey: String
    private let session: URLSession
    private let executor: HttpExecutor
    private let logHandler: @Sendable (String) -> Void

    public static let version = "0.1.0"
    public static let defaultTimeoutSeconds: TimeInterval = 15.0
    public static let defaultRetries: Int = 2
    public static let defaultWaitIntervalSeconds: TimeInterval = 2.5
    public static let defaultWaitTimeoutSeconds: TimeInterval = 5 * 60.0
    public static let minWaitIntervalSeconds: TimeInterval = 2.0

    /// Designated initializer.
    ///
    /// Throws `SyrotpConfigError` when any input is invalid (missing,
    /// out of range, wrong scheme).
    ///
    /// - Parameters:
    ///   - baseURL: HTTP(S) URL of the SYROTP server. Trailing slash
    ///     optional — the SDK strips it.
    ///   - apiKey: `pk_live_...` or `sk_live_...`. Sent as
    ///     `Authorization: Bearer <apiKey>`.
    ///   - timeoutSeconds: Per-request deadline. NEVER infinite.
    ///   - retries: Max retries for retriable failures. `0` = no retry.
    ///   - userAgent: Optional suffix appended to `syrotp-sdk-swift/<version>`.
    ///   - session: Inject a custom URLSession (e.g. one configured
    ///     with a `MockURLProtocol`) for tests. When `nil`, a session
    ///     is built with the configured timeout.
    ///   - logHandler: Optional sink for SDK-internal warnings (e.g.
    ///     the cleartext-on-public-host one). Defaults to writing to
    ///     stderr / `os.Logger`. Tests inject a buffer-collecting
    ///     handler to assert what was (and wasn't) logged.
    public init(
        baseURL: URL,
        apiKey: String,
        timeoutSeconds: TimeInterval = SyrotpClient.defaultTimeoutSeconds,
        retries: Int = SyrotpClient.defaultRetries,
        userAgent: String? = nil,
        session: URLSession? = nil,
        logHandler: (@Sendable (String) -> Void)? = nil
    ) throws {
        try SyrotpClient.validate(
            baseURL: baseURL,
            apiKey: apiKey,
            timeoutSeconds: timeoutSeconds,
            retries: retries
        )

        // Strip a single trailing slash so callers can pass either form.
        var stripped = baseURL.absoluteString
        if stripped.hasSuffix("/") { stripped.removeLast() }
        self.baseURL = URL(string: stripped) ?? baseURL

        self.apiKey = apiKey
        self.timeoutSeconds = timeoutSeconds
        self.retries = retries
        self.userAgent = SyrotpClient.buildUserAgent(suffix: userAgent)

        if let session = session {
            self.session = session
        } else {
            let cfg = URLSessionConfiguration.ephemeral
            cfg.timeoutIntervalForRequest = timeoutSeconds
            cfg.timeoutIntervalForResource = timeoutSeconds
            cfg.httpCookieStorage = nil
            cfg.urlCache = nil
            self.session = URLSession(configuration: cfg)
        }
        self.executor = HttpExecutor(maxRetries: retries)
        self.logHandler = logHandler ?? SyrotpClient.defaultLogHandler

        // Cleartext-to-public-host warning. RFC1918 / loopback is silent
        // (dev paths). See docs/sdk-generation.md §5.
        if let scheme = baseURL.scheme?.lowercased(),
           scheme == "http",
           let host = baseURL.host,
           !SyrotpClient.isLoopbackOrPrivate(host: host) {
            self.logHandler("syrotp-sdk: baseURL is plain HTTP to a non-private host (\(host)); use https:// in production")
        }
    }

    /// Internal initializer used by tests to inject a custom Sleeper
    /// alongside a custom URLSession.
    init(
        baseURL: URL,
        apiKey: String,
        timeoutSeconds: TimeInterval,
        retries: Int,
        userAgent: String?,
        session: URLSession,
        sleeper: @escaping @Sendable (TimeInterval) async -> Void,
        logHandler: (@Sendable (String) -> Void)? = nil
    ) throws {
        try SyrotpClient.validate(
            baseURL: baseURL,
            apiKey: apiKey,
            timeoutSeconds: timeoutSeconds,
            retries: retries
        )
        var stripped = baseURL.absoluteString
        if stripped.hasSuffix("/") { stripped.removeLast() }
        self.baseURL = URL(string: stripped) ?? baseURL
        self.apiKey = apiKey
        self.timeoutSeconds = timeoutSeconds
        self.retries = retries
        self.userAgent = SyrotpClient.buildUserAgent(suffix: userAgent)
        self.session = session
        self.executor = HttpExecutor(maxRetries: retries, sleeper: sleeper)
        self.logHandler = logHandler ?? SyrotpClient.defaultLogHandler
    }

    // ---- public API -------------------------------------------------------

    public func startVerification(
        phone: String,
        purpose: String,
        clientRef: String? = nil,
        locale: String? = nil
    ) async throws -> Verification {
        if phone.isEmpty {
            throw SyrotpValidationError(code: "validation_error", message: "phone is required")
        }
        if purpose.isEmpty {
            throw SyrotpValidationError(code: "validation_error", message: "purpose is required")
        }
        var body: [String: Any] = ["phone": phone, "purpose": purpose]
        if let c = clientRef { body["client_ref"] = c }
        if let l = locale { body["locale"] = l }
        let obj = try await request(method: "POST", path: "/v1/verifications", body: body, executor: executor)
        return try Verification.from(jsonObject: obj)
    }

    public func getVerification(_ verificationId: String) async throws -> Verification {
        try SyrotpClient.validateVerificationId(verificationId)
        let obj = try await request(method: "GET", path: "/v1/verifications/\(verificationId)", body: nil, executor: executor)
        return try Verification.from(jsonObject: obj)
    }

    /// The server is naturally idempotent here, but a runaway retry
    /// loop is still observable in audit logs — so this method's
    /// retry budget is capped at 1 regardless of the client's
    /// `retries` setting (see `docs/sdk-generation.md` §7).
    public func cancelVerification(_ verificationId: String) async throws -> Verification {
        try SyrotpClient.validateVerificationId(verificationId)
        let capped = HttpExecutor(maxRetries: min(retries, 1))
        let obj = try await request(
            method: "POST",
            path: "/v1/verifications/\(verificationId)/cancel",
            body: nil,
            executor: capped
        )
        return try Verification.from(jsonObject: obj)
    }

    public func waitForVerification(
        _ verificationId: String,
        intervalSeconds: TimeInterval = SyrotpClient.defaultWaitIntervalSeconds,
        timeoutSeconds: TimeInterval = SyrotpClient.defaultWaitTimeoutSeconds
    ) async throws -> Verification {
        if timeoutSeconds <= 0 {
            throw SyrotpConfigError("wait timeoutSeconds must be positive")
        }
        // Floor the interval at 2 s — the server enforces a per-IP
        // read rate limit, so polling faster only triggers 429s.
        let effectiveInterval = max(SyrotpClient.minWaitIntervalSeconds, intervalSeconds)
        let deadline = Date().addingTimeInterval(timeoutSeconds)

        while true {
            try Task.checkCancellation()
            let v = try await getVerification(verificationId)
            if v.status != .pending { return v }
            let now = Date()
            if now >= deadline {
                throw SyrotpTimeoutError(message: "waitForVerification deadline expired")
            }
            let remaining = deadline.timeIntervalSince(now)
            let sleep = min(effectiveInterval, max(0, remaining))
            try await Task.sleep(nanoseconds: UInt64(sleep * 1_000_000_000))
        }
    }

    // ---- internals --------------------------------------------------------

    private func request(
        method: String,
        path: String,
        body: [String: Any]?,
        executor: HttpExecutor
    ) async throws -> [String: Any] {
        let url = baseURL.appendingPathComponent(path.hasPrefix("/") ? String(path.dropFirst()) : path)
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        req.setValue(userAgent, forHTTPHeaderField: "User-Agent")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body = body {
            let bytes = try JSONSerialization.data(withJSONObject: body)
            req.httpBody = bytes
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        } else if method == "POST" {
            // Some endpoints (cancel) take no body; still send {} so
            // server-side validators don't choke on missing Content-Type.
            req.httpBody = Data("{}".utf8)
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        req.timeoutInterval = timeoutSeconds

        let session = self.session
        return try await executor.execute(
            transport: { [req] in
                let (data, response) = try await session.syrotpData(for: req)
                guard let http = response as? HTTPURLResponse else {
                    throw SyrotpError(code: "bad_response", message: "non-HTTP response")
                }
                return (data, http)
            },
            parse: { data, response in
                guard !data.isEmpty else {
                    throw SyrotpError(
                        code: "bad_response",
                        message: "empty response body (status \(response.statusCode))",
                        httpStatus: response.statusCode
                    )
                }
                guard let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                    throw SyrotpError(
                        code: "bad_response",
                        message: "unexpected JSON shape (status \(response.statusCode))",
                        httpStatus: response.statusCode
                    )
                }
                return parsed
            }
        )
    }

    // ---- statics ----------------------------------------------------------

    static func validate(
        baseURL: URL,
        apiKey: String,
        timeoutSeconds: TimeInterval,
        retries: Int
    ) throws {
        if let scheme = baseURL.scheme?.lowercased(), scheme != "http", scheme != "https" {
            throw SyrotpConfigError("baseURL must be an http(s) URL")
        }
        if baseURL.scheme == nil {
            throw SyrotpConfigError("baseURL must be an http(s) URL")
        }
        if baseURL.host == nil || baseURL.host!.isEmpty {
            throw SyrotpConfigError("baseURL must include a host")
        }
        if apiKey.isEmpty {
            throw SyrotpConfigError("apiKey is required")
        }
        if timeoutSeconds <= 0 {
            throw SyrotpConfigError("timeoutSeconds must be positive")
        }
        if retries < 0 {
            throw SyrotpConfigError("retries must be non-negative")
        }
    }

    static func validateVerificationId(_ id: String) throws {
        let pattern = #"^vrf_[A-Za-z0-9]+$"#
        if id.range(of: pattern, options: .regularExpression) == nil {
            throw SyrotpValidationError(
                code: "validation_error",
                message: "verificationId must match ^vrf_[A-Za-z0-9]+$"
            )
        }
    }

    static func buildUserAgent(suffix: String?) -> String {
        let base = "syrotp-sdk-swift/\(version)"
        guard let s = suffix, !s.isEmpty else { return base }
        // Strip CR/LF/NUL so caller-supplied suffixes can't inject
        // an extra header line.
        let clean = s
            .replacingOccurrences(of: "\r", with: "")
            .replacingOccurrences(of: "\n", with: "")
            .replacingOccurrences(of: "\0", with: "")
            .trimmingCharacters(in: .whitespaces)
        return clean.isEmpty ? base : "\(base) \(clean)"
    }

    static func isLoopbackOrPrivate(host: String) -> Bool {
        let h = host.lowercased()
        if h == "localhost" || h == "127.0.0.1" || h == "::1" { return true }
        if h.hasPrefix("10.") || h.hasPrefix("192.168.") || h.hasPrefix("169.254.") {
            return true
        }
        if h.hasPrefix("172.") {
            let parts = h.split(separator: ".")
            if parts.count >= 2, let second = Int(parts[1]), (16...31).contains(second) {
                return true
            }
        }
        return false
    }

    /// Default log sink: writes warnings to `os.Logger` on Apple
    /// platforms, stderr elsewhere. Tests inject a buffer-collecting
    /// handler instead so they can scan what was emitted.
    static let defaultLogHandler: @Sendable (String) -> Void = { message in
        #if canImport(os)
        Logger(subsystem: "io.syrotp.sdk", category: "client").warning("\(message, privacy: .public)")
        #else
        FileHandle.standardError.write(Data((message + "\n").utf8))
        #endif
    }
}
