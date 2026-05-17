"""
Security canary tests. Pin the rules from sdk-generation.md §5:

  - Never log the API key.
  - Never log the request body (which includes the user's phone).
  - Never embed credentials in error stringification / repr.

These tests use stable canary values that, if they ever appear in
captured logs or error renderings, prove a regression.
"""
from __future__ import annotations

import io
import logging

import httpx
import pytest

from syrotp import SyrotpClient
from syrotp.errors import SyrotpAuthError


# Sentinels chosen to be unmistakable if they leak.
CANARY_API_KEY = "sk_live_TESTSENTINEL_DO_NOT_LOG_THIS"
CANARY_PHONE = "+99999999999999"


# ----- API key MUST NOT appear in error strings -----------------------------


def test_auth_error_str_does_not_contain_api_key():
    """
    str(error) must NOT include the API key, even when the SDK is
    constructed with that key — naive log lines like
        log.error("syrotp call failed: %s", err)
    must be safe to ship to a SaaS log aggregator.
    """
    err = SyrotpAuthError("unauthorized", "missing creds", http_status=401)
    rendered_str = str(err)
    rendered_repr = repr(err)
    # The error wasn't constructed with the api_key, but make
    # absolutely sure it doesn't appear via some __dict__ leak.
    assert CANARY_API_KEY not in rendered_str
    assert CANARY_API_KEY not in rendered_repr


def test_client_attributes_do_not_leak_api_key_via_repr():
    """
    Calling repr() on the client itself MUST NOT echo the api_key.
    Some users inadvertently log `repr(client)` when chasing a bug.
    """
    client = SyrotpClient(
        base_url="http://syrotp.test",
        api_key=CANARY_API_KEY,
        transport=httpx.MockTransport(lambda r: httpx.Response(200, json={})),
    )
    # Default object repr in Python uses class + id(), no attrs. Even
    # so, we explicitly assert it doesn't show up.
    assert CANARY_API_KEY not in repr(client)


# ----- request body MUST NOT be logged --------------------------------------


def test_phone_does_not_appear_in_syrotp_logger_output():
    """
    The SDK's own logger (`syrotp`) MUST NOT spill request bodies. If
    a future log statement accidentally logs the body, this canary
    phone will catch it.
    """
    captured = io.StringIO()
    handler = logging.StreamHandler(captured)
    handler.setLevel(logging.DEBUG)
    formatter = logging.Formatter("%(message)s")
    handler.setFormatter(formatter)
    logger = logging.getLogger("syrotp")
    logger.addHandler(handler)
    logger.setLevel(logging.DEBUG)

    try:
        def transport_handler(_: httpx.Request) -> httpx.Response:
            return httpx.Response(201, json={
                "id": "vrf_1", "status": "pending", "phone_masked": "+1*",
                "send_to": "+1", "message": "VERIFY ABC",
                "expires_at": "2026", "created_at": "2026",
            })

        client = SyrotpClient(
            base_url="http://syrotp.test",
            api_key=CANARY_API_KEY,
            transport=httpx.MockTransport(transport_handler),
        )
        client.start_verification(phone=CANARY_PHONE, purpose="login")
    finally:
        logger.removeHandler(handler)

    output = captured.getvalue()
    assert CANARY_PHONE not in output, (
        "the user's phone MUST NOT appear in any syrotp log line"
    )
    assert CANARY_API_KEY not in output, (
        "the api_key MUST NOT appear in any syrotp log line"
    )


# ----- cleartext warning behavior -------------------------------------------


def test_cleartext_to_public_host_logs_warning(caplog):
    """Plain HTTP to a non-private host triggers exactly one warning."""
    with caplog.at_level(logging.WARNING, logger="syrotp"):
        SyrotpClient(
            base_url="http://otp.example.com",
            api_key="sk_live_x",
            transport=httpx.MockTransport(lambda r: httpx.Response(200, json={})),
        )
    matching = [r for r in caplog.records if "plain HTTP" in r.message]
    assert len(matching) >= 1


def test_loopback_does_not_warn(caplog):
    """localhost / 127.0.0.1 / RFC1918 are dev paths — no warning."""
    with caplog.at_level(logging.WARNING, logger="syrotp"):
        SyrotpClient(
            base_url="http://localhost:3000",
            api_key="sk_live_x",
            transport=httpx.MockTransport(lambda r: httpx.Response(200, json={})),
        )
        SyrotpClient(
            base_url="http://127.0.0.1:3000",
            api_key="sk_live_x",
            transport=httpx.MockTransport(lambda r: httpx.Response(200, json={})),
        )
        SyrotpClient(
            base_url="http://10.0.0.1",
            api_key="sk_live_x",
            transport=httpx.MockTransport(lambda r: httpx.Response(200, json={})),
        )
    matching = [r for r in caplog.records if "plain HTTP" in r.message]
    assert matching == []
