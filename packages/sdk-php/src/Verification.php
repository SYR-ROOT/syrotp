<?php

declare(strict_types=1);

namespace Syrotp\Sdk;

/**
 * A verification record as returned by the server.
 *
 * Wire format is snake_case (matches `openapi.yaml`). The PHP surface
 * is camelCase per `docs/sdk-contract.md` §6.
 *
 * `$extras` collects any field the server returns that this SDK
 * version doesn't know about — a newer server can ship new optional
 * fields without breaking older PHP SDKs.
 */
final class Verification
{
    /**
     * @param array<string,mixed> $extras
     */
    public function __construct(
        public readonly string $id,
        public readonly VerificationStatus $status,
        public readonly string $phoneMasked,
        public readonly string $expiresAt,
        public readonly string $createdAt,
        public readonly ?string $sendTo = null,
        public readonly ?string $message = null,
        public readonly ?string $clientRef = null,
        public readonly ?string $purpose = null,
        public readonly ?string $verifiedAt = null,
        public readonly ?int $attempts = null,
        public readonly array $extras = [],
    ) {
    }

    /**
     * Build from a JSON-decoded server payload.
     *
     * @param array<string,mixed> $data
     */
    public static function fromArray(array $data): self
    {
        $known = [
            'id', 'status', 'phone_masked', 'send_to', 'message',
            'expires_at', 'created_at', 'verified_at',
            'client_ref', 'purpose', 'attempts',
        ];
        $extras = [];
        foreach ($data as $key => $value) {
            if (!in_array($key, $known, true)) {
                $extras[$key] = $value;
            }
        }

        return new self(
            id: self::requireString($data, 'id'),
            status: VerificationStatus::fromString(self::requireString($data, 'status')),
            phoneMasked: self::requireString($data, 'phone_masked'),
            expiresAt: self::requireString($data, 'expires_at'),
            createdAt: self::requireString($data, 'created_at'),
            sendTo: self::optString($data, 'send_to'),
            message: self::optString($data, 'message'),
            clientRef: self::optString($data, 'client_ref'),
            purpose: self::optString($data, 'purpose'),
            verifiedAt: self::optString($data, 'verified_at'),
            attempts: self::optInt($data, 'attempts'),
            extras: $extras,
        );
    }

    /** @param array<string,mixed> $data */
    private static function requireString(array $data, string $key): string
    {
        $value = $data[$key] ?? null;
        return is_string($value) ? $value : '';
    }

    /** @param array<string,mixed> $data */
    private static function optString(array $data, string $key): ?string
    {
        $value = $data[$key] ?? null;
        return is_string($value) ? $value : null;
    }

    /** @param array<string,mixed> $data */
    private static function optInt(array $data, string $key): ?int
    {
        $value = $data[$key] ?? null;
        if (is_int($value)) {
            return $value;
        }
        if (is_numeric($value)) {
            return (int) $value;
        }
        return null;
    }
}
