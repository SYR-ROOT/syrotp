<?php

declare(strict_types=1);

namespace Syrotp\Sdk\Laravel\Tests;

use Syrotp\Sdk\SyrotpClient;

final class ConfigTest extends TestCase
{
    public function testConfigIsMergedAtProviderRegistration(): void
    {
        // The provider runs `mergeConfigFrom` so the package's defaults
        // become available under `config('syrotp.*')` even when the host
        // app hasn't published the file.
        self::assertNotNull(config('syrotp'));
        self::assertSame(15000, config('syrotp.timeout_ms'));
        self::assertSame(2, config('syrotp.retries'));
    }

    public function testConfigOverrideAtAppLevelWins(): void
    {
        $this->app['config']->set('syrotp.timeout_ms', 5000);
        $this->app['config']->set('syrotp.retries', 0);
        $this->app->forgetInstance(SyrotpClient::class);

        // No exception means the SyrotpClient accepted these values.
        $client = $this->app->make(SyrotpClient::class);
        self::assertInstanceOf(SyrotpClient::class, $client);
    }

    public function testConfigIsPublishable(): void
    {
        $publishedPath = $this->app->configPath('syrotp.php');
        if (file_exists($publishedPath)) {
            @unlink($publishedPath);
        }

        $this->artisan('vendor:publish', [
            '--tag' => 'syrotp-config',
            '--force' => true,
        ])->assertSuccessful();

        self::assertFileExists($publishedPath, 'config/syrotp.php should publish under the syrotp-config tag');
        @unlink($publishedPath);
    }
}
