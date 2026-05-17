"""
Public-API tests for SyrotpClient. Uses httpx.MockTransport — no real
server, no network. Each test asserts the request shape we send AND
the response shape we surface.
"""
from __future__ import annotations

import json

import httpx
import pytest

from syrotp import SyrotpClient, Verification, VerificationStatus
from syrotp.errors import (
    SyrotpAuthError,
    SyrotpConfigError,
    SyrotpServerError,
    SyrotpTimeoutError,
    SyrotpValidationError,
)


# ----- constructor validation -----------------------------------------------


def test_constructor_rejects_missing_base_url():
    with pytest.raises(SyrotpConfigError, match="base_url"):
        SyrotpClient(base_url="", api_key="sk_live_x")


def test_constructor_rejects_non_http_base_url():
    with pytest.raises(SyrotpConfigError, match="http"):
        SyrotpClient(base_url="ftp://x", api_key="sk_live_x")


def test_constructor_rejects_missing_api_key():
    with pytest.raises(SyrotpConfigError, match="api_key"):
        SyrotpClient(base_url="http://x", api_key="")


def test_constructor_rejects_zero_timeout():
    with pytest.raises(SyrotpConfigError, match="timeout_ms"):
        SyrotpClient(base_url="http://x", api_key="sk_live_x", timeout_ms=0)


def test_constructor_rejects_negative_retries():
    with pytest.raises(SyrotpConfigError, match="retries"):
        SyrotpClient(base_url="http://x", api_key="sk_live_x", retries=-1)


def test_constructor_strips_trailing_slash():
    c = SyrotpClient(
        base_url="http://syrotp.test/",
        api_key="sk_live_x",
        transport=httpx.MockTransport(lambda r: httpx.Response(200, json={})),
    )
    assert c._base_url == "http://syrotp.test"


def test_user_agent_includes_sdk_version():
    captured: list[str] = []

    def handler(r: httpx.Request) -> httpx.Response:
        captured.append(r.headers.get("user-agent", ""))
        return httpx.Response(200, json={})

    c = SyrotpClient(
        base_url="http://syrotp.test",
        api_key="sk_live_x",
        user_agent="my-app/1.0",
        transport=httpx.MockTransport(handler),
    )
    # Trigger one request via internals.
    c._http.get("http://syrotp.test/x")
    assert captured[0].startswith("syrotp-sdk-py/")
    assert "my-app/1.0" in captured[0]


def test_user_agent_strips_control_chars_from_suffix():
    captured: list[str] = []

    def handler(r: httpx.Request) -> httpx.Response:
        captured.append(r.headers.get("user-agent", ""))
        return httpx.Response(200, json={})

    SyrotpClient(
        base_url="http://syrotp.test",
        api_key="sk_live_x",
        user_agent="evil\r\nX-Injected: yes",
        transport=httpx.MockTransport(handler),
    )._http.get("http://syrotp.test/x")
    ua = captured[0]
    assert "\r" not in ua and "\n" not in ua


# ----- start_verification ---------------------------------------------------


def test_start_verification_happy_path(make_client, fixed_verification):
    captured = {}

    def handler(req: httpx.Request) -> httpx.Response:
        captured["url"] = str(req.url)
        captured["method"] = req.method
        captured["body"] = json.loads(req.content)
        captured["auth"] = req.headers.get("authorization")
        return httpx.Response(201, json=fixed_verification(status="pending"))

    client = make_client(handler)
    v = client.start_verification(phone="+963991234567", purpose="login")
    assert isinstance(v, Verification)
    assert v.status == VerificationStatus.PENDING
    assert v.id == "vrf_01HX"
    assert v.send_to == "+963998887777"
    assert v.message == "VERIFY ABC123"

    assert captured["method"] == "POST"
    assert captured["url"].endswith("/v1/verifications")
    assert captured["body"] == {"phone": "+963991234567", "purpose": "login"}
    assert captured["auth"] == "Bearer sk_live_TESTKEY_DO_NOT_USE"


def test_start_verification_includes_optional_fields(make_client, fixed_verification):
    bodies: list[dict] = []

    def handler(req: httpx.Request) -> httpx.Response:
        bodies.append(json.loads(req.content))
        return httpx.Response(201, json=fixed_verification())

    client = make_client(handler)
    client.start_verification(
        phone="+1", purpose="signup", client_ref="user-42", locale="en-US"
    )
    assert bodies[0] == {
        "phone": "+1",
        "purpose": "signup",
        "client_ref": "user-42",
        "locale": "en-US",
    }


def test_start_verification_omits_unset_optional_fields(make_client, fixed_verification):
    bodies: list[dict] = []

    def handler(req: httpx.Request) -> httpx.Response:
        bodies.append(json.loads(req.content))
        return httpx.Response(201, json=fixed_verification())

    make_client(handler).start_verification(phone="+1", purpose="login")
    assert "client_ref" not in bodies[0]
    assert "locale" not in bodies[0]


