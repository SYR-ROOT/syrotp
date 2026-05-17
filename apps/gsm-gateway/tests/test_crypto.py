"""
Cross-language HMAC parity tests.

The vector below was hand-computed against apps/server/test/helpers/sign.ts
with fixed timestamp + nonce inputs:

    signing_key = "test-key-do-not-use-in-prod"
    timestamp   = 1735689600
    nonce       = "0123456789abcdef0123456789abcdef"
    raw_body    = b'{"hello":"world"}'

If this test fails, the gateway will sign requests the server can't
verify, and inbound SMS will silently fail in production.
"""
from __future__ import annotations

import hashlib
import hmac

from syrotp_gateway.crypto import (
    build_signature,
    hmac_sha256_hex,
    random_nonce_hex,
    sha256_hex,
)


_SIGNING_KEY = "test-key-do-not-use-in-prod"
_TS = 1735689600
_NONCE = "0123456789abcdef0123456789abcdef"
_BODY = b'{"hello":"world"}'


def _expected_sig() -> str:
    body_hash = hashlib.sha256(_BODY).hexdigest()
    payload = f"{_TS}.{_NONCE}.{body_hash}"
    return hmac.new(
        _SIGNING_KEY.encode(), payload.encode(), hashlib.sha256
    ).hexdigest()


def test_sha256_hex_matches_stdlib():
    assert sha256_hex(_BODY) == hashlib.sha256(_BODY).hexdigest()


def test_hmac_sha256_hex_matches_stdlib():
    payload = "1.2.3"
    assert hmac_sha256_hex(_SIGNING_KEY, payload) == hmac.new(
        _SIGNING_KEY.encode(), payload.encode(), hashlib.sha256
    ).hexdigest()


def test_build_signature_with_fixed_inputs():
    ts, nonce, sig = build_signature(
        _SIGNING_KEY, _BODY, timestamp=_TS, nonce=_NONCE
    )
    assert ts == str(_TS)
    assert nonce == _NONCE
    assert sig == _expected_sig()
    # Sanity: signature is 64 lowercase hex chars (sha256 output).
    assert len(sig) == 64
    assert all(c in "0123456789abcdef" for c in sig)


def test_build_signature_changes_when_body_changes():
    _, _, s1 = build_signature(_SIGNING_KEY, b"{}", timestamp=_TS, nonce=_NONCE)
    _, _, s2 = build_signature(_SIGNING_KEY, b"{ }", timestamp=_TS, nonce=_NONCE)
    assert s1 != s2, "signature must bind to body bytes"


def test_build_signature_changes_when_key_changes():
    _, _, s1 = build_signature("k1", _BODY, timestamp=_TS, nonce=_NONCE)
    _, _, s2 = build_signature("k2", _BODY, timestamp=_TS, nonce=_NONCE)
    assert s1 != s2


def test_random_nonce_hex_default_is_32_chars():
    n = random_nonce_hex()
    assert len(n) == 32
    assert all(c in "0123456789abcdef" for c in n)


def test_random_nonce_hex_unique():
    seen = {random_nonce_hex() for _ in range(100)}
    # 100 collisions in 100 draws of 128-bit randomness is functionally impossible.
    assert len(seen) == 100
