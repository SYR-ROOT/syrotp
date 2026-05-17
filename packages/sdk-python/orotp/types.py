"""
Public data shapes. Mirror the OpenAPI schemas 1:1 — fields keep their
wire names so they round-trip through the SDK without surprise.

`VerificationStatus` includes a forward-compat `UNKNOWN` member so an
older SDK keeps working when a newer server adds a status value.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Optional


class VerificationStatus(str, Enum):
    """The five known statuses + an UNKNOWN forward-compat member.

    Subclassing `str` lets the enum value compare equal to the raw
    server string (`status == "pending"` is True), so application code
    that already had a `== "pending"` check keeps working.
    """

    PENDING = "pending"
    VERIFIED = "verified"
    EXPIRED = "expired"
    CANCELLED = "cancelled"
    FAILED = "failed"
    UNKNOWN = "unknown"

    @classmethod
    def _missing_(cls, value: object) -> "VerificationStatus":
        # Anything we don't recognize collapses to UNKNOWN. Crucial for
        # version-skew compat — an older SDK + newer server with new
        # status values must NOT crash. See sdk-versioning.md §4.
        return cls.UNKNOWN


@dataclass
class Verification:
    """A verification record as returned by the server.

    Field names track the OpenAPI schema 1:1 (snake_case on the wire,
    snake_case in Python). `extras` collects any field the server
    returns that this SDK version doesn't know about — a newer server
    can ship new optional fields without breaking older SDKs.
    """

    id: str
    status: VerificationStatus
    phone_masked: str
    expires_at: str
    created_at: str
    send_to: Optional[str] = None
    message: Optional[str] = None
    client_ref: Optional[str] = None
    purpose: Optional[str] = None
    verified_at: Optional[str] = None
    attempts: Optional[int] = None
    extras: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Verification":
        # Pull the known fields; everything else stays in `extras` so
        # nothing is silently dropped.
        known = {
            "id", "status", "phone_masked", "expires_at", "created_at",
            "send_to", "message", "client_ref", "purpose", "verified_at",
            "attempts",
        }
        extras = {k: v for k, v in data.items() if k not in known}
        return cls(
            id=data["id"],
            status=VerificationStatus(data["status"]),
            phone_masked=data["phone_masked"],
            expires_at=data["expires_at"],
            created_at=data["created_at"],
            send_to=data.get("send_to"),
            message=data.get("message"),
            client_ref=data.get("client_ref"),
            purpose=data.get("purpose"),
            verified_at=data.get("verified_at"),
            attempts=data.get("attempts"),
            extras=extras,
        )


__all__ = ["Verification", "VerificationStatus"]