def test_start_verification_rejects_empty_phone(make_client, fixed_verification):
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(201, json=fixed_verification())

    with pytest.raises(SyrotpValidationError, match="phone"):
        make_client(handler).start_verification(phone="", purpose="login")


# ----- get_verification -----------------------------------------------------


def test_get_verification_happy_path(make_client, fixed_verification):
    def handler(req: httpx.Request) -> httpx.Response:
        assert req.method == "GET"
        assert str(req.url).endswith("/v1/verifications/vrf_01HX")
        return httpx.Response(200, json=fixed_verification(status="verified", verified_at="2026-05-02T17:01:00.000Z"))

    v = make_client(handler).get_verification("vrf_01HX")
    assert v.status == VerificationStatus.VERIFIED
    assert v.verified_at == "2026-05-02T17:01:00.000Z"


def test_get_verification_rejects_bad_id(make_client, fixed_verification):
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=fixed_verification())

    with pytest.raises(SyrotpValidationError, match="verification_id"):
        make_client(handler).get_verification("not-a-vrf-id")


# ----- cancel_verification --------------------------------------------------


def test_cancel_verification_happy_path(make_client, fixed_verification):
    def handler(req: httpx.Request) -> httpx.Response:
        assert req.method == "POST"
        assert str(req.url).endswith("/v1/verifications/vrf_01HX/cancel")
        return httpx.Response(200, json=fixed_verification(status="cancelled"))

    v = make_client(handler).cancel_verification("vrf_01HX")
    assert v.status == VerificationStatus.CANCELLED


def test_cancel_verification_does_not_storm_retries():
    """
    sdk-generation.md §7: cancel MUST NOT retry more than once on
    transient failure even if `retries` is high.
    """
    calls = {"n": 0}

    def handler(_: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(503, json={"error": {"code": "down", "message": "no"}})

    client = SyrotpClient(
        base_url="http://syrotp.test",
        api_key="sk_live_x",
        retries=10,
        transport=httpx.MockTransport(handler),
    )
    with pytest.raises(SyrotpServerError):
        client.cancel_verification("vrf_01HX")
    # 1 initial attempt + at most 1 retry = 2.
    assert calls["n"] <= 2


# ----- wait_for_verification -----------------------------------------------


def test_wait_for_verification_returns_when_terminal(monkeypatch, make_client, fixed_verification):
    statuses = iter(["pending", "pending", "verified"])

    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=fixed_verification(status=next(statuses)))

    # Avoid actually sleeping during tests.
    monkeypatch.setattr("syrotp.client.time.sleep", lambda _: None)

    v = make_client(handler).wait_for_verification("vrf_01HX", interval_ms=2000, timeout_ms=10_000)
    assert v.status == VerificationStatus.VERIFIED


def test_wait_for_verification_raises_on_deadline(monkeypatch, make_client, fixed_verification):
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=fixed_verification(status="pending"))

    # Make the monotonic clock jump by 100s on every read so the
    # deadline trips immediately without real sleeping.
    fake_now = [0.0]

    def fake_monotonic() -> float:
        fake_now[0] += 100.0
        return fake_now[0]

    monkeypatch.setattr("syrotp.client.time.monotonic", fake_monotonic)
    monkeypatch.setattr("syrotp.client.time.sleep", lambda _: None)

    with pytest.raises(SyrotpTimeoutError):
        make_client(handler).wait_for_verification("vrf_01HX", interval_ms=2000, timeout_ms=1000)


# ----- error mapping --------------------------------------------------------


def test_401_raises_auth_error(make_client):
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(
            401,
            json={"error": {"code": "unauthorized", "message": "missing creds", "request_id": "req_xyz"}},
        )

    with pytest.raises(SyrotpAuthError) as exc:
        make_client(handler).start_verification(phone="+1", purpose="x")
    assert exc.value.http_status == 401
    assert exc.value.code == "unauthorized"
    assert exc.value.request_id == "req_xyz"


def test_400_raises_validation_error(make_client):
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(400, json={"error": {"code": "validation_error", "message": "bad phone"}})

    with pytest.raises(SyrotpValidationError):
        make_client(handler).start_verification(phone="x", purpose="x")


def test_500_raises_server_error(make_client):
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(500, json={"error": {"code": "internal_error", "message": "boom"}})

    with pytest.raises(SyrotpServerError):
        make_client(handler).start_verification(phone="+1", purpose="x")


# ----- forward-compat unknown statuses --------------------------------------


def test_unknown_status_maps_to_unknown(make_client, fixed_verification):
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(201, json=fixed_verification(status="quantum_uncertain"))

    v = make_client(handler).start_verification(phone="+1", purpose="x")
    assert v.status == VerificationStatus.UNKNOWN


def test_unknown_response_fields_preserved_in_extras(make_client, fixed_verification):
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(201, json={**fixed_verification(), "future_field": 42})

    v = make_client(handler).start_verification(phone="+1", purpose="x")
    assert v.extras == {"future_field": 42}
