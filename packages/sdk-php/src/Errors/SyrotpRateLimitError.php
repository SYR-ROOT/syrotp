<?php

declare(strict_types=1);

namespace Syrotp\Sdk\Errors;

/**
 * HTTP 429. Exposes `$retryAfterSeconds` parsed from the
 * `Retry-After` response header.
 *
 * Retriable, bounded, respecting the server's hint.
 */
final class SyrotpRateLimitError extends SyrotpError
{
    public ?int $retryAfterSeconds = null;

    public function __construct(
        string $code,
        string $message,
        int $httpStatus = 429,
        ?string $requestId = null,
        ?int $retryAfterSeconds = null,
    ) {
        parent::__construct($code, $message, $httpStatus, $requestId);
        $this->retryAfterSeconds = $retryAfterSeconds;
    }
}
