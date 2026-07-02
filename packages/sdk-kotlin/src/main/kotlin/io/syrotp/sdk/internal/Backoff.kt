package io.syrotp.sdk.internal

import kotlin.random.Random

/**
 * Exponential backoff schedule with ±40% jitter, capped at 4 s.
 *
 * Mirrors the schedule documented in `docs/sdk-generation.md` §7 and
 * the Python SDK in `packages/sdk-python/syrotp/_http.py`. Keeping the
 * same numbers across SDKs means cross-language traffic profiles look
 * the same to the server.
 */
internal object Backoff {
    private val SCHEDULE_SECONDS = doubleArrayOf(0.0, 0.25, 0.5, 1.0, 2.0, 4.0)
    private const val CAP_SECONDS = 4.0
    private const val JITTER_FRACTION = 0.4

    /**
     * Returns the seconds to sleep before [attempt] (1-based — `attempt=0`
     * is the initial try and never sleeps).
     */
    internal fun seconds(attempt: Int, random: Random = Random.Default): Double {
        val base = SCHEDULE_SECONDS[minOf(attempt, SCHEDULE_SECONDS.size - 1)]
        if (base == 0.0) return 0.0
        val delta = base * JITTER_FRACTION
        val raw = random.nextDouble(base - delta, base + delta)
        return raw.coerceIn(0.0, CAP_SECONDS)
    }
}
