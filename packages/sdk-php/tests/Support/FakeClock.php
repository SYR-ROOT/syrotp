<?php

declare(strict_types=1);

namespace Syrotp\Sdk\Tests\Support;

use Syrotp\Sdk\Internal\Clock;

/**
 * Test fake for `Clock`. Recorded `sleep()` calls advance the clock
 * forward without actually waiting, so deadline-based code under test
 * runs in microseconds.
 */
final class FakeClock implements Clock
{
    public float $time = 0.0;

    /** @var list<float> */
    public array $sleeps = [];

    public function now(): float
    {
        return $this->time;
    }

    public function sleep(float $seconds): void
    {
        $this->sleeps[] = $seconds;
        if ($seconds > 0) {
            $this->time += $seconds;
        }
    }
}
