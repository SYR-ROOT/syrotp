<?php

declare(strict_types=1);

namespace Syrotp\Sdk\Errors;

/**
 * HTTP 401 / 403. Bad / missing API key, or key kind not allowed for
 * this endpoint.
 *
 * NOT retriable — keys don't fix themselves.
 */
final class SyrotpAuthError extends SyrotpError
{
}
