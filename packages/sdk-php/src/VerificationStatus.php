<?php

declare(strict_types=1);

namespace Syrotp\Sdk;

/**
 * Five known statuses + an `Unknown` forward-compat case.
 *
 * Use {@see VerificationStatus::fromString()} to parse a server value:
 * unknown statuses MUST collapse to `Unknown`, not crash. Crucial for
 * version-skew compat — an older SDK + newer server with new status
 * values MUST keep working.
 */
enum VerificationStatus: string
{
    case Pending = 'pending';
    case Verified = 'verified';
    case Expired = 'expired';
    case Cancelled = 'cancelled';
    case Failed = 'failed';
    case Unknown = 'unknown';

    /**
     * Parse a wire status into the enum. Anything not in the five
     * known values collapses to `Unknown`.
     */
    public static function fromString(string $value): self
    {
        return self::tryFrom($value) ?? self::Unknown;
    }
}
