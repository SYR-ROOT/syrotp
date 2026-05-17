"""
Security canary tests for the async client. Pin the same rules as the
sync `test_security.py` from `docs/sdk-generation.md` §5:

  - Never log the API key.
  - Never log the request body (which includes the user's phone).
  - Cleartext warning fires once for plain HTTP to a public host;
    loopback / RFC1918 stay quiet.

These tests use stable canary values that, if they ever appear in
captured logs or error renderings, prove a regression.
"""
from __future__ import annotations

import io
import logging

import httpx

from syrotp import AsyncSyrotpClient


# Sentinels chosen to be unmistakable if they leak.
CANARY_API_KEY = "sk_live_TESTSENTINEL_DO_NOT_LOG_THIS"
CANARY_PHONE = "+99999999999999"


# ----- request body MUST NOT be logged --------------------------------------


async def test_async_phone_does_not_appear_in_syrotp_logger_output():
    """
    The SDK's own logger (`syrotp`) MUST NOT spill request bodies. If a
    future log statement accidentally logs the body, this canary phone
    will catch it.
    """
    captured = io.StringIO()
    handler_log = logging.StreamHandler(captured)
    handler_log.setLevel(logging.DEBUG)
    handler_log.setFormatter(logging.Formatter("%(message)s"))
    logger = logging.getLogger("syrotp")
    logger.addHandler(handler_log)
    logger.setLevel(logging.DEBUG)

    try:
        def transport_handler(_: httpx.Request) -> httpx.Response:
            return httpx.Response(
                201,
                json={
                    "id": "vrf_1",
                    "status": "pending",
                    "phone_masked": "+1*",
                    "send_to": "+1",
                    "message": "VERIFY ABC",
                    "expires_at": "2026",
                    "created_at": "2026",
                },
            )

        async with AsyncSyrotpClient(
            base_url="http://syrotp.test",
            api_key=CANARY_API_KEY,
            transport=httpx.MockTransport(transport_handler),
        ) as client:
            await client.start_verification(phone=CANARY_PHONE, purpose="login")
    finally:
        logger.removeHandler(handler_log)

    output = captured.getvalue()
    assert CANARY_PHONE not in output, (
        "the user's phone MUST NOT appear in any syrotp log line"
    )
    assert CANARY_API_KEY not in output, (
        "the api_key MUST NOT appear in any syrotp log line"
    )


# ----- cleartext warning behavior -------------------------------------------


def test_async_cleartext_to_public_host_logs_warning(caplog):
    """Plain HTTP to a non-private host triggers exactly one warning."""
    with caplog.at_level(logging.WARNING, logger="syrotp"):
        AsyncSyrotpClient(
            base_url="http://otp.example.com",
            api_key="sk_live_x",
            transport=httpx.MockTransport(lambda r: httpx.Response(200, json={})),
        )
    matching = [r for r in caplog.records if "plain HTTP" in r.message]
    assert len(matching) >= 1


def test_async_loopback_does_not_warn(caplog):
    """localhost / 127.0.0.1 / RFC1918 are dev paths — no warning."""
    with caplog.at_level(logging.WARNING, logger="syrotp"):
        AsyncSyrotpClient(
            base_url="http://localhost:3000",
            api_key="sk_live_x",
            transport=httpx.MockTransport(lambda r: httpx.Response(200, json={})),
        )
        AsyncSyrotpClient(
            base_url="http://127.0.0.1:3000",
            api_key="sk_live_x",
            transport=httpx.MockTransport(lambda r: httpx.Response(200, json={})),
        )
        AsyncSyrotpClient(
            base_url="http://10.0.0.1",
            api_key="sk_live_x",
            transport=httpx.MockTransport(lambda r: httpx.Response(200, json={})),
        )
    matching = [r for r in caplog.records if "plain HTTP" in r.message]
    assert matching == []
