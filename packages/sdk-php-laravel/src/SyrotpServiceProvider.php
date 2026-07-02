<?php

declare(strict_types=1);

namespace Syrotp\Sdk\Laravel;

use Illuminate\Contracts\Container\Container;
use Illuminate\Support\ServiceProvider;
use Syrotp\Sdk\SyrotpClient;

/**
 * Registers a singleton `Syrotp\Sdk\SyrotpClient` in the Laravel
 * container, configured from `config/syrotp.php`. The string alias
 * `"syrotp"` resolves to the same singleton — that's what the
 * {@see Facades\Syrotp} Facade looks up.
 *
 * Auto-discovered via `extra.laravel.providers` in composer.json — no
 * manual registration needed in `config/app.php`.
 */
final class SyrotpServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        $this->mergeConfigFrom(__DIR__ . '/../config/syrotp.php', 'syrotp');

        $this->app->singleton(SyrotpClient::class, static function (Container $app): SyrotpClient {
            $config = $app['config']->get('syrotp', []);
            $userAgent = $config['user_agent'] ?? null;
            return new SyrotpClient(
                baseUrl: (string) ($config['base_url'] ?? ''),
                apiKey: (string) ($config['api_key'] ?? ''),
                timeoutMs: (int) ($config['timeout_ms'] ?? SyrotpClient::DEFAULT_TIMEOUT_MS),
                retries: (int) ($config['retries'] ?? SyrotpClient::DEFAULT_RETRIES),
                userAgent: is_string($userAgent) && $userAgent !== '' ? $userAgent : null,
            );
        });

        // String alias used by the Facade's `getFacadeAccessor()`. Bind
        // both names to the same singleton so `app('syrotp')` and
        // `app(SyrotpClient::class)` are interchangeable.
        $this->app->alias(SyrotpClient::class, 'syrotp');
    }

    public function boot(): void
    {
        if ($this->app->runningInConsole()) {
            $this->publishes([
                __DIR__ . '/../config/syrotp.php' => $this->app->configPath('syrotp.php'),
            ], 'syrotp-config');
        }
    }
}
