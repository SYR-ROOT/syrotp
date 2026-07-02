<?php

declare(strict_types=1);

namespace Syrotp\Sdk\Errors;

/**
 * HTTP 5xx.
 *
 * Retriable, bounded, with jittered backoff. Frequent occurrences
 * should be surfaced to operations.
 */
final class SyrotpServerError extends SyrotpError
{
}
