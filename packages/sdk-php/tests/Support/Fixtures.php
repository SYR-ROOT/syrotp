<?php

declare(strict_types=1);

namespace Syrotp\Sdk\Tests\Support;

use GuzzleHttp\Handler\MockHandler;
use GuzzleHttp\HandlerStack;
use GuzzleHttp\Middleware;
use Syrotp\Sdk\SyrotpClient;
use Psr\Log\LoggerInterface;

/**
 * Shared helpers used across all PHPUnit suites: a canonical
 * `Verification` payload, plus a Guzzle MockHandler / HandlerStack /
 * history container wired together so each test can focus on what it
 * actually wants to assert.
 */
final class Fixtures
{
    /**
     * @param array<string,mixed> $overrides
     * @return array<string,mixed>
     */
    public static function verificationPayload(array $overrides = []): array
    {
        return array_replace([
            'id' => 'vrf_01HX',
            'status' => 'pending',
            'phone_masked' => '+96399****567',
            'send_to' => '+963998887777',
            'message' => 'VERIFY ABC123',
            'purpose' => 'login',
            'expires_at' => '2026-05-02T18:00:00.000Z',
            'created_at' => '2026-05-02T17:00:00.000Z',
        ], $overrides);
    }

    /**
     * Build a `MockHandler` + `HandlerStack` + history container.
     *
     * @param list<mixed> $queue items the MockHandler will return in order
     * @param list<array{request:\Psr\Http\Message\RequestInterface, response:\Psr\Http\Message\ResponseInterface|null, error:\Throwable|null, options:array<string,mixed>}> $history populated by reference
     * @return array{0: MockHandler, 1: HandlerStack}
     */
    public static function mockStack(array $queue, array &$history = []): array
    {
        $mock = new MockHandler($queue);
        $stack = HandlerStack::create($mock);
        $stack->push(Middleware::history($history));
        return [$mock, $stack];
    }

    /**
     * @param list<mixed> $queue
     * @param list<array{request:\Psr\Http\Message\RequestInterface, response:\Psr\Http\Message\ResponseInterface|null, error:\Throwable|null, options:array<string,mixed>}> $history
     */
    public static function makeClient(
        array $queue,
        array &$history = [],
        string $apiKey = 'sk_live_TESTKEY_DO_NOT_USE',
        int $retries = 0,
        ?LoggerInterface $logger = null,
        ?FakeClock $clock = null,
        string $baseUrl = 'http://syrotp.test',
    ): SyrotpClient {
        [, $stack] = self::mockStack($queue, $history);
        return new SyrotpClient(
            baseUrl: $baseUrl,
            apiKey: $apiKey,
            retries: $retries,
            handlerStack: $stack,
            logger: $logger,
            clock: $clock,
        );
    }
}
