<?php

declare(strict_types=1);

namespace Syrotp\Sdk\Errors;

/**
 * HTTP 400 (server-side validation), or local input validation
 * (e.g. malformed verification id).
 *
 * NOT retriable. Surface to the user; the input is wrong.
 */
final class SyrotpValidationError extends SyrotpError
{
}
