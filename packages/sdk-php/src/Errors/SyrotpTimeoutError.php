<?php

declare(strict_types=1);

namespace Syrotp\Sdk\Errors;

/**
 * The per-request deadline (`timeoutMs`) elapsed before the server
 * finished responding.
 *
 * NOT retriable by the SDK — the caller's deadline already expired.
 * The caller decides whether to retry with a fresh deadline.
 */
final class SyrotpTimeoutError extends SyrotpError
{
    public function __construct(
        string $message = 'request timed out',
        string $code = 'timeout',
        int $httpStatus = 0,
        ?string $requestId = null,
    ) {
        parent::__construct($code, $message, $httpStatus, $requestId);
    }
}
