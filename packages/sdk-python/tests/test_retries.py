"""
Retry policy tests. Pins the rules from sdk-generation.md §7:

  - Retry on: network / 5xx / 429 (with Retry-After honored)
  - Never retry on: 4xx (except 429), validation, auth, config, timeout
"""
from __future__ import annotations

import httpx
import pytest

from syrotp import SyrotpClient
from syrotp.errors import (
    SyrotpAuthError,
    SyrotpServerError,
    SyrotpRateLimitError,
    SyrotpValidationError,
)


def _client_with(handler, *, retries: int) -> SyrotpClient:
    return SyrotpClient(
        base_url="http://syrotp.test",
        api_key="sk_live_x",
        retries=retries,
        transport=httpx.MockTransport(handler),
    )


# ----- retries actually happen ----------------------------------------------


def test_5xx_is_retried_until_success(monkeypatch):
    monkeypatch.setattr("syrotp._http.time.sleep", lambda _: None)
    statuses = iter([503, 503, 200])

    def handler(_: httpx.Request) -> httpx.Response:
        s = next(statuses)
        if s == 200:
            return httpx.Response(200, json={
                "id": "vrf_1", "status": "verified", "phone_masked": "+1*",
                "expires_at": "2026", "created_at": "2026",
            })
        return httpx.Response(s, json={"error": {"code": "down", "message": "no"}})

    v = _client_with(handler, retries=3).get_verification("vrf_1")
    assert v.id == "vrf_1"


def test_5xx_eventually_raises_after_budget_exhausted(monkeypatch):
    monkeypatch.setattr("syrotp._http.time.sleep", lambda _: None)
    calls = {"n": 0}

    def handler(_: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(503, json={"error": {"code": "down", "message": "no"}})

    with pytest.raises(SyrotpServerError):
        _client_with(handler, retries=2).get_verification("vrf_1")
    # 1 initial + 2 retries.
    assert calls["n"] == 3


def test_429_respects_retry_after(monkeypatch):
    """
    With Retry-After: 7 set, the SDK MUST sleep at least 7s before
    retrying. We capture sleep calls instead of waiting.
    """
    sleeps: list[float] = []
    monkeypatch.setattr("syrotp._http.time.sleep", lambda s: sleeps.append(s))
    statuses = iter([429, 200])

    def handler(_: httpx.Request) -> httpx.Response:
        s = next(statuses)
        if s == 200:
            return httpx.Response(200, json={
                "id": "vrf_1", "status": "pending", "phone_masked": "+1*",
                "expires_at": "2026", "created_at": "2026",
            })
        return httpx.Response(
            429,
            json={"error": {"code": "rate_limited", "message": "slow"}},
            headers={"Retry-After": "7"},
        )

    _client_with(handler, retries=2).get_verification("vrf_1")
    assert any(s >= 7.0 for s in sleeps), f"expected a sleep >= 7s, got {sleeps}"


def test_network_error_is_retried(monkeypatch):
    monkeypatch.setattr("syrotp._http.time.sleep", lambda _: None)
    calls = {"n": 0}

    def handler(_: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        if calls["n"] < 3:
            raise httpx.ConnectError("simulated")
        return httpx.Response(200, json={
            "id": "vrf_1", "status": "verified", "phone_masked": "+1*",
            "expires_at": "2026", "created_at": "2026",
        })

    v = _client_with(handler, retries=3).get_verification("vrf_1")
    assert v.id == "vrf_1"
    assert calls["n"] == 3


# ----- retries DO NOT happen ------------------------------------------------


def test_400_is_not_retried(monkeypatch):
    monkeypatch.setattr("syrotp._http.time.sleep", lambda _: None)
    calls = {"n": 0}

    def handler(_: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(400, json={"error": {"code": "validation_error", "message": "bad"}})

    with pytest.raises(SyrotpValidationError):
        _client_with(handler, retries=5).get_verification("vrf_1")
    assert calls["n"] == 1


def test_401_is_not_retried(monkeypatch):
    monkeypatch.setattr("syrotp._http.time.sleep", lambda _: None)
    calls = {"n": 0}

    def handler(_: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(401, json={"error": {"code": "unauthorized", "message": "no"}})

    with pytest.raises(SyrotpAuthError):
        _client_with(handler, retries=5).get_verification("vrf_1")
    assert calls["n"] == 1


def test_zero_retries_means_one_attempt(monkeypatch):
    monkeypatch.setattr("syrotp._http.time.sleep", lambda _: None)
    calls = {"n": 0}

    def handler(_: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(503, json={"error": {"code": "down", "message": "no"}})

    with pytest.raises(SyrotpServerError):
        _client_with(handler, retries=0).get_verification("vrf_1")
    assert calls["n"] == 1


def test_retry_after_handler_present_but_unparseable(monkeypatch):
    """A garbage Retry-After value MUST NOT crash; we still retry with normal backoff."""
    monkeypatch.setattr("syrotp._http.time.sleep", lambda _: None)
    statuses = iter([429, 200])

    def handler(_: httpx.Request) -> httpx.Response:
        s = next(statuses)
        if s == 200:
            return httpx.Response(200, json={
                "id": "vrf_1", "status": "pending", "phone_masked": "+1*",
                "expires_at": "2026", "created_at": "2026",
            })
        return httpx.Response(
            429,
            json={"error": {"code": "rate_limited", "message": "slow"}},
            headers={"Retry-After": "not-a-number"},
        )

    v = _client_with(handler, retries=2).get_verification("vrf_1")
    assert v.id == "vrf_1"
