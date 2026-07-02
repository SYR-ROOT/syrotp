<?php

declare(strict_types=1);

namespace Syrotp\Sdk;

use GuzzleHttp\Client as GuzzleClient;
use GuzzleHttp\HandlerStack;
use GuzzleHttp\RequestOptions;
use JsonException;
use Syrotp\Sdk\Errors\SyrotpAuthError;
use Syrotp\Sdk\Errors\SyrotpConfigError;
use Syrotp\Sdk\Errors\SyrotpError;
use Syrotp\Sdk\Errors\SyrotpRateLimitError;
use Syrotp\Sdk\Errors\SyrotpServerError;
use Syrotp\Sdk\Errors\SyrotpTimeoutError;
use Syrotp\Sdk\Errors\SyrotpValidationError;
use Syrotp\Sdk\Internal\Clock;
use Syrotp\Sdk\Internal\HttpExecutor;
use Syrotp\Sdk\Internal\SystemClock;
use Psr\Http\Message\ResponseInterface;
use Psr\Log\LoggerInterface;
use Psr\Log\NullLogger;

/**
 * Public sync client for the Syrian Reverse OTP Protocol.
 *
 *     use Syrotp\Sdk\SyrotpClient;
 *
 *     $client = new SyrotpClient(
 *         baseUrl: 'https://otp.example.com',
 *         apiKey: 'sk_live_...',
 *     );
 *     $v = $client->startVerification(phone: '+963991234567', purpose: 'login');
 *     printf("Send %s to %s\n", $v->message, $v->sendTo);
 *     $final = $client->waitForVerification($v->id);
 *
 * The shape of every operation is normative — see
 * `docs/sdk-contract.md`. The retry policy is normative — see
 * `docs/sdk-generation.md` §7.
 */
final class SyrotpClient
{
    public const VERSION = '0.1.0';

    public const DEFAULT_TIMEOUT_MS = 15_000;
    public const DEFAULT_RETRIES = 2;
    public const DEFAULT_WAIT_INTERVAL_MS = 2_500;
    public const MIN_WAIT_INTERVAL_MS = 2_000; // server enforces per-IP read rate limit
    public const DEFAULT_WAIT_TIMEOUT_MS = 5 * 60_000;

    private const VERIFICATION_ID_RE = '/^vrf_[A-Za-z0-9]+$/';
    private const HTTP_URL_RE = '/^https?:\/\//i';

    private readonly string $baseUrl;
    private readonly string $apiKey;
    private readonly int $timeoutMs;
    private readonly int $retries;
    private readonly string $userAgent;
    private readonly LoggerInterface $logger;
    private readonly Clock $clock;
    private readonly HttpExecutor $executor;
    private readonly GuzzleClient $http;

    public function __construct(
        string $baseUrl,
        string $apiKey,
        int $timeoutMs = self::DEFAULT_TIMEOUT_MS,
        int $retries = self::DEFAULT_RETRIES,
        ?string $userAgent = null,
        ?HandlerStack $handlerStack = null,
        ?LoggerInterface $logger = null,
        ?Clock $clock = null,
    ) {
        if ($baseUrl === '') {
            throw new SyrotpConfigError('baseUrl is required');
        }
        if (preg_match(self::HTTP_URL_RE, $baseUrl) !== 1) {
            throw new SyrotpConfigError('baseUrl must be an http(s) URL');
        }
        if ($apiKey === '') {
            throw new SyrotpConfigError('apiKey is required');
        }
        if ($timeoutMs <= 0) {
            throw new SyrotpConfigError('timeoutMs must be a positive int');
        }
        if ($retries < 0) {
            throw new SyrotpConfigError('retries must be a non-negative int');
        }

        $this->baseUrl = rtrim($baseUrl, '/');
        $this->apiKey = $apiKey;
        $this->timeoutMs = $timeoutMs;
        $this->retries = $retries;
        $this->userAgent = self::buildUserAgent($userAgent);
        $this->logger = $logger ?? new NullLogger();
        $this->clock = $clock ?? new SystemClock();
        $this->executor = new HttpExecutor($this->clock);

        // Warn-on-cleartext for non-loopback / non-RFC1918 hosts. The
        // SDK does NOT outright refuse plain HTTP — local dev and
        // on-prem deployments need it — but ops gets a one-time warning.
        // See `docs/sdk-generation.md` §5.
        if (str_starts_with(strtolower($this->baseUrl), 'http://')
            && !self::isLoopbackOrPrivate($this->baseUrl)
        ) {
            $this->logger->warning(
                'syrotp-sdk: baseUrl is plain HTTP to a non-private host ({host}); use https:// in production',
                ['host' => self::hostOnly($this->baseUrl)],
            );
        }

        $timeoutSec = $this->timeoutMs / 1000.0;
        $options = [
            'base_uri' => $this->baseUrl . '/',
            'timeout' => $timeoutSec,
            'connect_timeout' => min(15.0, $timeoutSec),
            // We classify non-2xx responses ourselves so the executor's
            // retry policy can branch on the typed error category.
            'http_errors' => false,
            'headers' => [
                'User-Agent' => $this->userAgent,
                'Accept' => 'application/json',
                'Authorization' => 'Bearer ' . $this->apiKey,
            ],
        ];
        if ($handlerStack !== null) {
            $options['handler'] = $handlerStack;
        }
        $this->http = new GuzzleClient($options);
    }

