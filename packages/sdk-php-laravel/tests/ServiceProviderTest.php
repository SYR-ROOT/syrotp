<?php

declare(strict_types=1);

namespace Syrotp\Sdk\Laravel\Tests;

use Syrotp\Sdk\Errors\SyrotpConfigError;
use Syrotp\Sdk\SyrotpClient;

final class ServiceProviderTest extends TestCase
{
    public function testSyrotpClientResolvesAsSingleton(): void
    {
        $a = $this->app->make(SyrotpClient::class);
        $b = $this->app->make(SyrotpClient::class);
        self::assertSame($a, $b, 'SyrotpClient must be a singleton in the container');
    }

    public function testStringAliasResolvesToTheSameSingleton(): void
    {
        $byClass = $this->app->make(SyrotpClient::class);
        $byAlias = $this->app->make('syrotp');
        self::assertSame($byClass, $byAlias);
    }

    public function testProviderThrowsConfigErrorOnMissingBaseUrl(): void
    {
        $this->app['config']->set('syrotp.base_url', '');
        // Force re-resolution; the singleton may be cached from earlier
        // bindings during boot.
        $this->app->forgetInstance(SyrotpClient::class);

        $this->expectException(SyrotpConfigError::class);
        $this->expectExceptionMessage('baseUrl');
        $this->app->make(SyrotpClient::class);
    }

    public function testProviderThrowsConfigErrorOnMissingApiKey(): void
    {
        $this->app['config']->set('syrotp.api_key', '');
        $this->app->forgetInstance(SyrotpClient::class);

        $this->expectException(SyrotpConfigError::class);
        $this->expectExceptionMessage('apiKey');
        $this->app->make(SyrotpClient::class);
    }

    public function testProviderRejectsZeroTimeout(): void
    {
        $this->app['config']->set('syrotp.timeout_ms', 0);
        $this->app->forgetInstance(SyrotpClient::class);

        $this->expectException(SyrotpConfigError::class);
        $this->expectExceptionMessage('timeoutMs');
        $this->app->make(SyrotpClient::class);
    }

    public function testProviderRejectsNegativeRetries(): void
    {
        $this->app['config']->set('syrotp.retries', -1);
        $this->app->forgetInstance(SyrotpClient::class);

        $this->expectException(SyrotpConfigError::class);
        $this->expectExceptionMessage('retries');
        $this->app->make(SyrotpClient::class);
    }

    public function testProviderHandlesEmptyUserAgentAsNull(): void
    {
        $this->app['config']->set('syrotp.user_agent', '');
        $this->app->forgetInstance(SyrotpClient::class);

        // Should NOT throw — empty string falls through to the default null.
        $client = $this->app->make(SyrotpClient::class);
        self::assertInstanceOf(SyrotpClient::class, $client);
    }
}
