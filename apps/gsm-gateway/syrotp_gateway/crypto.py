"""
HMAC signing for SYROTP gateway requests.

Signature scheme — MUST match apps/server/src/services/hmac.ts exactly:

    payload   = "<unix-seconds>.<nonce>.<sha256(rawBody)>"
    signature = HMAC-SHA256(signing_key, payload)  hex

Where:
    - unix-seconds is an integer string of the request's send time
    - nonce is 32 lowercase hex chars (16 random bytes)
    - sha256(rawBody) is the lowercase hex digest of the request body bytes
    - signing_key is the per-receiver value handed out by `syrotp bootstrap`

The server enforces a +-N second skew window and a one-time nonce check,
so re-signing with a wall-clock that drifts will be rejected.
"""

from __future__ import annotations

import hashlib
import hmac
import secrets
import time


def random_nonce_hex(byte_length: int = 16) -> str:
    """Return a fresh hex nonce. 16 random bytes → 32 hex chars."""
    return secrets.token_hex(byte_length)


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def hmac_sha256_hex(key: str, payload: str) -> str:
    return hmac.new(
        key.encode("utf-8"),
        payload.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()


def build_signature(
    signing_key: str,
    raw_body: bytes,
    *,
    timestamp: int | None = None,
    nonce: str | None = None,
) -> tuple[str, str, str]:
    """
    Return (timestamp, nonce, signature) for a signed request.

    Body bytes are hashed in; the caller MUST send those exact bytes as
    the HTTP body or the server will reject the signature.
    """
    ts = str(timestamp if timestamp is not None else int(time.time()))
    n = nonce if nonce is not None else random_nonce_hex(16)
    body_hash = sha256_hex(raw_body)
    payload = f"{ts}.{n}.{body_hash}"
    sig = hmac_sha256_hex(signing_key, payload)
    return ts, n, sig
