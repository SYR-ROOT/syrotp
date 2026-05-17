"""
Integration tests for `syrotp.fastapi.setup_syrotp` + `get_syrotp` over
a real FastAPI app driven by `fastapi.testclient.TestClient`.

The lifespan is exercised by entering and exiting the TestClient
context manager — Starlette runs startup on enter and shutdown on
exit, which is exactly what we want to verify.

We monkeypatch `_build_client` so the lifespan installs an
`AsyncSyrotpClient` wired to an `httpx.MockTransport` instead of
talking to a real server. That keeps these tests fast and offline
while still exercising every line of the helper.
"""
from __future__ import annotations

from contextlib import asynccontextmanager

import httpx
import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from syrotp import AsyncSyrotpClient
from syrotp.fastapi import SyrotpSettings, get_syrotp, setup_syrotp


# ----- shared helpers --------------------------------------------------------


def _make_settings() -> SyrotpSettings:
    return SyrotpSettings(base_url="http://syrotp.test", api_key="sk_live_TESTKEY")


def _ok_handler(_: httpx.Request) -> httpx.Response:
    return httpx.Response(
        201,
        json={
            "id": "vrf_fastapi1",
            "status": "pending",
            "phone_masked": "+96399****567",
            "send_to": "+963998887777",
            "message": "VERIFY ABC",
            "expires_at": "2026-05-02T18:00:00.000Z",
            "created_at": "2026-05-02T17:00:00.000Z",
        },
    )


def _patched_client_factory(handler):
    """Return a builder that ignores `settings` and produces a mock-
    transport `AsyncSyrotpClient` over the given handler."""

    def _build(_settings):
        return AsyncSyrotpClient(
            base_url="http://syrotp.test",
            api_key="sk_live_x",
            transport=httpx.MockTransport(handler),
        )

    return _build


# ----- setup + lifecycle -----------------------------------------------------


def test_setup_attaches_client_to_app_state_at_startup(monkeypatch):
    monkeypatch.setattr(
        "syrotp.fastapi._build_client", _patched_client_factory(_ok_handler)
    )

    app = FastAPI()
    setup_syrotp(app, _make_settings())

    # Before lifespan startup, the client isn't on app.state yet.
    assert getattr(app.state, "syrotp", None) is None

    with TestClient(app):  # enters lifespan
        # During the request scope, the client is present.
        assert isinstance(app.state.syrotp, AsyncSyrotpClient)

    # After exit, the client has been closed by the lifespan teardown.
    # We don't have a public "closed" flag; the contract is just that
    # `aclose()` was awaited (verified by httpx not raising warnings).


def test_setup_is_idempotent_guard_raises(monkeypatch):
    monkeypatch.setattr(
        "syrotp.fastapi._build_client", _patched_client_factory(_ok_handler)
    )
    app = FastAPI()
    setup_syrotp(app, _make_settings())
    with pytest.raises(RuntimeError, match="already called"):
        setup_syrotp(app, _make_settings())


# ----- DI dependency --------------------------------------------------------


def test_get_syrotp_returns_singleton_per_app(monkeypatch):
    """
    Every request reads the same `AsyncSyrotpClient` from `app.state`.
    We assert by pulling the id of the resolved client from two
    requests and comparing them.
    """
    monkeypatch.setattr(
        "syrotp.fastapi._build_client", _patched_client_factory(_ok_handler)
    )

    app = FastAPI()
    setup_syrotp(app, _make_settings())

    @app.get("/whoami")
    async def whoami(syrotp: AsyncSyrotpClient = Depends(get_syrotp)):
        return {"client_id": id(syrotp)}

    with TestClient(app) as tc:
        r1 = tc.get("/whoami")
        r2 = tc.get("/whoami")

    assert r1.status_code == 200 and r2.status_code == 200
    assert r1.json()["client_id"] == r2.json()["client_id"]


def test_get_syrotp_proxies_real_call_to_underlying_client(monkeypatch):
    """End-to-end: a request handler depends on `get_syrotp`, calls
    `start_verification`, and the mock transport sees the right wire
    shape."""
    captured: dict = {}

    def handler(req: httpx.Request) -> httpx.Response:
        captured["method"] = req.method
        captured["path"] = req.url.path
        captured["auth"] = req.headers.get("authorization")
        return _ok_handler(req)

    monkeypatch.setattr("syrotp.fastapi._build_client", _patched_client_factory(handler))

    app = FastAPI()
    setup_syrotp(app, _make_settings())

    @app.post("/verify/start")
    async def start(syrotp: AsyncSyrotpClient = Depends(get_syrotp)):
        v = await syrotp.start_verification(phone="+963991234567", purpose="login")
        return {"id": v.id, "status": v.status.value}

    with TestClient(app) as tc:
        r = tc.post("/verify/start")

    assert r.status_code == 200
    assert r.json() == {"id": "vrf_fastapi1", "status": "pending"}
    assert captured["method"] == "POST"
    assert captured["path"] == "/v1/verifications"
    assert captured["auth"] == "Bearer sk_live_x"


def test_get_syrotp_raises_when_app_was_not_setup():
    """If a developer forgets `setup_syrotp(app)`, every request must
    surface the misconfiguration loudly instead of silently 500'ing."""
    app = FastAPI()

    @app.get("/whoami")
    async def whoami(syrotp: AsyncSyrotpClient = Depends(get_syrotp)):
        return {"ok": True}

    with TestClient(app) as tc:
        with pytest.raises(RuntimeError, match="setup_syrotp"):
            tc.get("/whoami")


# ----- lifespan composition --------------------------------------------------


def test_setup_does_not_overwrite_existing_lifespan(monkeypatch):
    """
    If the host app already has its own lifespan (DB pool, scheduler,
    …), `setup_syrotp` must compose with it, not replace it. We verify
    by tracking startup / shutdown order: user-startup → syrotp-startup
    → app runs → syrotp-shutdown → user-shutdown.
    """
    monkeypatch.setattr(
        "syrotp.fastapi._build_client", _patched_client_factory(_ok_handler)
    )

    order: list[str] = []

    @asynccontextmanager
    async def user_lifespan(app: FastAPI):
        order.append("user-startup")
        yield
        order.append("user-shutdown")

    app = FastAPI(lifespan=user_lifespan)
    # Patch the syrotp builder to record its lifecycle too.
    real_factory = _patched_client_factory(_ok_handler)

    def recording_factory(settings):
        order.append("syrotp-startup")
        client = real_factory(settings)
        original_close = client.aclose

        async def recording_close():
            order.append("syrotp-shutdown")
            await original_close()

        client.aclose = recording_close  # type: ignore[method-assign]
        return client

    monkeypatch.setattr("syrotp.fastapi._build_client", recording_factory)

    setup_syrotp(app, _make_settings())

    with TestClient(app):
        order.append("request-time")

    # User's lifespan brackets SYROTP's lifespan.
    assert order == [
        "user-startup",
        "syrotp-startup",
        "request-time",
        "syrotp-shutdown",
        "user-shutdown",
    ]
