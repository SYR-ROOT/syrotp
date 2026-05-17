import Foundation

/// Exponential backoff schedule with ±40% jitter, capped at 4 s.
///
/// Mirrors the schedule documented in `docs/sdk-generation.md` §7 and
/// the Python / Kotlin SDKs. Keeping the same numbers across SDKs
/// means cross-language traffic profiles look identical to the server.
enum Backoff {
    private static let scheduleSeconds: [Double] = [0.0, 0.25, 0.5, 1.0, 2.0, 4.0]
    private static let capSeconds: Double = 4.0
    private static let jitterFraction: Double = 0.4

    /// Returns the seconds to sleep before `attempt` (1-based — `attempt=0`
    /// is the initial try and never sleeps).
    static func seconds(for attempt: Int) -> TimeInterval {
        let base = scheduleSeconds[min(attempt, scheduleSeconds.count - 1)]
        if base == 0.0 { return 0.0 }
        let delta = base * jitterFraction
        let lo = max(0.0, base - delta)
        let hi = base + delta
        let raw = Double.random(in: lo...hi)
        return min(capSeconds, max(0.0, raw))
    }
}
