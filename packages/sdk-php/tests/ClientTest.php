<?php

declare(strict_types=1);

namespace Syrotp\Sdk\Tests;

use GuzzleHttp\Psr7\Response;
use Syrotp\Sdk\Errors\SyrotpAuthError;
use Syrotp\Sdk\Errors\SyrotpConfigError;
use Syrotp\Sdk\Errors\SyrotpServerError;
use Syrotp\Sdk\Errors\SyrotpTimeoutError;
use Syrotp\Sdk\Errors\SyrotpValidationError;
use Syrotp\Sdk\SyrotpClient;
use Syrotp\Sdk\Tests\Support\FakeClock;
use Syrotp\Sdk\Tests\Support\Fixtures;
use Syrotp\Sdk\Verification;
use Syrotp\Sdk\VerificationStatus;
use PHPUnit\Framework\TestCase;

final class ClientTest extends TestCase
{
    // ----- constructor validation ------------------------------------------

    public function testConstructorRejectsMissingBaseUrl(): void
    {
        $this->expectException(SyrotpConfigError::class);
        $this->expectExceptionMessage('baseUrl');
        new SyrotpClient(baseUrl: '', apiKey: 'sk_live_x');
    }

    public function testConstructorRejectsNonHttpBaseUrl(): void
    {
        $this->expectException(SyrotpConfigError::class);
        $this->expectExceptionMessage('http');
        new SyrotpClient(baseUrl: 'ftp://x', apiKey: 'sk_live_x');
    }

    public function testConstructorRejectsMissingApiKey(): void
    {
        $this->expectException(SyrotpConfigError::class);
        $this->expectExceptionMessage('apiKey');
        new SyrotpClient(baseUrl: 'http://x', apiKey: '');
    }

    public function testConstructorRejectsZeroTimeout(): void
    {
        $this->expectException(SyrotpConfigError::class);
        $this->expectExceptionMessage('timeoutMs');
        new SyrotpClient(baseUrl: 'http://x', apiKey: 'sk_live_x', timeoutMs: 0);
    }

    public function testConstructorRejectsNegativeRetries(): void
    {
        $this->expectException(SyrotpConfigError::class);
        $this->expectExceptionMessage('retries');
        new SyrotpClient(baseUrl: 'http://x', apiKey: 'sk_live_x', retries: -1);
    }

    public function testUserAgentIncludesSdkVersion(): void
    {
        $history = [];
        $client = Fixtures::makeClient(
            queue: [new Response(201, [], json_encode(Fixtures::verificationPayload()))],
            history: $history,
        );
        $client->startVerification(phone: '+1', purpose: 'login');

        $ua = $history[0]['request']->getHeaderLine('User-Agent');
        self::assertStringStartsWith('syrotp-sdk-php/', $ua);
        self::assertStringContainsString(SyrotpClient::VERSION, $ua);
    }

    public function testUserAgentSuffixIsAppended(): void
    {
        $history = [];
        [, $stack] = Fixtures::mockStack(
            [new Response(201, [], json_encode(Fixtures::verificationPayload()))],
            $history,
        );
        $client = new SyrotpClient(
            baseUrl: 'http://syrotp.test',
            apiKey: 'sk_live_x',
            userAgent: 'my-app/1.0',
            handlerStack: $stack,
        );
        $client->startVerification(phone: '+1', purpose: 'login');

        $ua = $history[0]['request']->getHeaderLine('User-Agent');
        self::assertStringContainsString('my-app/1.0', $ua);
    }

    public function testUserAgentStripsControlCharsFromSuffix(): void
    {
        $history = [];
        [, $stack] = Fixtures::mockStack(
            [new Response(201, [], json_encode(Fixtures::verificationPayload()))],
            $history,
        );
        $client = new SyrotpClient(
            baseUrl: 'http://syrotp.test',
            apiKey: 'sk_live_x',
            userAgent: "evil\r\nX-Injected: yes",
            handlerStack: $stack,
        );
        $client->startVerification(phone: '+1', purpose: 'login');

        $ua = $history[0]['request']->getHeaderLine('User-Agent');
        self::assertStringNotContainsString("\r", $ua);
        self::assertStringNotContainsString("\n", $ua);
    }

