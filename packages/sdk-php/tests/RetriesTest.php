<?php

declare(strict_types=1);

namespace Syrotp\Sdk\Tests;

use GuzzleHttp\Exception\ConnectException;
use GuzzleHttp\Psr7\Request;
use GuzzleHttp\Psr7\Response;
use Syrotp\Sdk\Errors\SyrotpAuthError;
use Syrotp\Sdk\Errors\SyrotpServerError;
use Syrotp\Sdk\Errors\SyrotpValidationError;
use Syrotp\Sdk\Tests\Support\FakeClock;
use Syrotp\Sdk\Tests\Support\Fixtures;
use PHPUnit\Framework\TestCase;

/**
 * Retry policy tests. Pins the rules from `docs/sdk-generation.md` §7:
 *   - Retry on: network / 5xx / 429 (with `Retry-After` honored)
 *   - Never retry on: 4xx (except 429), validation, auth, config, timeout
 */
final class RetriesTest extends TestCase
{
    // ----- retries actually happen -----------------------------------------

    public function testFiveHundredIsRetriedUntilSuccess(): void
    {
        $clock = new FakeClock();
        $okBody = json_encode(Fixtures::verificationPayload(['id' => 'vrf_1', 'status' => 'verified']));

        $client = Fixtures::makeClient(
            queue: [
                new Response(503, [], json_encode(['error' => ['code' => 'down', 'message' => 'no']])),
                new Response(503, [], json_encode(['error' => ['code' => 'down', 'message' => 'no']])),
                new Response(200, [], $okBody),
            ],
            retries: 3,
            clock: $clock,
        );
        $v = $client->getVerification('vrf_1');
        self::assertSame('vrf_1', $v->id);
        // Two retries → two sleeps recorded.
        self::assertCount(2, $clock->sleeps);
    }

    public function testFiveHundredEventuallyRaisesAfterBudgetExhausted(): void
    {
        $clock = new FakeClock();
        $errBody = json_encode(['error' => ['code' => 'down', 'message' => 'no']]);

        $client = Fixtures::makeClient(
            queue: [
                new Response(503, [], $errBody),
                new Response(503, [], $errBody),
                new Response(503, [], $errBody),
            ],
            retries: 2,
            clock: $clock,
        );

        try {
            $client->getVerification('vrf_1');
            self::fail('expected SyrotpServerError');
        } catch (SyrotpServerError $e) {
            // 1 initial + 2 retries = 3 attempts → 2 sleeps (between attempts).
            self::assertCount(2, $clock->sleeps);
            self::assertSame(503, $e->httpStatus);
        }
    }

    public function testFourHundredTwentyNineRespectsRetryAfter(): void
    {
        $clock = new FakeClock();
        $okBody = json_encode(Fixtures::verificationPayload(['status' => 'pending']));

        $client = Fixtures::makeClient(
            queue: [
                new Response(429, ['Retry-After' => '7'], json_encode(['error' => ['code' => 'rate_limited', 'message' => 'slow']])),
                new Response(200, [], $okBody),
            ],
            retries: 2,
            clock: $clock,
        );
        $client->getVerification('vrf_1');

        self::assertNotEmpty($clock->sleeps);
        $sawAtLeast7 = false;
        foreach ($clock->sleeps as $s) {
            if ($s >= 7.0) {
                $sawAtLeast7 = true;
                break;
            }
        }
        self::assertTrue($sawAtLeast7, 'expected a sleep >= 7s honoring Retry-After');
    }

    public function testNetworkErrorIsRetried(): void
    {
        $clock = new FakeClock();
        $req = new Request('GET', 'http://syrotp.test/v1/verifications/vrf_1');
        $okBody = json_encode(Fixtures::verificationPayload(['id' => 'vrf_1', 'status' => 'verified']));

        $client = Fixtures::makeClient(
            queue: [
                new ConnectException('simulated network error', $req),
                new ConnectException('simulated network error', $req),
                new Response(200, [], $okBody),
            ],
            retries: 3,
            clock: $clock,
        );
        $v = $client->getVerification('vrf_1');
        self::assertSame('vrf_1', $v->id);
        self::assertCount(2, $clock->sleeps);
    }

    // ----- retries DO NOT happen -------------------------------------------

    public function testFourHundredIsNotRetried(): void
    {
        $clock = new FakeClock();
        $body = json_encode(['error' => ['code' => 'validation_error', 'message' => 'bad']]);

        $client = Fixtures::makeClient(
            queue: [new Response(400, [], $body)],
            retries: 5,
            clock: $clock,
        );

        $this->expectException(SyrotpValidationError::class);
        try {
            $client->getVerification('vrf_1');
        } finally {
            // No retries fired → no sleep calls.
            self::assertSame([], $clock->sleeps);
        }
    }

    public function testFourHundredOneIsNotRetried(): void
    {
        $clock = new FakeClock();
        $body = json_encode(['error' => ['code' => 'unauthorized', 'message' => 'no']]);

        $client = Fixtures::makeClient(
            queue: [new Response(401, [], $body)],
            retries: 5,
            clock: $clock,
        );

        $this->expectException(SyrotpAuthError::class);
        try {
            $client->getVerification('vrf_1');
        } finally {
            self::assertSame([], $clock->sleeps);
        }
    }

    public function testZeroRetriesMeansOneAttempt(): void
    {
        $clock = new FakeClock();
        $body = json_encode(['error' => ['code' => 'down', 'message' => 'no']]);

        $client = Fixtures::makeClient(
            queue: [new Response(503, [], $body)],
            retries: 0,
            clock: $clock,
        );

        $this->expectException(SyrotpServerError::class);
        try {
            $client->getVerification('vrf_1');
        } finally {
            self::assertSame([], $clock->sleeps);
        }
    }

    public function testRetryAfterPresentButUnparseable(): void
    {
        $clock = new FakeClock();
        $okBody = json_encode(Fixtures::verificationPayload(['id' => 'vrf_1', 'status' => 'pending']));

        $client = Fixtures::makeClient(
            queue: [
                new Response(429, ['Retry-After' => 'not-a-number'], json_encode(['error' => ['code' => 'rate_limited', 'message' => 'slow']])),
                new Response(200, [], $okBody),
            ],
            retries: 2,
            clock: $clock,
        );
        $v = $client->getVerification('vrf_1');
        self::assertSame('vrf_1', $v->id);
        // We still slept on the normal backoff schedule.
        self::assertNotEmpty($clock->sleeps);
    }

    // ----- cancel retry cap ------------------------------------------------

    public function testCancelDoesNotStormRetries(): void
    {
        $clock = new FakeClock();
        $body = json_encode(['error' => ['code' => 'down', 'message' => 'no']]);

        // 1 initial + 1 retry = 2 attempts max for cancel even with retries=10.
        $client = Fixtures::makeClient(
            queue: [
                new Response(503, [], $body),
                new Response(503, [], $body),
                new Response(503, [], $body),
                new Response(503, [], $body),
            ],
            retries: 10,
            clock: $clock,
        );

        $this->expectException(SyrotpServerError::class);
        try {
            $client->cancelVerification('vrf_01HX');
        } finally {
            // 2 attempts total → exactly 1 sleep between them.
            self::assertCount(1, $clock->sleeps);
        }
    }
}
