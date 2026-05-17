<?php

declare(strict_types=1);

namespace Syrotp\Sdk\Internal;

/**
 * Real wall-clock + `usleep` clock. The default outside of tests.
 *
 * @internal
 */
final class SystemClock implements Clock
{
    public function now(): float
    {
        return microtime(true);
    }

    public function sleep(float $seconds): void
    {
        if ($seconds > 0) {
            usleep((int) ($seconds * 1_000_000));
        }
    }
}
