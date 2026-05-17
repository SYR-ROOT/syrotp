<?php

declare(strict_types=1);

namespace Syrotp\Sdk\Errors;

/**
 * DNS, TLS, connection refused, connection reset, broken response.
 *
 * Retriable, bounded, with jittered backoff.
 */
final class SyrotpNetworkError extends SyrotpError
{
}
