import Foundation

/// Snapshot of the verification + countdown shown to the user on
/// each tick. Held by ``VerificationController``; the SwiftUI view
/// observes it via `@StateObject`.
public struct VerificationState: Equatable, Sendable {
    public let verification: Verification
    public let secondsLeft: Int

    public init(verification: Verification, secondsLeft: Int) {
        self.verification = verification
        self.secondsLeft = secondsLeft
    }
}

/// State machine driving the SYROTP verification lifecycle on
/// SwiftUI. Polls `${baseUrl}/v/:id/status` (the public,
/// IP-rate-limited endpoint shipped in SYROTP server v0.5.0), runs
/// a 1Hz countdown, and republishes `state` on every visible
/// change. The view layer binds via `@StateObject` and observes
/// `state` through SwiftUI's `@Published`.
///
/// Lifecycle: call ``start()`` once (typically from the view's
/// `.onAppear`), then ``stop()`` from `.onDisappear`. Calling
/// `start` a second time is a no-op.
///
/// Pinned to `@MainActor` so all state mutations and callback
/// invocations happen on the main thread — same thread SwiftUI
/// reads `state` from.
@MainActor
public final class VerificationController: ObservableObject {
    @Published public private(set) var state: VerificationState

    private let baseUrl: URL
    private let pollInterval: TimeInterval
    private let urlSession: URLSession
    private let onVerified: (Verification) -> Void
    private let onExpired: (Verification) -> Void
    private let onCancelled: (Verification) -> Void
    private let onError: (Error) -> Void
    private let now: () -> Date

    private var pollTask: Task<Void, Never>?
    private var countdownTask: Task<Void, Never>?
    private var prevStatus: VerificationStatus
    private var started: Bool = false
    private var stopped: Bool = false

    public init(
        baseUrl: URL,
        initial: Verification,
        pollInterval: TimeInterval = 2.5,
        urlSession: URLSession = .shared,
        onVerified: @escaping (Verification) -> Void = { _ in },
        onExpired: @escaping (Verification) -> Void = { _ in },
        onCancelled: @escaping (Verification) -> Void = { _ in },
        onError: @escaping (Error) -> Void = { _ in },
        now: @escaping () -> Date = { Date() }
    ) {
        self.baseUrl = baseUrl
        self.pollInterval = pollInterval
        self.urlSession = urlSession
        self.onVerified = onVerified
        self.onExpired = onExpired
        self.onCancelled = onCancelled
        self.onError = onError
        self.now = now
        self.prevStatus = initial.status
        self.state = VerificationState(
            verification: initial,
            secondsLeft: Self.secondsLeft(expiresAt: initial.expiresAt, now: now())
        )
    }

    public func start() {
        guard !started, !stopped else { return }
        started = true
        guard !state.verification.status.isTerminal else { return }
        countdownTask = Task { [weak self] in
            await self?.runCountdown()
        }
        pollTask = Task { [weak self] in
            await self?.runPolling()
        }
    }

    public func stop() {
        stopped = true
        pollTask?.cancel()
        countdownTask?.cancel()
        pollTask = nil
        countdownTask = nil
    }

    private func runCountdown() async {
        while !Task.isCancelled, !stopped {
            let v = state.verification
            if v.status.isTerminal { return }
            let secs = Self.secondsLeft(expiresAt: v.expiresAt, now: now())
            if secs <= 0 {
                transition(
                    next: v.transition(status: .expired, expiresAt: v.expiresAt)
                )
                return
            }
            if secs != state.secondsLeft {
                state = VerificationState(verification: v, secondsLeft: secs)
            }
            do {
                try await Task.sleep(nanoseconds: 1_000_000_000)
            } catch {
                return
            }
        }
    }

    private func runPolling() async {
        // Fire one immediate poll so a fast-completing verification
        // surfaces without waiting a full interval.
        await pollOnce()
        while !Task.isCancelled, !stopped, !state.verification.status.isTerminal {
            do {
                try await Task.sleep(nanoseconds: UInt64(pollInterval * 1_000_000_000))
            } catch {
                return
            }
            if Task.isCancelled || stopped { return }
            await pollOnce()
        }
    }

    private func pollOnce() async {
        guard !stopped else { return }
        let v = state.verification
        guard !v.status.isTerminal else { return }
        let url = baseUrl.appendingPathComponent("v/\(v.id)/status")
        var request = URLRequest(url: url)
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        do {
            let (data, response) = try await urlSession.data(for: request)
            if stopped { return }
            guard let http = response as? HTTPURLResponse,
                  (200..<300).contains(http.statusCode) else {
                throw URLError(.badServerResponse)
            }
            let decoder = JSONDecoder()
            decoder.dateDecodingStrategy = .custom(Self.decodeDate)
            let body = try decoder.decode(StatusResponse.self, from: data)
            let current = state.verification
            if body.status == current.status {
                if body.expiresAt != current.expiresAt {
                    let updated = current.withExpiresAt(body.expiresAt)
                    state = VerificationState(
                        verification: updated,
                        secondsLeft: Self.secondsLeft(expiresAt: updated.expiresAt, now: now())
                    )
                }
                return
            }
            transition(next: current.transition(
                status: body.status,
                expiresAt: body.expiresAt,
                verifiedAt: body.verifiedAt
            ))
        } catch let error as URLError where error.code == .cancelled {
            return
        } catch {
            if stopped { return }
            onError(error)
        }
    }

    private func transition(next: Verification) {
        let prev = prevStatus
        prevStatus = next.status
        state = VerificationState(
            verification: next,
            secondsLeft: Self.secondsLeft(expiresAt: next.expiresAt, now: now())
        )
        if prev != next.status, prev == .pending {
            switch next.status {
            case .verified:
                onVerified(next)
            case .expired:
                onExpired(next)
            case .cancelled:
                onCancelled(next)
            case .pending, .failed:
                break
            }
        }
        if next.status.isTerminal {
            pollTask?.cancel()
            countdownTask?.cancel()
            pollTask = nil
            countdownTask = nil
        }
    }

    static func secondsLeft(expiresAt: Date, now: Date) -> Int {
        let diff = Int(expiresAt.timeIntervalSince(now))
        return max(0, diff)
    }

    /// Decode an ISO-8601 string with or without fractional seconds —
    /// the SYROTP server emits timestamps via `Date.toISOString()` (fractional)
    /// for fresh records and via Postgres `to_char` (no fractional) for some
    /// older paths. Be permissive on read.
    private static func decodeDate(decoder: Decoder) throws -> Date {
        let container = try decoder.singleValueContainer()
        let raw = try container.decode(String.self)
        let withFrac = ISO8601DateFormatter()
        withFrac.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = withFrac.date(from: raw) { return date }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        if let date = plain.date(from: raw) { return date }
        throw DecodingError.dataCorrupted(
            DecodingError.Context(
                codingPath: decoder.codingPath,
                debugDescription: "invalid ISO 8601 date: \(raw)"
            )
        )
    }

    private struct StatusResponse: Decodable {
        let status: VerificationStatus
        let expiresAt: Date
        let verifiedAt: Date?

        enum CodingKeys: String, CodingKey {
            case status
            case expiresAt = "expires_at"
            case verifiedAt = "verified_at"
        }
    }
}
