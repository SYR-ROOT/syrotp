"""
FastAPI integration for the SYROTP Python SDK.

Three pieces:

  - `SyrotpSettings`     — Pydantic v2 Settings reading the same env
                          vars as `scripts/smoke.mjs` and the `syrotp`
                          CLI (`SYROTP_BASE_URL`, `SYROTP_SECRET_KEY`
                          falling back to `SYROTP_PUBLIC_KEY`, etc.).
  - `setup_syrotp(app)`  — installs a lifespan that builds one
                          `AsyncSyrotpClient` at startup and closes
                          it at shutdown. Composes with any existing
                          lifespan instead of replacing it.
  - `get_syrotp`         — FastAPI dependency that returns the
                          singleton client.

Usage:

    from fastapi import Depends, FastAPI
    from syrotp import AsyncSyrotpClient
    from syrotp.fastapi import get_syrotp, setup_syrotp

    app = FastAPI()
    setup_syrotp(app)

    @app.post("/verify/start")
    async def start(syrotp: AsyncSyrotpClient = Depends(get_syrotp)):
        return await syrotp.start_verification(
            phone="+963991234567",
            purpose="login",
        )

Install via the optional extra:

    pip install "syrotp-sdk[fastapi]"

Pre-built endpoints, webhook handlers, auth/rate-limit middleware,
and Pydantic v1 are deliberately out of scope — those are
opinionated choices the host app should own.
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI, Request
from pydantic import AliasChoices, Field
from pydantic_settings import BaseSettings, SettingsConfigDict

from syrotp import AsyncSyrotpClient


_STATE_KEY = "syrotp"
_INIT_FLAG = "_syrotp_initialized"


class SyrotpSettings(BaseSettings):
    """
    Pydantic v2 settings model. Reads the canonical SYROTP env vars:

        SYROTP_BASE_URL       (required)
        SYROTP_SECRET_KEY     (required, falls back to SYROTP_PUBLIC_KEY)
        SYROTP_TIMEOUT_MS     (default 15000)
        SYROTP_RETRIES        (default 2)
        SYROTP_USER_AGENT     (default unset — use SDK default)

    Override per-app by passing an instance to `setup_syrotp(app, settings=...)`.
    """

    model_config = SettingsConfigDict(
        env_prefix="SYROTP_",
        env_file=".env",
        extra="ignore",
        case_sensitive=False,
        # Allow `SyrotpSettings(api_key="sk_live_x")` kwargs alongside
        # the `SYROTP_SECRET_KEY` / `SYROTP_PUBLIC_KEY` aliases below.
        # Without this, the alias on `api_key` would forbid the bare
        # `api_key=` kwarg in tests and programmatic construction.
        populate_by_name=True,
    )

    base_url: str
    api_key: str = Field(
        # Match the SYROTP_SECRET_KEY → SYROTP_PUBLIC_KEY fallback the
        # CLI / smoke / Laravel config all use, so apps share one set
        # of env vars regardless of how SYROTP is wired in.
        validation_alias=AliasChoices(
            "api_key", "SYROTP_SECRET_KEY", "SYROTP_PUBLIC_KEY"
        ),
    )
    timeout_ms: int = 15_000
    retries: int = 2
    user_agent: Optional[str] = None


def _build_client(settings: SyrotpSettings) -> AsyncSyrotpClient:
    """
    Construct the `AsyncSyrotpClient` from settings.

    Factored out so tests can monkeypatch this seam to inject a mock-
    transport client without touching the real `SyrotpSettings` env
    plumbing or the lifespan composition logic.
    """
    return AsyncSyrotpClient(
        base_url=settings.base_url,
        api_key=settings.api_key,
        timeout_ms=settings.timeout_ms,
        retries=settings.retries,
        user_agent=settings.user_agent,
    )


def setup_syrotp(app: FastAPI, settings: Optional[SyrotpSettings] = None) -> None:
    """
    Install SYROTP into a FastAPI app.

    On startup, builds one `AsyncSyrotpClient` from `settings` (or
    `SyrotpSettings()` reading env) and stashes it on `app.state.syrotp`.
    On shutdown, closes the client.

    Composes with any existing lifespan rather than replacing it —
    the SYROTP setup runs *inside* the user's lifespan so user
    resources (DB pools, message brokers, …) outlive ours. If you
    care about the reverse ordering, install your own lifespan AFTER
    calling `setup_syrotp`.

    Idempotent within an app: calling twice on the same app raises
    `RuntimeError` to surface accidental double-setup early.
    """
    if getattr(app.state, _INIT_FLAG, False):
        raise RuntimeError("setup_syrotp(app) already called for this app")
    app.state._syrotp_initialized = True

    resolved_settings = settings if settings is not None else SyrotpSettings()

    # `app.router.lifespan_context` is the existing lifespan callable.
    # When the user passed `lifespan=...` to FastAPI(), it's that;
    # otherwise it's Starlette's `_DefaultLifespan` which delegates to
    # the deprecated `on_event("startup"|"shutdown")` handlers.
    existing_lifespan = app.router.lifespan_context

    @asynccontextmanager
    async def composed_lifespan(scoped_app: FastAPI):
        async with existing_lifespan(scoped_app):
            client = _build_client(resolved_settings)
            scoped_app.state.syrotp = client
            try:
                yield
            finally:
                await client.aclose()

    app.router.lifespan_context = composed_lifespan


def get_syrotp(request: Request) -> AsyncSyrotpClient:
    """
    FastAPI dependency that returns the singleton `AsyncSyrotpClient`
    initialized by `setup_syrotp(app)`.

        async def handler(syrotp: AsyncSyrotpClient = Depends(get_syrotp)):
            ...

    Raises `RuntimeError` if the lifespan hasn't initialized the
    client yet — that happens when the app was constructed without
    `setup_syrotp`, or when this dependency is reached outside a
    request scope.
    """
    client: Optional[AsyncSyrotpClient] = getattr(request.app.state, _STATE_KEY, None)
    if client is None:
        raise RuntimeError(
            "SYROTP client not on app.state — call setup_syrotp(app) at "
            "construction, and make sure the lifespan has started."
        )
    return client


__all__ = [
    "SyrotpSettings",
    "setup_syrotp",
    "get_syrotp",
]