    // ----- public API -------------------------------------------------------

    /**
     * POST /v1/verifications. Required for both pk_live_* and sk_live_* keys.
     */
    public function startVerification(
        string $phone,
        string $purpose,
        ?string $clientRef = null,
        ?string $locale = null,
    ): Verification {
        if ($phone === '') {
            throw new SyrotpValidationError('validation_error', 'phone is required');
        }
        if ($purpose === '') {
            throw new SyrotpValidationError('validation_error', 'purpose is required');
        }
        $body = ['phone' => $phone, 'purpose' => $purpose];
        if ($clientRef !== null) {
            $body['client_ref'] = $clientRef;
        }
        if ($locale !== null) {
            $body['locale'] = $locale;
        }
        $data = $this->request('POST', '/v1/verifications', $body, null);
        return Verification::fromArray($data);
    }

    /** GET /v1/verifications/{id}. Available with both key kinds. */
    public function getVerification(string $verificationId): Verification
    {
        $this->checkVerificationId($verificationId);
        $data = $this->request('GET', "/v1/verifications/{$verificationId}", null, null);
        return Verification::fromArray($data);
    }

    /**
     * POST /v1/verifications/{id}/cancel. Idempotent server-side, but
     * the SDK still caps retries at 1 to avoid log noise — see
     * `docs/sdk-generation.md` §7.
     */
    public function cancelVerification(string $verificationId): Verification
    {
        $this->checkVerificationId($verificationId);
        $cap = min($this->retries, 1);
        $data = $this->request('POST', "/v1/verifications/{$verificationId}/cancel", null, $cap);
        return Verification::fromArray($data);
    }

    /**
     * Poll `getVerification` until the status is non-pending or the
     * deadline elapses.
     *
     * Throws `SyrotpTimeoutError` if the deadline expires while still
     * pending. Other errors propagate from `getVerification`.
     */
    public function waitForVerification(
        string $verificationId,
        int $intervalMs = self::DEFAULT_WAIT_INTERVAL_MS,
        int $timeoutMs = self::DEFAULT_WAIT_TIMEOUT_MS,
    ): Verification {
        if ($intervalMs < self::MIN_WAIT_INTERVAL_MS) {
            // Silently floor — the server enforces the rate limit and
            // we don't want surprised callers tripping over it.
            $intervalMs = self::MIN_WAIT_INTERVAL_MS;
        }
        if ($timeoutMs <= 0) {
            throw new SyrotpConfigError('wait timeoutMs must be a positive int');
        }

        $deadline = $this->clock->now() + $timeoutMs / 1000.0;
        $intervalSec = $intervalMs / 1000.0;
        while (true) {
            $v = $this->getVerification($verificationId);
            if ($v->status !== VerificationStatus::Pending) {
                return $v;
            }
            $now = $this->clock->now();
            if ($now >= $deadline) {
                throw new SyrotpTimeoutError('waitForVerification deadline expired');
            }
            // Sleep but don't overshoot the deadline.
            $remaining = $deadline - $now;
            $this->clock->sleep(min($intervalSec, $remaining));
        }
    }

    // ----- internals --------------------------------------------------------

