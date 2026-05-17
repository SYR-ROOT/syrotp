<?php

declare(strict_types=1);

namespace Syrotp\Sdk\Internal;

/**
 * Clock seam used by the retry loop and `waitForVerification`.
 *
 * The default implementation is {@see SystemClock}. Tests inject a
 * fake clock to make backoff sleeps and wait-deadline expiration
 * deterministic without actually waiting.
 *
 * @internal
 */
interface Clock
{
    /** Monotonic-ish wall time in seconds (microsecond precision). */
    public function now(): float;

    /** Block for `$seconds` seconds; no-op if `$seconds <= 0`. */
    public function sleep(float $seconds): void;
}
