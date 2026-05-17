<?php

declare(strict_types=1);

namespace Syrotp\Sdk\Laravel\Facades;

use Illuminate\Support\Facades\Facade;
use Syrotp\Sdk\SyrotpClient;
use Syrotp\Sdk\Verification;

/**
 * Static-style proxy to the singleton {@see SyrotpClient} in the
 * Laravel container.
 *
 *     use Syrotp\Sdk\Laravel\Facades\Syrotp;
 *
 *     $v = Syrotp::startVerification(phone: '+963991234567', purpose: 'login');
 *
 * The Facade is *not* auto-aliased to the global namespace — you
 * always import it explicitly. That keeps Facade::clearResolvedInstances()
 * predictable and avoids surprising imports in apps that already have
 * a class called `Syrotp`.
 *
 * @method static Verification startVerification(string $phone, string $purpose, ?string $clientRef = null, ?string $locale = null)
 * @method static Verification getVerification(string $verificationId)
 * @method static Verification cancelVerification(string $verificationId)
 * @method static Verification waitForVerification(string $verificationId, int $intervalMs = 2500, int $timeoutMs = 300000)
 *
 * @see SyrotpClient
 */
final class Syrotp extends Facade
{
    protected static function getFacadeAccessor(): string
    {
        return 'syrotp';
    }
}
