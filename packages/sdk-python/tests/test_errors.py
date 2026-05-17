"""
Error class tests. Two things to pin:
  1. The seven typed classes exist and are catchable as their base.
  2. str/repr never leak credentials.
"""
from __future__ import annotations

from syrotp.errors import (
    SyrotpAuthError,
    SyrotpConfigError,
    SyrotpError,
    SyrotpNetworkError,
    SyrotpRateLimitError,
    SyrotpServerError,
    SyrotpTimeoutError,
    SyrotpValidationError,
)


_ALL = (
    SyrotpConfigError,
    SyrotpAuthError,
    SyrotpValidationError,
    SyrotpRateLimitError,
    SyrotpNetworkError,
    SyrotpServerError,
    SyrotpTimeoutError,
)


def test_all_seven_inherit_from_base():
    for cls in _ALL:
        assert issubclass(cls, SyrotpError), f"{cls} must inherit from SyrotpError"


def test_each_error_has_the_required_attributes():
    for cls in _ALL:
        if cls is SyrotpConfigError:
            err = cls("x")
        elif cls is SyrotpRateLimitError:
            err = cls("rate_limited", "slow down", retry_after_seconds=12)
        elif cls is SyrotpTimeoutError:
            err = cls("timed out")
        else:
            err = cls("code", "msg", http_status=400, request_id="req_1")
        assert hasattr(err, "code")
        assert hasattr(err, "message")
        assert hasattr(err, "http_status")
        assert hasattr(err, "request_id")


def test_rate_limit_error_carries_retry_after():
    err = SyrotpRateLimitError("rate_limited", "slow down", retry_after_seconds=42)
    assert err.retry_after_seconds == 42
    assert err.http_status == 429


def test_str_includes_code_and_request_id():
    err = SyrotpAuthError("unauthorized", "missing creds", http_status=401, request_id="req_xyz")
    rendered = str(err)
    assert "unauthorized" in rendered
    assert "missing creds" in rendered
    assert "req_xyz" in rendered


def test_str_omits_request_id_when_absent():
    err = SyrotpServerError("boom", "internal error")
    rendered = str(err)
    assert "request_id" not in rendered


def test_repr_does_not_leak_extra_kwargs():
    """
    repr(err) must include the standard attributes only — no ad-hoc
    "request body" or "headers" snapshots that could carry secrets.
    """
    err = SyrotpAuthError("unauthorized", "missing creds", http_status=401, request_id="req_xyz")
    r = repr(err)
    # Only the four documented attributes show up.
    assert r.startswith("SyrotpAuthError(")
    assert "code=" in r
    assert "message=" in r
    assert "http_status=" in r
    assert "request_id=" in r
    # No "headers", no "body", no "api_key" leaking.
    assert "api_key" not in r.lower()
    assert "authorization" not in r.lower()
