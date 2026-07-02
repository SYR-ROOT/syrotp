<?php

declare(strict_types=1);

namespace Syrotp\Sdk\Errors;

use Exception;

/**
 * Base class for every error raised by the SYROTP SDK.
 *
 * Application code is expected to catch by category:
 *
 *     try {
 *         $client->startVerification(phone: '...', purpose: 'login');
 *     } catch (SyrotpRateLimitError $e) {
 *         backoffAndRetry($e->retryAfterSeconds);
 *     } catch (SyrotpValidationError $e) {
 *         // surface to the user; do NOT auto-retry
 *     } catch (SyrotpError $e) {
 *         // catch-all for unexpected categories
 *     }
 *
 * Every error carries `$code`, `$httpStatus`, `$requestId`, and the
 * standard Exception `$message`. `__toString()` deliberately returns
 * only `code: message (request_id=...)` so a naive `(string)$err` log
 * line cannot leak credentials.
 *
 * Mirrors `docs/sdk-contract.md` §5.
 */
class SyrotpError extends Exception
{
    /**
     * Stable short error code (e.g. "validation_error", "rate_limited").
     *
     * Redeclares the parent's untyped `$code` slot — see PDOException
     * for the same pattern in core PHP. PHP forbids adding a type
     * declaration here (the parent is untyped, child must match), so
     * we use a docblock-only string typing.
     *
     * @var string
     */
    public $code = '';

    public int $httpStatus = 0;

    public ?string $requestId = null;

    public function __construct(
        string $code,
        string $message,
        int $httpStatus = 0,
        ?string $requestId = null,
    ) {
        parent::__construct($message);
        $this->code = $code;
        $this->httpStatus = $httpStatus;
        $this->requestId = $requestId;
    }

    /**
     * Render `code: message (request_id=...)`. Never includes the
     * request body, the api_key, or any field the SDK was constructed
     * with — so `(string)$err` is safe to ship to a SaaS log
     * aggregator.
     */
    public function __toString(): string
    {
        $rid = $this->requestId !== null ? " (request_id={$this->requestId})" : '';
        return "{$this->code}: {$this->getMessage()}{$rid}";
    }
}
