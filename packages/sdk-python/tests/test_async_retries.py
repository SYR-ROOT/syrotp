"""
Retry policy tests for the async client. Pins the same rules as the
sync `test_retries.py` against `_async_http.aexecute_with_retries`:

  - Retry on: network / 5xx / 429 (with Retry-After honored)
  - Never retry on: 4xx (except 429), validation, auth, config, timeout

Each test monkeypatches `syrotp._async_http.asyncio.sleep` to a no-op
coroutine so we measure the policy without actually waiting.
"""
from __future__ import annotations

import httpx
import pytest

from syrotp import AsyncSyrotpClient
from syrotp.errors import (
    SyrotpAuthError,
    SyrotpRateLimitError,
    SyrotpServerError,
    SyrotpValidationError,
)


async def _fast_sleep(_):
    return None


def _async_client_with(handler, *, retries: int) -> AsyncSyrotpClient:
    return AsyncSyrotpClient(
        base_url="http://syrotp.test",
        api_key="sk_live_x",
        retries=retries,
        transport=httpx.MockTransport(handler),
    )


# ----- retries actually happen ----------------------------------------------


async def test_async_5xx_is_retried_until_success(monkeypatch):
    monkeypatch.setattr("syrotp._async_http.asyncio.sleep", _fast_sleep)
    statuses = iter([503, 503, 200])

    def handler(_: httpx.Request) -> httpx.Response:
        s = next(statuses)
        if s == 200:
            return httpx.Response(
                200,
                json={
                    "id": "vrf_1",
                    "status": "verified",
                    "phone_masked": "+1*",
                    "expires_at": "2026",
                    "created_at": "2026",
                },
            )
        return httpx.Response(s, json={"error": {"code": "down", "message": "no"}})

    async with _async_client_with(handler, retries=3) as client:
        v = await client.get_verification("vrf_1")
    assert v.id == "vrf_1"


async def test_async_5xx_eventually_raises_after_budget_exhausted(monkeypatch):
    monkeypatch.setattr("syrotp._async_http.asyncio.sleep", _fast_sleep)
    calls = {"n": 0}

    def handler(_: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(503, json={"error": {"code": "down", "message": "no"}})

    async with _async_client_with(handler, retries=2) as client:
        with pytest.raises(SyrotpServerError):
            await client.get_verification("vrf_1")
    # 1 initial + 2 retries.
    assert calls["n"] == 3


async def test_async_429_respects_retry_after(monkeypatch):
    """
    With Retry-After: 7 set, the SDK MUST sleep at least 7s before
    retrying. We capture sleep calls instead of waiting.
    """
    sleeps: list[float] = []

    async def capture_sleep(s):
        sleeps.append(s)

    monkeypatch.setattr("syrotp._async_http.asyncio.sleep", capture_sleep)
    statuses = iter([429, 200])

    def handler(_: httpx.Request) -> httpx.Response:
        s = next(statuses)
        if s == 200:
            return httpx.Response(
                200,
                json={
                    "id": "vrf_1",
                    "status": "pending",
                    "phone_masked": "+1*",
                    "expires_at": "2026",
                    "created_at": "2026",
                },
            )
        return httpx.Response(
            429,
            json={"error": {"code": "rate_limited", "message": "slow"}},
            headers={"Retry-After": "7"},
        )

    async with _async_client_with(handler, retries=2) as client:
        await client.get_verification("vrf_1")
    assert any(s >= 7.0 for s in sleeps), f"expected a sleep >= 7s, got {sleeps}"


async def test_async_network_error_is_retried(monkeypatch):
    monkeypatch.setattr("syrotp._async_http.asyncio.sleep", _fast_sleep)
    calls = {"n": 0}

    def handler(_: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        if calls["n"] < 3:
            raise httpx.ConnectError("simulated")
        return httpx.Response(
            200,
            json={
                "id": "vrf_1",
                "status": "verified",
                "phone_masked": "+1*",
                "expires_at": "2026",
                "created_at": "2026",
            },
        )

    async with _async_client_with(handler, retries=3) as client:
        v = await client.get_verification("vrf_1")
    assert v.id == "vrf_1"
    assert calls["n"] == 3


# ----- retries DO NOT happen ------------------------------------------------


async def test_async_400_is_not_retried(monkeypatch):
    monkeypatch.setattr("syrotp._async_http.asyncio.sleep", _fast_sleep)
    calls = {"n": 0}

    def handler(_: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(
            400, json={"error": {"code": "validation_error", "message": "bad"}}
        )

    async with _async_client_with(handler, retries=5) as client:
        with pytest.raises(SyrotpValidationError):
            await client.get_verification("vrf_1")
    assert calls["n"] == 1


async def test_async_401_is_not_retried(monkeypatch):
    monkeypatch.setattr("syrotp._async_http.asyncio.sleep", _fast_sleep)
    calls = {"n": 0}

    def handler(_: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(
            401, json={"error": {"code": "unauthorized", "message": "no"}}
        )

    async with _async_client_with(handler, retries=5) as client:
        with pytest.raises(SyrotpAuthError):
            await client.get_verification("vrf_1")
    assert calls["n"] == 1


async def test_async_zero_retries_means_one_attempt(monkeypatch):
    monkeypatch.setattr("syrotp._async_http.asyncio.sleep", _fast_sleep)
    calls = {"n": 0}

    def handler(_: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(503, json={"error": {"code": "down", "message": "no"}})

    async with _async_client_with(handler, retries=0) as client:
        with pytest.raises(SyrotpServerError):
            await client.get_verification("vrf_1")
    assert calls["n"] == 1


async def test_async_retry_after_handler_present_but_unparseable(monkeypatch):
    """A garbage Retry-After value MUST NOT crash; we still retry with normal backoff."""
    monkeypatch.setattr("syrotp._async_http.asyncio.sleep", _fast_sleep)
    statuses = iter([429, 200])

    def handler(_: httpx.Request) -> httpx.Response:
        s = next(statuses)
        if s == 200:
            return httpx.Response(
                200,
                json={
                    "id": "vrf_1",
                    "status": "pending",
                    "phone_masked": "+1*",
                    "expires_at": "2026",
                    "created_at": "2026",
                },
            )
        return httpx.Response(
            429,
            json={"error": {"code": "rate_limited", "message": "slow"}},
            headers={"Retry-After": "not-a-number"},
        )

    async with _async_client_with(handler, retries=2) as client:
        v = await client.get_verification("vrf_1")
    assert v.id == "vrf_1"


# ----- 429 raises with retry_after on exhaustion ----------------------------


async def test_async_429_raises_with_retry_after_when_budget_exhausted(monkeypatch):
    """
    When retries=0, a single 429 response must surface as
    SyrotpRateLimitError with the parsed retry_after_seconds intact.
    """
    monkeypatch.setattr("syrotp._async_http.asyncio.sleep", _fast_sleep)

    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(
            429,
            json={"error": {"code": "rate_limited", "message": "slow"}},
            headers={"Retry-After": "12"},
        )

    async with _async_client_with(handler, retries=0) as client:
        with pytest.raises(SyrotpRateLimitError) as exc:
            await client.get_verification("vrf_1")
    assert exc.value.retry_after_seconds == 12
