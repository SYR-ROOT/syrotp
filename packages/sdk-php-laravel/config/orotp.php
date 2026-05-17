<?php

declare(strict_types=1);

/*
 * SYROTP — Syrian Reverse OTP Protocol — Laravel configuration.
 *
 * Set these via environment variables (.env). The names match what the
 * `syrotp` CLI and `scripts/smoke.mjs` use, so a deployment that's
 * already wired for the CLI doesn't need a second set of secrets.
 *
 * For the cross-language API contract, see:
 *     https://github.com/SYR-ROOT/syrotp/blob/main/docs/sdk-contract.md
 */

return [

    /*
    |--------------------------------------------------------------------------
    | Base URL
    |--------------------------------------------------------------------------
    |
    | Where the SYROTP server lives. Trailing slash is optional. The SDK
    | refuses anything that isn't `http://` or `https://`. Use HTTPS in
    | production — plain HTTP to a public host triggers a one-time
    | warning at construction.
    |
    */

    'base_url' => env('SYROTP_BASE_URL'),

    /*
    |--------------------------------------------------------------------------
    | API key
    |--------------------------------------------------------------------------
    |
    | Either a `pk_live_*` (publishable) or `sk_live_*` (secret) key.
    | Sent as `Authorization: Bearer <api_key>`. Falls back to
    | SYROTP_PUBLIC_KEY if SYROTP_SECRET_KEY isn't set, matching the
    | smoke / quickstart convention.
    |
    */

    'api_key' => env('SYROTP_SECRET_KEY', env('SYROTP_PUBLIC_KEY')),

    /*
    |--------------------------------------------------------------------------
    | Per-request timeout (milliseconds)
    |--------------------------------------------------------------------------
    |
    | Hard ceiling on every HTTP call. NEVER infinite — the SDK refuses
    | non-positive values at construction time.
    |
    */

    'timeout_ms' => (int) env('SYROTP_TIMEOUT_MS', 15000),

    /*
    |--------------------------------------------------------------------------
    | Retry budget
    |--------------------------------------------------------------------------
    |
    | Maximum retries per request for retriable failures (network /
    | 5xx / 429 with Retry-After). `0` disables retry entirely. The
    | `cancelVerification` call is independently capped at 1 retry.
    |
    */

    'retries' => (int) env('SYROTP_RETRIES', 2),

    /*
    |--------------------------------------------------------------------------
    | User-Agent suffix
    |--------------------------------------------------------------------------
    |
    | Appended to the SDK's own User-Agent (`syrotp-sdk-php/<version>`).
    | Useful for identifying which app is hitting the server in your
    | SYROTP receiver logs. Leave null for none.
    |
    */

    'user_agent' => env('SYROTP_USER_AGENT'),

];