    // ----- startVerification -----------------------------------------------

    public function testStartVerificationHappyPath(): void
    {
        $history = [];
        $client = Fixtures::makeClient(
            queue: [new Response(201, [], json_encode(Fixtures::verificationPayload(['status' => 'pending'])))],
            history: $history,
        );
        $v = $client->startVerification(phone: '+963991234567', purpose: 'login');

        self::assertInstanceOf(Verification::class, $v);
        self::assertSame(VerificationStatus::Pending, $v->status);
        self::assertSame('vrf_01HX', $v->id);
        self::assertSame('+963998887777', $v->sendTo);
        self::assertSame('VERIFY ABC123', $v->message);

        $req = $history[0]['request'];
        self::assertSame('POST', $req->getMethod());
        self::assertStringEndsWith('/v1/verifications', $req->getUri()->getPath());
        self::assertSame('Bearer sk_live_TESTKEY_DO_NOT_USE', $req->getHeaderLine('Authorization'));

        $body = json_decode((string) $req->getBody(), true);
        self::assertSame(['phone' => '+963991234567', 'purpose' => 'login'], $body);
    }

    public function testStartVerificationIncludesOptionalFields(): void
    {
        $history = [];
        $client = Fixtures::makeClient(
            queue: [new Response(201, [], json_encode(Fixtures::verificationPayload()))],
            history: $history,
        );
        $client->startVerification(phone: '+1', purpose: 'signup', clientRef: 'user-42', locale: 'en-US');

        $body = json_decode((string) $history[0]['request']->getBody(), true);
        self::assertSame(
            ['phone' => '+1', 'purpose' => 'signup', 'client_ref' => 'user-42', 'locale' => 'en-US'],
            $body,
        );
    }

    public function testStartVerificationOmitsUnsetOptionalFields(): void
    {
        $history = [];
        $client = Fixtures::makeClient(
            queue: [new Response(201, [], json_encode(Fixtures::verificationPayload()))],
            history: $history,
        );
        $client->startVerification(phone: '+1', purpose: 'login');

        $body = json_decode((string) $history[0]['request']->getBody(), true);
        self::assertArrayNotHasKey('client_ref', $body);
        self::assertArrayNotHasKey('locale', $body);
    }

    public function testStartVerificationRejectsEmptyPhone(): void
    {
        $client = Fixtures::makeClient(
            queue: [new Response(201, [], json_encode(Fixtures::verificationPayload()))],
        );
        $this->expectException(SyrotpValidationError::class);
        $this->expectExceptionMessage('phone');
        $client->startVerification(phone: '', purpose: 'login');
    }

    // ----- getVerification -------------------------------------------------

    public function testGetVerificationHappyPath(): void
    {
        $history = [];
        $client = Fixtures::makeClient(
            queue: [new Response(200, [], json_encode(Fixtures::verificationPayload([
                'status' => 'verified',
                'verified_at' => '2026-05-02T17:01:00.000Z',
            ])))],
            history: $history,
        );
        $v = $client->getVerification('vrf_01HX');

        self::assertSame(VerificationStatus::Verified, $v->status);
        self::assertSame('2026-05-02T17:01:00.000Z', $v->verifiedAt);

        $req = $history[0]['request'];
        self::assertSame('GET', $req->getMethod());
        self::assertStringEndsWith('/v1/verifications/vrf_01HX', $req->getUri()->getPath());
    }

    public function testGetVerificationRejectsBadId(): void
    {
        $client = Fixtures::makeClient(
            queue: [new Response(200, [], json_encode(Fixtures::verificationPayload()))],
        );
        $this->expectException(SyrotpValidationError::class);
        $this->expectExceptionMessage('verificationId');
        $client->getVerification('not-a-vrf-id');
    }

    // ----- cancelVerification ----------------------------------------------

