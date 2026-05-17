"""
HTTP client tests using httpx's MockTransport — no network, no server.
We assert that the bytes hashed for the signature equal the bytes sent
on the wire, because if those drift the server will 401 every request.
"""
from __future__ import annotations

import hashlib
import hmac
import json

import httpx
import pytest

from syrotp_gateway.client import SyrotpClient


_RECEIVER = "rcv_TEST"
_KEY = "test-key-do-not-use-in-prod"


def _make_client(transport: httpx.MockTransport) -> SyrotpClient:
    c = SyrotpClient(
        base_url="http://syrotp.test",
        receiver_id=_RECEIVER,
        signing_key=_KEY,
    )
    # Replace the underlying httpx client with one bound to the mock transport.
    c._http.close()
    c._http = httpx.Client(transport=transport, headers=c._http.headers)
    return c


def test_client_rejects_bad_receiver_id():
    with pytest.raises(ValueError, match="rcv_"):
        SyrotpClient("http://x", "not-a-rcv", _KEY)


def test_client_rejects_empty_signing_key():
    with pytest.raises(ValueError):
        SyrotpClient("http://x", "rcv_a", "")


def test_post_inbound_signs_body_bytes_correctly():
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        captured["body"] = request.content
        captured["headers"] = dict(request.headers)
        return httpx.Response(202, json={"accepted": True, "matched": True})

    client = _make_client(httpx.MockTransport(handler))
    res = client.post_inbound(
        from_="+963991111111",
        to="+963998887777",
        body="VERIFY ABC123",
        received_at_ms=1735689600000,
        idempotency_key="gsm:rcv_TEST:1:1:111111",
    )
    assert res.status == 202
    assert res.ok is True

    # 1. URL went to /v1/inbound/sms.
    assert captured["url"].endswith("/v1/inbound/sms")
    # 2. All four signature headers were attached.
    h = captured["headers"]
    assert h["x-syrotp-receiver"] == _RECEIVER
    assert "x-syrotp-timestamp" in h
    assert "x-syrotp-nonce" in h
    assert "x-syrotp-signature" in h
    # 3. The signature actually matches the bytes we sent.
    body_hash = hashlib.sha256(captured["body"]).hexdigest()
    payload = f'{h["x-syrotp-timestamp"]}.{h["x-syrotp-nonce"]}.{body_hash}'
    expected = hmac.new(_KEY.encode(), payload.encode(), hashlib.sha256).hexdigest()
    assert h["x-syrotp-signature"] == expected, (
        "signature must be over the bytes actually sent on the wire"
    )
    # 4. Body parses as JSON with the expected fields.
    parsed = json.loads(captured["body"])
    assert parsed["from"] == "+963991111111"
    assert parsed["to"] == "+963998887777"
    assert parsed["body"] == "VERIFY ABC123"
    assert parsed["received_at"].endswith("Z")
    assert parsed["idempotency_key"] == "gsm:rcv_TEST:1:1:111111"


def test_post_inbound_includes_sim_slot_only_when_provided():
    captured: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(json.loads(request.content))
        return httpx.Response(202, json={"accepted": True})

    client = _make_client(httpx.MockTransport(handler))
    client.post_inbound(
        from_="+1", to="+2", body="x", received_at_ms=0,
        idempotency_key="k1",
    )
    client.post_inbound(
        from_="+1", to="+2", body="x", received_at_ms=0,
        idempotency_key="k2", sim_slot=1,
    )
    assert "sim_slot" not in captured[0]
    assert captured[1]["sim_slot"] == 1


def test_heartbeat_targets_correct_path():
    captured_url: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured_url.append(str(request.url))
        return httpx.Response(200, json={"ok": True})

    client = _make_client(httpx.MockTransport(handler))
    client.heartbeat(queue_depth=3, sim_signal_dbm=-77, battery_percent=82)
    assert captured_url[0].endswith(f"/v1/receivers/{_RECEIVER}/heartbeat")


def test_status_codes_propagate():
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(409, json={"accepted": True, "matched": False, "reason": "duplicate"})

    client = _make_client(httpx.MockTransport(handler))
    res = client.post_inbound(
        from_="+1", to="+2", body="x", received_at_ms=0, idempotency_key="k",
    )
    assert res.status == 409
    assert res.ok is False  # 409 is non-2xx; worker decides what to do with it
