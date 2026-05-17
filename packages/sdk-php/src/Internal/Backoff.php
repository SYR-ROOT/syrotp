<?php

declare(strict_types=1);

namespace Syrotp\Sdk\Internal;

/**
 * Backoff schedule from `docs/sdk-generation.md` §7.
 *
 * Numbers are identical across every official SDK
 * (Python / Kotlin / Swift / PHP):
 *
 *   - Base seconds: (0.0, 0.25, 0.5, 1.0, 2.0, 4.0)
 *   - ±40% multiplicative jitter
 *   - Capped at 4.0s
 *
 * @internal
 */
final class Backoff
{
    /** @var list<float> */
    public const BASE_SECONDS = [0.0, 0.25, 0.5, 1.0, 2.0, 4.0];

    public const CAP_SECONDS = 4.0;

    public const JITTER_FRACTION = 0.4;

    /**
     * Returns the seconds to sleep before retry attempt number
     * `$attempt` (1-indexed; attempt 0 = the initial try, never sleeps
     * before it).
     */
    public static function forAttempt(int $attempt): float
    {
        $idx = max(0, min($attempt, count(self::BASE_SECONDS) - 1));
        $base = self::BASE_SECONDS[$idx];
        if ($base === 0.0) {
            return 0.0;
        }
        $delta = $base * self::JITTER_FRACTION;
        $low = max(0.0, $base - $delta);
        $high = $base + $delta;
        $rand = self::randomFloat($low, $high);
        return min(self::CAP_SECONDS, $rand);
    }

    /** Uniform random float in `[$low, $high]`. */
    private static function randomFloat(float $low, float $high): float
    {
        if ($high <= $low) {
            return $low;
        }
        $r = mt_rand() / mt_getrandmax();
        return $low + $r * ($high - $low);
    }
}
