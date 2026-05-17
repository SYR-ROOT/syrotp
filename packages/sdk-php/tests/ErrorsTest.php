<?php

declare(strict_types=1);

namespace Syrotp\Sdk\Tests;

use Syrotp\Sdk\Errors\SyrotpAuthError;
use Syrotp\Sdk\Errors\SyrotpConfigError;
use Syrotp\Sdk\Errors\SyrotpError;
use Syrotp\Sdk\Errors\SyrotpNetworkError;
use Syrotp\Sdk\Errors\SyrotpRateLimitError;
use Syrotp\Sdk\Errors\SyrotpServerError;
use Syrotp\Sdk\Errors\SyrotpTimeoutError;
use Syrotp\Sdk\Errors\SyrotpValidationError;
use PHPUnit\Framework\TestCase;

/**
 * Error class shape and stringification.
 *
 *  1. The seven typed classes exist and are catchable as the base.
 *  2. `__toString` never leaks credentials or stack traces.
 */
final class ErrorsTest extends TestCase
{
    /** @return array<string, array{0: class-string<SyrotpError>}> */
    public static function allErrorClasses(): array
    {
        return [
            'config' => [SyrotpConfigError::class],
            'auth' => [SyrotpAuthError::class],
            'validation' => [SyrotpValidationError::class],
            'rate_limit' => [SyrotpRateLimitError::class],
            'network' => [SyrotpNetworkError::class],
            'server' => [SyrotpServerError::class],
            'timeout' => [SyrotpTimeoutError::class],
        ];
    }

    /**
     * @dataProvider allErrorClasses
     * @param class-string<SyrotpError> $cls
     */
    public function testAllSevenInheritFromBase(string $cls): void
    {
        self::assertTrue(is_subclass_of($cls, SyrotpError::class), "{$cls} must extend SyrotpError");
    }

    /**
     * @dataProvider allErrorClasses
     * @param class-string<SyrotpError> $cls
     */
    public function testEachErrorHasTheRequiredAttributes(string $cls): void
    {
        $err = match ($cls) {
            SyrotpConfigError::class => new SyrotpConfigError('x'),
            SyrotpRateLimitError::class => new SyrotpRateLimitError('rate_limited', 'slow', 429, null, 12),
            SyrotpTimeoutError::class => new SyrotpTimeoutError('timed out'),
            default => new $cls('code', 'msg', 400, 'req_1'),
        };
        self::assertIsString($err->code);
        self::assertIsString($err->getMessage());
        self::assertIsInt($err->httpStatus);
        self::assertTrue($err->requestId === null || is_string($err->requestId));
    }

    public function testRateLimitErrorCarriesRetryAfter(): void
    {
        $err = new SyrotpRateLimitError('rate_limited', 'slow', 429, null, 42);
        self::assertSame(42, $err->retryAfterSeconds);
        self::assertSame(429, $err->httpStatus);
    }

    public function testToStringIncludesCodeAndRequestId(): void
    {
        $err = new SyrotpAuthError('unauthorized', 'missing creds', 401, 'req_xyz');
        $rendered = (string) $err;
        self::assertStringContainsString('unauthorized', $rendered);
        self::assertStringContainsString('missing creds', $rendered);
        self::assertStringContainsString('req_xyz', $rendered);
    }

    public function testToStringOmitsRequestIdWhenAbsent(): void
    {
        $err = new SyrotpServerError('boom', 'internal error');
        $rendered = (string) $err;
        self::assertStringNotContainsString('request_id', $rendered);
    }

    public function testToStringDoesNotLeakStackTrace(): void
    {
        // Default `\Exception::__toString()` includes the file path and
        // a backtrace — that backtrace can stringify constructor args
        // (including the api_key). Our override returns just the
        // short, code+message form.
        $err = new SyrotpAuthError('unauthorized', 'missing creds', 401, 'req_xyz');
        $rendered = (string) $err;
        self::assertStringNotContainsString('Stack trace', $rendered);
        self::assertStringNotContainsString(__FILE__, $rendered);
    }

    public function testToStringDoesNotLeakAuthorizationKeyword(): void
    {
        $err = new SyrotpAuthError('unauthorized', 'missing creds', 401, 'req_xyz');
        $rendered = strtolower((string) $err);
        self::assertStringNotContainsString('api_key', $rendered);
        self::assertStringNotContainsString('authorization', $rendered);
    }
}
