"""
Public-API tests for AsyncSyrotpClient. Mirror the sync test file so a
regression in either client surface fails the same assertion in the
matching test.

`asyncio_mode = "auto"` in pyproject.toml means `async def test_*`
runs as an asyncio test without any decorator.
"""
from __future__ import annotations

import json

import httpx
import pytest

from syrotp import AsyncSyrotpClient, Verification, VerificationStatus
from syrotp.errors import (
    SyrotpAuthError,
    SyrotpConfigError,
    SyrotpServerError,
    SyrotpTimeoutError,
    SyrotpValidationError,
)


# ----- constructor validation (sync — no I/O) --------------------------------


def test_async_constructor_rejects_missing_base_url():
    with pytest.raises(SyrotpConfigError, match="base_url"):
        AsyncSyrotpClient(base_url="", api_key="sk_live_x")


def test_async_constructor_rejects_non_http_base_url():
    with pytest.raises(SyrotpConfigError, match="http"):
        AsyncSyrotpClient(base_url="ftp://x", api_key="sk_live_x")


def test_async_constructor_rejects_missing_api_key():
    with pytest.raises(SyrotpConfigError, match="api_key"):
        AsyncSyrotpClient(base_url="http://x", api_key="")


def test_async_constructor_rejects_zero_timeout():
    with pytest.raises(SyrotpConfigError, match="timeout_ms"):
        AsyncSyrotpClient(base_url="http://x", api_key="sk_live_x", timeout_ms=0)


def test_async_constructor_rejects_negative_retries():
    with pytest.raises(SyrotpConfigError, match="retries"):
        AsyncSyrotpClient(base_url="http://x", api_key="sk_live_x", retries=-1)


def test_async_constructor_strips_trailing_slash():
    c = AsyncSyrotpClient(
        base_url="http://syrotp.test/",
        api_key="sk_live_x",
        transport=httpx.MockTransport(lambda r: httpx.Response(200, json={})),
    )
    assert c._base_url == "http://syrotp.test"


# ----- start_verification ----------------------------------------------------


async def test_async_start_verification_happy_path(make_async_client, fixed_verification):
    captured = {}

    def handler(req: httpx.Request) -> httpx.Response:
        captured["url"] = str(req.url)
        captured["method"] = req.method
        captured["body"] = json.loads(req.content)
        captured["auth"] = req.headers.get("authorization")
        return httpx.Response(201, json=fixed_verification(status="pending"))

    async with make_async_client(handler) as client:
        v = await client.start_verification(phone="+963991234567", purpose="login")

    assert isinstance(v, Verification)
    assert v.status == VerificationStatus.PENDING
    assert v.id == "vrf_01HX"
    assert v.send_to == "+963998887777"
    assert v.message == "VERIFY ABC123"

    assert captured["method"] == "POST"
    assert captured["url"].endswith("/v1/verifications")
    assert captured["body"] == {"phone": "+963991234567", "purpose": "login"}
    assert captured["auth"] == "Bearer sk_live_TESTKEY_DO_NOT_USE"


async def test_async_start_verification_includes_optional_fields(
    make_async_client, fixed_verification
):
    bodies: list[dict] = []

    def handler(req: httpx.Request) -> httpx.Response:
        bodies.append(json.loads(req.content))
        return httpx.Response(201, json=fixed_verification())

    async with make_async_client(handler) as client:
        await client.start_verification(
            phone="+1", purpose="signup", client_ref="user-42", locale="en-US"
        )
    assert bodies[0] == {
        "phone": "+1",
        "purpose": "signup",
        "client_ref": "user-42",
        "locale": "en-US",
    }


async def test_async_start_verification_omits_unset_optional_fields(
    make_async_client, fixed_verification
):
    bodies: list[dict] = []

    def handler(req: httpx.Request) -> httpx.Response:
        bodies.append(json.loads(req.content))
        return httpx.Response(201, json=fixed_verification())

    async with make_async_client(handler) as client:
        await client.start_verification(phone="+1", purpose="login")
    assert "client_ref" not in bodies[0]
    assert "locale" not in bodies[0]


async def test_async_start_verification_rejects_empty_phone(
    make_async_client, fixed_verification
):
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(201, json=fixed_verification())

    async with make_async_client(handler) as client:
        with pytest.raises(SyrotpValidationError, match="phone"):
            await client.start_verification(phone="", purpose="login")


# ----- get_verification ------------------------------------------------------


async def test_async_get_verification_happy_path(make_async_client, fixed_verification):
    def handler(req: httpx.Request) -> httpx.Response:
        assert req.method == "GET"
        assert str(req.url).endswith("/v1/verifications/vrf_01HX")
        return httpx.Response(
            200,
            json=fixed_verification(status="verified", verified_at="2026-05-02T17:01:00.000Z"),
        )

    async with make_async_client(handler) as client:
        v = await client.get_verification("vrf_01HX")
    assert v.status == VerificationStatus.VERIFIED
    assert v.verified_at == "2026-05-02T17:01:00.000Z"


