<?php

declare(strict_types=1);

namespace Syrotp\Sdk\Tests;

use GuzzleHttp\Psr7\Response;
use Syrotp\Sdk\Errors\SyrotpAuthError;
use Syrotp\Sdk\SyrotpClient;
use Syrotp\Sdk\Tests\Support\Fixtures;
use Syrotp\Sdk\Tests\Support\RecordingLogger;
use PHPUnit\Framework\TestCase;

/**
 * Security canary tests. Pin the rules from `docs/sdk-generation.md` §5:
 *
 *   - Never log the API key.
 *   - Never log the request body (which includes the user's phone).
 *   - Never embed credentials in error stringification.
 *
 * These tests use stable canary values that, if they ever appear in
 * captured logs or error renderings, prove a regression.
 */
final class SecurityTest extends TestCase
{
    /** Sentinel chosen to be unmistakable if it ever leaks. */
    private const CANARY_API_KEY = 'sk_live_TESTSENTINEL_DO_NOT_LOG_THIS';
    private const CANARY_PHONE = '+99999999999999';

    // ----- API key MUST NOT appear in error strings ------------------------

    public function testAuthErrorStringDoesNotContainApiKey(): void
    {
        $err = new SyrotpAuthError('unauthorized', 'missing creds', 401);
        self::assertStringNotContainsString(self::CANARY_API_KEY, (string) $err);
    }

    public function testClientDoesNotDefineToStringThatCouldLeakApiKey(): void
    {
        // The SDK deliberately does NOT define a `__toString` on
        // `SyrotpClient`. If a future change adds one it MUST NOT
        // include the api_key — this canary would catch a regression.
        // (`print_r` / `var_dump` will still dump private properties;
        // those are debug tools and should not be wired into log
        // pipelines.)
        self::assertFalse(
            method_exists(SyrotpClient::class, '__toString'),
            'SyrotpClient should not define __toString — risk of leaking apiKey',
        );
    }

    // ----- request body MUST NOT be logged ---------------------------------

    public function testPhoneDoesNotAppearInLoggerOutput(): void
    {
        $logger = new RecordingLogger();
        $client = Fixtures::makeClient(
            queue: [new Response(201, [], json_encode(Fixtures::verificationPayload()))],
            apiKey: self::CANARY_API_KEY,
            logger: $logger,
        );
        $client->startVerification(phone: self::CANARY_PHONE, purpose: 'login');

        foreach ($logger->rendered() as $line) {
            self::assertStringNotContainsString(
                self::CANARY_PHONE,
                $line,
                "the user's phone MUST NOT appear in any syrotp log line; saw: {$line}",
            );
            self::assertStringNotContainsString(
                self::CANARY_API_KEY,
                $line,
                "the api_key MUST NOT appear in any syrotp log line; saw: {$line}",
            );
        }
    }

    // ----- cleartext warning behavior --------------------------------------

    public function testCleartextToPublicHostLogsWarning(): void
    {
        $logger = new RecordingLogger();
        new SyrotpClient(
            baseUrl: 'http://otp.example.com',
            apiKey: 'sk_live_x',
            logger: $logger,
        );
        $matching = array_filter(
            $logger->records,
            static fn (array $r): bool => str_contains($r['rendered'], 'plain HTTP'),
        );
        self::assertNotEmpty($matching, 'expected a plain-HTTP warning for a public host');
    }

    /**
     * @dataProvider privateHosts
     */
    public function testPrivateOrLoopbackHostsDoNotWarn(string $baseUrl): void
    {
        $logger = new RecordingLogger();
        new SyrotpClient(
            baseUrl: $baseUrl,
            apiKey: 'sk_live_x',
            logger: $logger,
        );
        $cleartextWarnings = array_filter(
            $logger->records,
            static fn (array $r): bool => str_contains($r['rendered'], 'plain HTTP'),
        );
        self::assertSame([], $cleartextWarnings, 'private/loopback host should not trigger plain-HTTP warning');
    }

    /** @return array<string, array{0: string}> */
    public static function privateHosts(): array
    {
        return [
            'localhost' => ['http://localhost:3000'],
            'loopback v4' => ['http://127.0.0.1:3000'],
            'rfc1918 10.x' => ['http://10.0.0.1'],
            'rfc1918 192.168.x' => ['http://192.168.1.1'],
            'rfc1918 172.16.x' => ['http://172.16.0.1'],
            'link-local 169.254' => ['http://169.254.1.1'],
        ];
    }
}
