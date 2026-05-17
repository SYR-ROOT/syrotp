# SYROTP PHP SDK

Official PHP SDK for the [Syrian Reverse OTP Protocol](https://github.com/SYR-ROOT/syrotp).
Sync client; framework helpers (Laravel ServiceProvider / Facade) ship
in a follow-up PR.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](../../LICENSE)
![php](https://img.shields.io/badge/php-8.2%2B-blue)

## Installation

```bash
composer require syrotp/sdk
```

## Quickstart

```php
use Syrotp\Sdk\SyrotpClient;
use Syrotp\Sdk\VerificationStatus;
use Syrotp\Sdk\Errors\SyrotpError;

$client = new SyrotpClient(
    baseUrl: 'https://otp.example.com',
    apiKey: 'sk_live_...',
);

$v = $client->startVerification(phone: '+963991234567', purpose: 'login');
printf("Send '%s' to %s\n", $v->message, $v->sendTo);

$final = $client->waitForVerification($v->id);
if ($final->status === VerificationStatus::Verified) {
    echo "phone owned by sender\n";
} elseif ($final->status === VerificationStatus::Expired) {
    echo "user took too long\n";
}
```

A runnable version lives in [`examples/quickstart.php`](examples/quickstart.php).
Set `SYROTP_BASE_URL` and `SYROTP_SECRET_KEY` (or `SYROTP_PUBLIC_KEY`) and
run it.

## Server requirements

- **Minimum SYROTP server version:** `v0.3.0`.
- The SDK is wire-compatible with any `0.x` server. Newer server
  fields are preserved on `Verification::$extras`; newer status values
  surface as `VerificationStatus::Unknown`. See
  [`docs/sdk-versioning.md`](../../docs/sdk-versioning.md) for the
  version-skew matrix.

## Public surface

```php
final class SyrotpClient
{
    public function __construct(
        string $baseUrl,
        string $apiKey,
        int $timeoutMs = 15000,           // NEVER infinite
        int $retries = 2,                 // network / 5xx / 429 only
        ?string $userAgent = null,
        ?\GuzzleHttp\HandlerStack $handlerStack = null,
        ?\Psr\Log\LoggerInterface $logger = null,
    );

    public function startVerification(
        string $phone, string $purpose,
        ?string $clientRef = null, ?string $locale = null,
    ): Verification;

    public function getVerification(string $verificationId): Verification;
    public function cancelVerification(string $verificationId): Verification;
    public function waitForVerification(
        string $verificationId,
        int $intervalMs = 2500,
        int $timeoutMs = 300000,
    ): Verification;
}
```

Plus the typed error hierarchy:

```
SyrotpError                      # base; catch this for "anything went wrong"
├── SyrotpConfigError            # bad construction args
├── SyrotpAuthError              # 401 / 403  — NEVER retried
├── SyrotpValidationError        # 400 / local input check  — NEVER retried
├── SyrotpRateLimitError         # 429 (carries $retryAfterSeconds)
├── SyrotpNetworkError           # DNS / TLS / connection failures
├── SyrotpServerError            # 5xx
└── SyrotpTimeoutError           # per-request deadline expired
```

## Conformance

This SDK is SYROTP-compliant per
[`docs/sdk-contract.md`](../../docs/sdk-contract.md). Every box is
checked:

- [x] Constructor accepts `baseUrl`, `apiKey`, `timeoutMs`, `retries`, `userAgent`.
- [x] Constructor rejects bad inputs with `SyrotpConfigError`.
- [x] `startVerification`, `getVerification`, `cancelVerification` return `Verification`.
- [x] `waitForVerification` polls until non-pending; throws `SyrotpTimeoutError` at the deadline.
- [x] All seven typed error classes exist and are raised in the right categories.
- [x] Default `timeoutMs = 15000` — finite.
- [x] Default `retries = 2`; retries on network / `5xx` / `429` only.
- [x] `Retry-After` is honored on `429`.
- [x] No retry on `4xx` other than `429`. No retry on auth / validation / config / timeout.
- [x] `cancelVerification` capped at one retry to avoid log noise.
- [x] `User-Agent` includes `syrotp-sdk-php/<version>`.
- [x] Plain HTTP to a non-private host triggers a one-time warning at
      construction (no warning for `localhost` / RFC1918).
- [x] `apiKey` is never present in `(string) $error` or anywhere on
      the SDK's PSR-3 logger output.
- [x] Request bodies (which include the user's phone) are never
      logged by the SDK.
- [x] Live cross-stack test: every PR runs the SDK's
      `startVerification` / `cancelVerification` against the
      freshly-built TS server in CI's smoke job.

## Logging

The SDK accepts an optional `Psr\Log\LoggerInterface`. By default it
logs:

- A one-time `WARNING` on construction if `baseUrl` is plain HTTP to
  a non-private host.

```php
use Monolog\Logger;
use Monolog\Handler\StreamHandler;

$log = new Logger('syrotp');
$log->pushHandler(new StreamHandler('php://stderr', Logger::WARNING));

$client = new SyrotpClient(
    baseUrl: 'https://otp.example.com',
    apiKey: 'sk_live_...',
    logger: $log,
);
```

The SDK is **never** asked to log any of: `Authorization` header,
`apiKey` argument, request body, response body, `phone`, `message`,
or `sendTo`. If you wrap the SDK in something that does, you owned
the leak.

## Versioning

This SDK follows [`docs/sdk-versioning.md`](../../docs/sdk-versioning.md):

- `MAJOR` tracks the protocol's `MAJOR`.
- `MINOR` adds backwards-compatible methods / options.
- `PATCH` is bug fixes only.

## Development

```bash
cd packages/sdk-php
composer install
vendor/bin/phpunit
```

## License

MIT — see [`../../LICENSE`](../../LICENSE).
