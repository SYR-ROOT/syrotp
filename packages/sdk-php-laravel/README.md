# SYROTP — Laravel integration

Laravel ServiceProvider + Facade + publishable config for the
[SYROTP PHP SDK](../sdk-php/).

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](../../LICENSE)
![php](https://img.shields.io/badge/php-8.2%2B-blue)
![laravel](https://img.shields.io/badge/laravel-11%20%7C%2012-red)

## Installation

```bash
composer require syrotp/laravel
php artisan vendor:publish --tag=syrotp-config
```

The provider auto-discovers — no entry needed in `config/app.php`.

Then add to your `.env`:

```
SYROTP_BASE_URL=https://otp.example.com
SYROTP_SECRET_KEY=sk_live_...
```

## Quickstart

```php
use Syrotp\Sdk\Laravel\Facades\Syrotp;
use Syrotp\Sdk\VerificationStatus;

$v = Syrotp::startVerification(phone: '+963991234567', purpose: 'login');

return view('verify', [
    'instruction' => $v->message,
    'send_to' => $v->sendTo,
]);
```

Or inject the underlying client where dependency injection is more
natural — controllers, services, jobs:

```php
use Syrotp\Sdk\SyrotpClient;

class LoginController
{
    public function __construct(private readonly SyrotpClient $syrotp) {}

    public function start(Request $request)
    {
        $v = $this->syrotp->startVerification(
            phone: $request->string('phone'),
            purpose: 'login',
        );
        // …
    }
}
```

## Configuration

Every option in [`config/syrotp.php`](config/syrotp.php) is sourced from
environment variables, matching the names used by the `syrotp` CLI and
`scripts/smoke.mjs`:

| .env key             | Default | Notes |
| ---                  | ---     | --- |
| `SYROTP_BASE_URL`     | —       | Required. Trailing slash optional. Plain HTTP to a public host triggers a one-time warning. |
| `SYROTP_SECRET_KEY`   | —       | Required. Falls back to `SYROTP_PUBLIC_KEY` if unset. |
| `SYROTP_TIMEOUT_MS`   | `15000` | Per-request deadline in ms. **Never infinite.** |
| `SYROTP_RETRIES`      | `2`     | Retry budget for network / 5xx / 429. `cancelVerification` is independently capped at 1 retry. |
| `SYROTP_USER_AGENT`   | —       | Optional suffix appended to `syrotp-sdk-php/<version>`. CR/LF/NUL stripped. |

## Public surface

This package adds:

- **`Syrotp\Sdk\Laravel\SyrotpServiceProvider`** — registers the
  `SyrotpClient` singleton, binds the `"syrotp"` alias, and publishes
  `config/syrotp.php` under the `syrotp-config` tag.
- **`Syrotp\Sdk\Laravel\Facades\Syrotp`** — static-style proxy
  (`Syrotp::startVerification(...)`) over the singleton. **Not**
  auto-aliased to the global namespace — import explicitly.

That's it. Everything else (the four SDK methods, the seven typed
exceptions, retry policy, security canaries) lives in the underlying
[`syrotp/sdk`](../sdk-php/) package and behaves identically here.

## Deliberately NOT in scope

These belong in separate follow-ups so the integration surface stays
small and obvious:

- ❌ Eloquent `Verification` model + migrations
- ❌ Blade components (`<x-syrotp-verify />` — that's part of v0.5
  hosted page)
- ❌ Queue jobs / event listeners / notification channel
- ❌ Filament / Nova admin panels
- ❌ Custom validation rules (`Rule::syrotpPhone()`)

Open an issue if you want any of these — happy to discuss scope, but
they don't ship in this package.

## Versioning

Follows [`docs/sdk-versioning.md`](../../docs/sdk-versioning.md).
`MAJOR` tracks the protocol's `MAJOR`; `MINOR` adds backwards-compatible
options; `PATCH` is bug fixes only.

`syrotp/laravel` requires `syrotp/sdk: ^0.1`. Bumping the SDK to `0.2`
will require a coordinated bump here.

## Development

```bash
cd packages/sdk-php-laravel
composer install
vendor/bin/phpunit
```

The package depends on the local `../sdk-php` via a Composer path repo,
so changes to the SDK are picked up immediately in tests.

## License

MIT — see [`../../LICENSE`](../../LICENSE).
