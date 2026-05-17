<?php

declare(strict_types=1);

namespace Syrotp\Sdk\Errors;

/**
 * Construction-time validation failure. Bad baseUrl, missing apiKey,
 * out-of-range timeoutMs / retries, etc.
 *
 * NOT retriable.
 */
final class SyrotpConfigError extends SyrotpError
{
    public function __construct(string $message, string $code = 'config_error')
    {
        parent::__construct($code, $message, 0, null);
    }
}
