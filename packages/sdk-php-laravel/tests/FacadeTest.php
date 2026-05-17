<?php

declare(strict_types=1);

namespace Syrotp\Sdk\Laravel\Tests;

use GuzzleHttp\Handler\MockHandler;
use GuzzleHttp\HandlerStack;
use GuzzleHttp\Middleware;
use GuzzleHttp\Psr7\Response;
use Illuminate\Support\Facades\Facade;
use Syrotp\Sdk\Laravel\Facades\Syrotp;
use Syrotp\Sdk\SyrotpClient;
use Syrotp\Sdk\VerificationStatus;

/**
 * Verifies the `Syrotp` Facade actually proxies to the singleton
 * registered by the provider — and the proxy reaches a real HTTP call
 * (Guzzle MockHandler stands in for the wire).
 */
final class FacadeTest extends TestCase
{
    /**
     * @param list<mixed> $queue items the MockHandler will return
     * @param list<array{request:\Psr\Http\Message\RequestInterface, response:?\Psr\Http\Message\ResponseInterface, error:?\Throwable, options:array<string,mixed>}> $history populated by reference
     */
    private function rebindWithMock(array $queue, array &$history): void
    {
        $mock = new MockHandler($queue);
        $stack = HandlerStack::create($mock);
        $stack->push(Middleware::history($history));

        $client = new SyrotpClient(
            baseUrl: 'http://syrotp.test',
            apiKey: 'sk_live_x',
            handlerStack: $stack,
        );
        $this->app->instance(SyrotpClient::class, $client);
        // The Facade caches its resolved target; clear it so this
        // test's instance is the one that gets called.
        Facade::clearResolvedInstance('syrotp');
    }

    /** @return array<string,mixed> */
    private static function payload(array $overrides = []): array
    {
        return array_replace([
            'id' => 'vrf_lara1',
            'status' => 'pending',
            'phone_masked' => '+96399****567',
            'send_to' => '+963998887777',
            'message' => 'VERIFY ABC123',
            'purpose' => 'login',
            'expires_at' => '2026-05-02T18:00:00.000Z',
            'created_at' => '2026-05-02T17:00:00.000Z',
        ], $overrides);
    }

    public function testFacadeProxiesStartVerification(): void
    {
        $history = [];
        $this->rebindWithMock([
            new Response(201, [], json_encode(self::payload())),
        ], $history);

        $v = Syrotp::startVerification(phone: '+963991234567', purpose: 'login');

        self::assertSame('vrf_lara1', $v->id);
        self::assertSame(VerificationStatus::Pending, $v->status);

        self::assertCount(1, $history);
        $req = $history[0]['request'];
        self::assertSame('POST', $req->getMethod());
        self::assertStringEndsWith('/v1/verifications', $req->getUri()->getPath());
        $body = json_decode((string) $req->getBody(), true);
        self::assertSame(['phone' => '+963991234567', 'purpose' => 'login'], $body);
    }

    public function testFacadeProxiesGetVerification(): void
    {
        $history = [];
        $this->rebindWithMock([
            new Response(200, [], json_encode(self::payload(['status' => 'verified']))),
        ], $history);

        $v = Syrotp::getVerification('vrf_lara1');

        self::assertSame(VerificationStatus::Verified, $v->status);
        self::assertSame('GET', $history[0]['request']->getMethod());
    }

    public function testFacadeProxiesCancelVerification(): void
    {
        $history = [];
        $this->rebindWithMock([
            new Response(200, [], json_encode(self::payload(['status' => 'cancelled']))),
        ], $history);

        $v = Syrotp::cancelVerification('vrf_lara1');

        self::assertSame(VerificationStatus::Cancelled, $v->status);
        $req = $history[0]['request'];
        self::assertSame('POST', $req->getMethod());
        self::assertStringEndsWith('/v1/verifications/vrf_lara1/cancel', $req->getUri()->getPath());
    }

    public function testFacadeAccessorIsTheStringAlias(): void
    {
        // Pin the contract: the Facade looks up `'syrotp'` (lowercase) in
        // the container. The provider binds that alias; if either side
        // drifts the Facade silently breaks.
        $reflection = new \ReflectionClass(Syrotp::class);
        $method = $reflection->getMethod('getFacadeAccessor');
        $method->setAccessible(true);
        self::assertSame('syrotp', $method->invoke(null));
    }
}
