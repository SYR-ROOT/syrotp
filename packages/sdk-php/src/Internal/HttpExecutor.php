<?php

declare(strict_types=1);

namespace Syrotp\Sdk\Internal;

use GuzzleHttp\Exception\ConnectException;
use GuzzleHttp\Exception\RequestException;
use GuzzleHttp\Exception\TransferException;
use InvalidArgumentException;
use Syrotp\Sdk\Errors\SyrotpError;
use Syrotp\Sdk\Errors\SyrotpNetworkError;
use Syrotp\Sdk\Errors\SyrotpRateLimitError;
use Syrotp\Sdk\Errors\SyrotpServerError;
use Syrotp\Sdk\Errors\SyrotpTimeoutError;
use Psr\Http\Message\ResponseInterface;

/**
 * Centralizes the SDK's retry policy from `docs/sdk-generation.md` §7.
 *
 * The retry loop is intentionally written without an external retry
 * library so the policy stays auditable in one ~80-line block.
 *
 *  - Retry on: network / 5xx / 429 (with `Retry-After` honored).
 *  - Never retry on: 4xx other than 429, auth, validation, config,
 *    timeout (the caller's deadline already expired).
 *
 * @internal
 */
final class HttpExecutor
{
    public function __construct(private readonly Clock $clock)
    {
    }

    /**
     * Run `$transport` up to `$maxRetries + 1` times. On each non-final
     * attempt, retriable errors trigger a backoff sleep and another try.
     *
     * `$onResponse` parses a successful response and returns the
     * caller's final value. It MUST throw an `SyrotpError` for non-2xx,
     * which gives this loop a single failure shape to reason about.
     *
     * @template T
     * @param callable(): ResponseInterface $transport
     * @param callable(ResponseInterface): T $onResponse
     * @return T
     */
    public function executeWithRetries(callable $transport, int $maxRetries, callable $onResponse): mixed
    {
        if ($maxRetries < 0) {
            throw new InvalidArgumentException('maxRetries must be >= 0');
        }

        $lastError = null;
        for ($attempt = 0; $attempt <= $maxRetries; $attempt++) {
            try {
                $response = $transport();
            } catch (TransferException $e) {
                if (self::isTimeoutException($e)) {
                    // Per the contract: SDK does NOT auto-retry timeouts —
                    // the caller's deadline already expired.
                    $msg = $e->getMessage();
                    throw new SyrotpTimeoutError($msg !== '' ? $msg : 'request timed out');
                }
                $msg = $e->getMessage();
                $netErr = new SyrotpNetworkError(
                    'network_error',
                    $msg !== '' ? $msg : 'network error',
                    0,
                    null,
                );
                $lastError = $netErr;
                if ($attempt < $maxRetries) {
                    $this->clock->sleep(Backoff::forAttempt($attempt + 1));
                    continue;
                }
                throw $netErr;
            }

            try {
                /** @var T $value */
                $value = $onResponse($response);
                return $value;
            } catch (SyrotpError $oe) {
                $lastError = $oe;
                if ($attempt < $maxRetries && self::isRetriable($oe)) {
                    $sleep = Backoff::forAttempt($attempt + 1);
                    if ($oe instanceof SyrotpRateLimitError && $oe->retryAfterSeconds !== null) {
                        $sleep = max($sleep, (float) $oe->retryAfterSeconds);
                    }
                    $this->clock->sleep($sleep);
                    continue;
                }
                throw $oe;
            }
        }

        // Defensive: loop always returns or throws above.
        throw $lastError ?? new SyrotpNetworkError('network_error', 'retry loop fell through');
    }

    private static function isRetriable(SyrotpError $e): bool
    {
        return $e instanceof SyrotpNetworkError
            || $e instanceof SyrotpServerError
            || $e instanceof SyrotpRateLimitError;
    }

    /**
     * Detect a timeout in a Guzzle transport exception. We check the
     * curl handler's errno (28 = CURLE_OPERATION_TIMEDOUT) when
     * available, then fall back to a message substring scan so this
     * works under non-curl handlers too.
     *
     * Both `RequestException` and `ConnectException` expose
     * `getHandlerContext()` in Guzzle 7. We check `instanceof` against
     * both since their parentage shifted between Guzzle minor
     * versions and we don't want to depend on which sits where.
     */
    private static function isTimeoutException(TransferException $e): bool
    {
        $ctx = null;
        if ($e instanceof RequestException) {
            $ctx = $e->getHandlerContext();
        } elseif ($e instanceof ConnectException) {
            $ctx = $e->getHandlerContext();
        }
        if (is_array($ctx)) {
            $errno = $ctx['errno'] ?? null;
            if (is_int($errno) && $errno === 28) {
                return true;
            }
        }
        $msg = strtolower($e->getMessage());
        return str_contains($msg, 'timed out') || str_contains($msg, 'timeout');
    }
}