    /**
     * @param array<string,mixed>|null $body
     * @return array<string,mixed>
     */
    private function request(string $method, string $path, ?array $body, ?int $maxRetriesOverride): array
    {
        $maxRetries = $maxRetriesOverride ?? $this->retries;

        $transport = function () use ($method, $path, $body): ResponseInterface {
            $options = [];
            if ($body !== null) {
                $options[RequestOptions::JSON] = $body;
            }
            // Trim leading slash so it composes with base_uri's trailing slash.
            $relPath = ltrim($path, '/');
            return $this->http->request($method, $relPath, $options);
        };

        $onResponse = static function (ResponseInterface $res): array {
            $bodyText = (string) $res->getBody();
            $status = $res->getStatusCode();
            if ($status >= 200 && $status < 300) {
                if ($bodyText === '') {
                    return [];
                }
                try {
                    /** @var mixed $parsed */
                    $parsed = json_decode($bodyText, true, 512, JSON_THROW_ON_ERROR);
                } catch (JsonException $e) {
                    throw new SyrotpError(
                        'bad_response',
                        "non-JSON response (status {$status})",
                        $status,
                        null,
                    );
                }
                if (!is_array($parsed)) {
                    throw new SyrotpError(
                        'bad_response',
                        "unexpected JSON shape (status {$status})",
                        $status,
                        null,
                    );
                }
                /** @var array<string,mixed> $parsed */
                return $parsed;
            }
            throw self::errorFromResponse($res, $bodyText);
        };

        return $this->executor->executeWithRetries($transport, $maxRetries, $onResponse);
    }

    private static function errorFromResponse(ResponseInterface $res, string $bodyText): SyrotpError
    {
        $status = $res->getStatusCode();
        $code = "http_{$status}";
        $message = "request failed with status {$status}";
        $requestId = null;

        try {
            /** @var mixed $body */
            $body = $bodyText !== ''
                ? json_decode($bodyText, true, 512, JSON_THROW_ON_ERROR)
                : null;
            if (is_array($body) && isset($body['error']) && is_array($body['error'])) {
                $err = $body['error'];
                $errCode = $err['code'] ?? null;
                $errMsg = $err['message'] ?? null;
                $rid = $err['request_id'] ?? null;
                if (is_string($errCode) && $errCode !== '') {
                    $code = $errCode;
                }
                if (is_string($errMsg) && $errMsg !== '') {
                    $message = $errMsg;
                }
                if (is_string($rid)) {
                    $requestId = $rid;
                }
            }
        } catch (JsonException) {
            $code = 'bad_response';
            $message = "non-JSON response (status {$status})";
        }

        if ($status === 401 || $status === 403) {
            return new SyrotpAuthError($code, $message, $status, $requestId);
        }
        if ($status === 400) {
            return new SyrotpValidationError($code, $message, $status, $requestId);
        }
        if ($status === 429) {
            return new SyrotpRateLimitError(
                $code,
                $message,
                $status,
                $requestId,
                self::parseRetryAfter($res->getHeaderLine('Retry-After')),
            );
        }
        if ($status >= 500 && $status < 600) {
            return new SyrotpServerError($code, $message, $status, $requestId);
        }
        // Other 4xx (404, 409, etc.) — surface as a generic SyrotpError so
        // the caller decides. We deliberately don't lump them into
        // "validation".
        return new SyrotpError($code, $message, $status, $requestId);
    }

    private static function parseRetryAfter(string $value): ?int
    {
        $trimmed = trim($value);
        if ($trimmed === '' || !is_numeric($trimmed)) {
            return null;
        }
        $n = (int) $trimmed;
        return max(0, $n);
    }

    private static function buildUserAgent(?string $suffix): string
    {
        $base = 'syrotp-sdk-php/' . self::VERSION;
        if ($suffix === null || $suffix === '') {
            return $base;
        }
        // Strip CR / LF / NUL so a caller-supplied suffix can't inject
        // additional header lines.
        $clean = trim(preg_replace('/[\r\n\x00]/', '', $suffix) ?? '');
        return $clean !== '' ? "{$base} {$clean}" : $base;
    }

    private function checkVerificationId(string $value): void
    {
        if (preg_match(self::VERIFICATION_ID_RE, $value) !== 1) {
            throw new SyrotpValidationError(
                'validation_error',
                'verificationId must match ^vrf_[A-Za-z0-9]+$',
            );
        }
    }

    private static function hostOnly(string $url): string
    {
        $host = parse_url($url, PHP_URL_HOST);
        return is_string($host) ? strtolower($host) : '';
    }

    private static function isLoopbackOrPrivate(string $url): bool
    {
        $host = self::hostOnly($url);
        if ($host === 'localhost' || $host === '127.0.0.1' || $host === '::1') {
            return true;
        }
        // Crude RFC1918 check; we don't need DNS resolution here.
        if (str_starts_with($host, '10.')
            || str_starts_with($host, '192.168.')
            || str_starts_with($host, '169.254.')
        ) {
            return true;
        }
        if (str_starts_with($host, '172.')) {
            $parts = explode('.', $host);
            if (isset($parts[1]) && is_numeric($parts[1])) {
                $second = (int) $parts[1];
                if ($second >= 16 && $second <= 31) {
                    return true;
                }
            }
        }
        return false;
    }
}