    public function testCancelVerificationHappyPath(): void
    {
        $history = [];
        $client = Fixtures::makeClient(
            queue: [new Response(200, [], json_encode(Fixtures::verificationPayload(['status' => 'cancelled'])))],
            history: $history,
        );
        $v = $client->cancelVerification('vrf_01HX');

        self::assertSame(VerificationStatus::Cancelled, $v->status);
        $req = $history[0]['request'];
        self::assertSame('POST', $req->getMethod());
        self::assertStringEndsWith('/v1/verifications/vrf_01HX/cancel', $req->getUri()->getPath());
    }

    // ----- waitForVerification ---------------------------------------------

    public function testWaitForVerificationReturnsWhenTerminal(): void
    {
        $clock = new FakeClock();
        $payload = static fn (string $status): string => json_encode(Fixtures::verificationPayload(['status' => $status]));

        $client = Fixtures::makeClient(
            queue: [
                new Response(200, [], $payload('pending')),
                new Response(200, [], $payload('pending')),
                new Response(200, [], $payload('verified')),
            ],
            clock: $clock,
        );
        $v = $client->waitForVerification('vrf_01HX', intervalMs: 2000, timeoutMs: 10_000);
        self::assertSame(VerificationStatus::Verified, $v->status);
    }

    public function testWaitForVerificationRaisesOnDeadline(): void
    {
        $clock = new FakeClock();
        $payload = json_encode(Fixtures::verificationPayload(['status' => 'pending']));

        $client = Fixtures::makeClient(
            queue: [
                new Response(200, [], $payload),
                new Response(200, [], $payload),
                new Response(200, [], $payload),
            ],
            clock: $clock,
        );
        $this->expectException(SyrotpTimeoutError::class);
        $client->waitForVerification('vrf_01HX', intervalMs: 2000, timeoutMs: 1000);
    }

    // ----- error mapping ---------------------------------------------------

    public function testFourHundredOneRaisesAuthError(): void
    {
        $body = json_encode(['error' => [
            'code' => 'unauthorized',
            'message' => 'missing creds',
            'request_id' => 'req_xyz',
        ]]);
        $client = Fixtures::makeClient(queue: [new Response(401, [], $body)]);

        try {
            $client->startVerification(phone: '+1', purpose: 'x');
            self::fail('expected SyrotpAuthError');
        } catch (SyrotpAuthError $e) {
            self::assertSame(401, $e->httpStatus);
            self::assertSame('unauthorized', $e->code);
            self::assertSame('req_xyz', $e->requestId);
        }
    }

    public function testFourHundredRaisesValidationError(): void
    {
        $body = json_encode(['error' => ['code' => 'validation_error', 'message' => 'bad phone']]);
        $client = Fixtures::makeClient(queue: [new Response(400, [], $body)]);

        $this->expectException(SyrotpValidationError::class);
        $client->startVerification(phone: 'x', purpose: 'x');
    }

    public function testFiveHundredRaisesServerError(): void
    {
        $body = json_encode(['error' => ['code' => 'internal_error', 'message' => 'boom']]);
        $client = Fixtures::makeClient(queue: [new Response(500, [], $body)]);

        $this->expectException(SyrotpServerError::class);
        $client->startVerification(phone: '+1', purpose: 'x');
    }

    // ----- forward-compat unknown statuses ---------------------------------

    public function testUnknownStatusMapsToUnknown(): void
    {
        $client = Fixtures::makeClient(
            queue: [new Response(201, [], json_encode(Fixtures::verificationPayload(['status' => 'quantum_uncertain'])))],
        );
        $v = $client->startVerification(phone: '+1', purpose: 'x');
        self::assertSame(VerificationStatus::Unknown, $v->status);
    }

    public function testUnknownResponseFieldsPreservedInExtras(): void
    {
        $payload = Fixtures::verificationPayload();
        $payload['future_field'] = 42;
        $client = Fixtures::makeClient(
            queue: [new Response(201, [], json_encode($payload))],
        );
        $v = $client->startVerification(phone: '+1', purpose: 'x');
        self::assertSame(['future_field' => 42], $v->extras);
    }
}
