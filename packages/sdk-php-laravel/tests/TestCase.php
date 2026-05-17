<?php

declare(strict_types=1);

namespace Syrotp\Sdk\Laravel\Tests;

use Illuminate\Foundation\Application;
use Orchestra\Testbench\TestCase as BaseTestCase;
use Syrotp\Sdk\Laravel\SyrotpServiceProvider;

/**
 * Shared base for the Testbench-driven test suite. Loads the
 * service provider and seeds the `syrotp.*` config with safe test
 * defaults so individual tests don't have to.
 */
abstract class TestCase extends BaseTestCase
{
    /**
     * @param Application $app
     * @return array<int, class-string>
     */
    protected function getPackageProviders($app): array
    {
        return [SyrotpServiceProvider::class];
    }

    /**
     * @param Application $app
     */
    protected function defineEnvironment($app): void
    {
        $app['config']->set('syrotp.base_url', 'http://syrotp.test');
        $app['config']->set('syrotp.api_key', 'sk_live_TESTKEY_DO_NOT_USE');
    }
}
