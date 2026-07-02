"""
Django integration for the SYROTP Python SDK.

Three helpers:

  - `get_syrotp_client()`         — sync `SyrotpClient` singleton, for
                                   classic Django views and DRF.
                                   Lazy-initialized on first call,
                                   thread-safe.
  - `get_syrotp_async_client()`   — `AsyncSyrotpClient` singleton scoped
                                   to the running event loop. Each
                                   loop gets its own client (a
                                   `WeakKeyDictionary` keyed by loop)
                                   so test loops and worker loops
                                   don't share state.
  - `close_syrotp_clients()`      — sync helper to drop the cached
                                   sync client + clear the async map.
                                   For full async cleanup with
                                   awaited `aclose()`, use
                                   `aclose_syrotp_clients()`.

Settings resolution order (per key):
  1. `django.conf.settings.SYROTP_<NAME>` (when Django is configured).
  2. `os.environ["SYROTP_<NAME>"]`.
  3. The SDK's own defaults.

The env-var names match `scripts/smoke.mjs`, the `syrotp` CLI, the
Laravel `config/syrotp.php`, and the FastAPI `SyrotpSettings`. One
`SYROTP_BASE_URL` / `SYROTP_SECRET_KEY` set works everywhere.

Usage in a sync Django view:

    from syrotp.django import get_syrotp_client

    def start_verify(request):
        client = get_syrotp_client()
        v = client.start_verification(
            phone=request.POST["phone"],
            purpose="login",
        )
        return JsonResponse({"id": v.id})

Usage in an async Django view:

    from syrotp.django import get_syrotp_async_client

    async def start_verify(request):
        client = get_syrotp_async_client()
        v = await client.start_verification(
            phone=request.POST["phone"],
            purpose="login",
        )
        return JsonResponse({"id": v.id})

Pre-built models / migrations / admin / middleware / DRF endpoints /
webhook handlers are deliberately out of scope — those are
opinionated choices the host app should own.
"""

from __future__ import annotations

import asyncio
import os
import threading
from typing import Any, Dict, Optional
from weakref import WeakKeyDictionary

from syrotp import AsyncSyrotpClient, SyrotpClient


# Module-global singletons. Reset by `close_syrotp_clients()` and by the
# autouse fixture in `tests/conftest.py` so each test starts fresh.
_sync_client: Optional[SyrotpClient] = None
_sync_lock = threading.Lock()

# WeakKeyDictionary so a GC'd event loop drops its client reference
# automatically — no leak between tests that spin up short-lived loops.
_async_clients: "WeakKeyDictionary[asyncio.AbstractEventLoop, AsyncSyrotpClient]" = (
    WeakKeyDictionary()
)


# ----- public API -----------------------------------------------------------


def get_syrotp_client() -> SyrotpClient:
    """
    Return the process-wide sync `SyrotpClient` singleton, building it
    on first call. Thread-safe via a double-checked lock.
    """
    global _sync_client
    if _sync_client is None:
        with _sync_lock:
            if _sync_client is None:
                _sync_client = _build_sync()
    return _sync_client


def get_syrotp_async_client() -> AsyncSyrotpClient:
    """
    Return the `AsyncSyrotpClient` bound to the *currently running*
    event loop, building it on first call. Different loops get
    different clients — important for tests where each test owns its
    own loop, and for ASGI deployments where each worker process
    owns one loop.

    MUST be called from within an async context. Raises
    `RuntimeError` if no loop is running.
    """
    loop = asyncio.get_running_loop()
    client = _async_clients.get(loop)
    if client is None:
        client = _build_async()
        _async_clients[loop] = client
    return client


def close_syrotp_clients() -> None:
    """
    Sync teardown helper. Closes the cached sync client and clears
    the async client map. Idempotent.

    NOTE: clearing the async map drops references to
    `AsyncSyrotpClient` instances without awaiting their `aclose()`.
    `httpx.AsyncClient` will warn at GC time if it was still open.
    For a clean async shutdown, call `aclose_syrotp_clients()` from an
    async context instead.
    """
    global _sync_client
    if _sync_client is not None:
        _sync_client.close()
        _sync_client = None
    _async_clients.clear()


async def aclose_syrotp_clients() -> None:
    """
    Async teardown helper. Closes the sync client and the async
    client bound to the *currently running* event loop, awaiting
    `aclose()` so httpx releases sockets cleanly. Idempotent.

    Only the current loop's client is closed — async clients bound
    to other loops can only be closed from inside their own loops.
    """
    global _sync_client
    if _sync_client is not None:
        _sync_client.close()
        _sync_client = None

    loop = asyncio.get_running_loop()
    client = _async_clients.pop(loop, None)
    if client is not None:
        await client.aclose()


# ----- internals ------------------------------------------------------------


def _build_sync() -> SyrotpClient:
    s = _resolve_settings()
    return SyrotpClient(
        base_url=s["base_url"],
        api_key=s["api_key"],
        timeout_ms=s["timeout_ms"],
        retries=s["retries"],
        user_agent=s["user_agent"],
    )


def _build_async() -> AsyncSyrotpClient:
    s = _resolve_settings()
    return AsyncSyrotpClient(
        base_url=s["base_url"],
        api_key=s["api_key"],
        timeout_ms=s["timeout_ms"],
        retries=s["retries"],
        user_agent=s["user_agent"],
    )


def _resolve_settings() -> Dict[str, Any]:
    """
    Pull each option from Django settings, env, then defaults.

    Failures are eager — we'd rather raise here than build an
    `SyrotpClient` that refuses to do anything useful, because the
    `SyrotpConfigError` from the SDK constructor would surface at the
    same call site anyway.
    """
    base_url = _get("SYROTP_BASE_URL")
    api_key = _get("SYROTP_SECRET_KEY") or _get("SYROTP_PUBLIC_KEY")
    if not base_url:
        raise RuntimeError(
            "SYROTP_BASE_URL is not set in Django settings or environment"
        )
    if not api_key:
        raise RuntimeError(
            "SYROTP_SECRET_KEY (or SYROTP_PUBLIC_KEY) is not set in "
            "Django settings or environment"
        )

    timeout_raw = _get("SYROTP_TIMEOUT_MS")
    retries_raw = _get("SYROTP_RETRIES")
    return {
        "base_url": base_url,
        "api_key": api_key,
        "timeout_ms": int(timeout_raw) if timeout_raw else 15_000,
        "retries": int(retries_raw) if retries_raw else 2,
        "user_agent": _get("SYROTP_USER_AGENT"),
    }


def _get(name: str) -> Optional[str]:
    """
    Look up `name` in Django settings (when configured) first, then
    in the process environment. Empty strings and `None` fall through
    to the next layer so a placeholder in `settings.py` doesn't
    shadow a real value in `.env` — but legitimate falsy values like
    `0` are preserved.
    """
    try:
        from django.conf import settings as django_settings

        if django_settings.configured:
            value = getattr(django_settings, name, None)
            if value is not None and value != "":
                return str(value)
    except ImportError:
        # Django is in [django] extra; if it isn't installed, fall
        # through to env. The host code that imports `syrotp.django`
        # would have failed earlier than this anyway.
        pass
    env_value = os.environ.get(name)
    return env_value if env_value else None


__all__ = [
    "get_syrotp_client",
    "get_syrotp_async_client",
    "close_syrotp_clients",
    "aclose_syrotp_clients",
]