async def test_async_get_verification_rejects_bad_id(make_async_client, fixed_verification):
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=fixed_verification())

    async with make_async_client(handler) as client:
        with pytest.raises(SyrotpValidationError, match="verification_id"):
            await client.get_verification("not-a-vrf-id")


# ----- cancel_verification ---------------------------------------------------


async def test_async_cancel_verification_happy_path(make_async_client, fixed_verification):
    def handler(req: httpx.Request) -> httpx.Response:
        assert req.method == "POST"
        assert str(req.url).endswith("/v1/verifications/vrf_01HX/cancel")
        return httpx.Response(200, json=fixed_verification(status="cancelled"))

    async with make_async_client(handler) as client:
        v = await client.cancel_verification("vrf_01HX")
    assert v.status == VerificationStatus.CANCELLED


async def test_async_cancel_verification_does_not_storm_retries(monkeypatch):
    """
    sdk-generation.md §7: cancel MUST NOT retry more than once on
    transient failure even if `retries` is high.
    """
    calls = {"n": 0}

    def handler(_: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(503, json={"error": {"code": "down", "message": "no"}})

    async def fast_sleep(_):
        return None

    monkeypatch.setattr("syrotp._async_http.asyncio.sleep", fast_sleep)

    async with AsyncSyrotpClient(
        base_url="http://syrotp.test",
        api_key="sk_live_x",
        retries=10,
        transport=httpx.MockTransport(handler),
    ) as client:
        with pytest.raises(SyrotpServerError):
            await client.cancel_verification("vrf_01HX")
    # 1 initial attempt + at most 1 retry = 2.
    assert calls["n"] <= 2


# ----- wait_for_verification ------------------------------------------------


async def test_async_wait_for_verification_returns_when_terminal(
    monkeypatch, make_async_client, fixed_verification
):
    statuses = iter(["pending", "pending", "verified"])

    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=fixed_verification(status=next(statuses)))

    async def fast_sleep(_):
        return None

    monkeypatch.setattr("syrotp.async_client.asyncio.sleep", fast_sleep)

    async with make_async_client(handler) as client:
        v = await client.wait_for_verification(
            "vrf_01HX", interval_ms=2000, timeout_ms=10_000
        )
    assert v.status == VerificationStatus.VERIFIED


async def test_async_wait_for_verification_raises_on_deadline(
    monkeypatch, make_async_client, fixed_verification
):
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=fixed_verification(status="pending"))

    # Substitute a fake loop whose `time()` jumps 100s on every read so
    # the deadline trips immediately. We don't replace the actual
    # running loop — pytest-asyncio still drives real coroutines. We
    # only swap what `wait_for_verification` reaches for when it asks
    # "what time is it now?".
    class _FakeLoop:
        _t = 0.0

        def time(self) -> float:
            type(self)._t += 100.0
            return type(self)._t

    async def fast_sleep(_):
        return None

    monkeypatch.setattr("syrotp.async_client.asyncio.get_event_loop", lambda: _FakeLoop())
    monkeypatch.setattr("syrotp.async_client.asyncio.sleep", fast_sleep)

    async with make_async_client(handler) as client:
        with pytest.raises(SyrotpTimeoutError):
            await client.wait_for_verification(
                "vrf_01HX", interval_ms=2000, timeout_ms=1000
            )


# ----- error mapping --------------------------------------------------------


async def test_async_401_raises_auth_error(make_async_client):
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(
            401,
            json={
                "error": {
                    "code": "unauthorized",
                    "message": "missing creds",
                    "request_id": "req_xyz",
                }
            },
        )

    async with make_async_client(handler) as client:
        with pytest.raises(SyrotpAuthError) as exc:
            await client.start_verification(phone="+1", purpose="x")
    assert exc.value.http_status == 401
    assert exc.value.code == "unauthorized"
    assert exc.value.request_id == "req_xyz"


async def test_async_400_raises_validation_error(make_async_client):
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(
            400, json={"error": {"code": "validation_error", "message": "bad phone"}}
        )

    async with make_async_client(handler) as client:
        with pytest.raises(SyrotpValidationError):
            await client.start_verification(phone="x", purpose="x")


async def test_async_500_raises_server_error(make_async_client):
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(
            500, json={"error": {"code": "internal_error", "message": "boom"}}
        )

    async with make_async_client(handler) as client:
        with pytest.raises(SyrotpServerError):
            await client.start_verification(phone="+1", purpose="x")


# ----- forward-compat unknown statuses --------------------------------------


async def test_async_unknown_status_maps_to_unknown(
    make_async_client, fixed_verification
):
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(201, json=fixed_verification(status="quantum_uncertain"))

    async with make_async_client(handler) as client:
        v = await client.start_verification(phone="+1", purpose="x")
    assert v.status == VerificationStatus.UNKNOWN


async def test_async_unknown_response_fields_preserved_in_extras(
    make_async_client, fixed_verification
):
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(201, json={**fixed_verification(), "future_field": 42})

    async with make_async_client(handler) as client:
        v = await client.start_verification(phone="+1", purpose="x")
    assert v.extras == {"future_field": 42}
