"""
Tests for the SYROTP Django client helpers. Pin the
sync-singleton-per-process and async-singleton-per-event-loop
contracts, plus the close/aclose lifecycle.
"""
from __future__ import annotations

import asyncio
import threading

import pytest
from django.test import override_settings

from syrotp import AsyncSyrotpClient, SyrotpClient


# Every test in this file runs against the same default SYROTP config.
# An autouse fixture applies them via Django's `override_settings`
# context manager so each test gets fresh settings (and they're
# reverted at teardown).
@pytest.fixture(autouse=True)
def _default_syrotp_settings():
    with override_settings(
        SYROTP_BASE_URL="http://syrotp.test",
        SYROTP_SECRET_KEY="sk_live_TESTKEY_DO_NOT_USE",
    ):
        yield


# ----- sync singleton --------------------------------------------------------


def test_get_syrotp_client_returns_a_real_client():
    from syrotp.django import get_syrotp_client

    client = get_syrotp_client()
    assert isinstance(client, SyrotpClient)


def test_get_syrotp_client_returns_singleton_across_calls():
    from syrotp.django import get_syrotp_client

    a = get_syrotp_client()
    b = get_syrotp_client()
    assert a is b


def test_get_syrotp_client_is_thread_safe():
    """
    Hammer the lazy-init from many threads at once. All threads must
    end up with exactly the same `SyrotpClient` instance — if the
    double-checked lock is broken we'd see two distinct instances.
    """
    from syrotp.django import get_syrotp_client

    barrier = threading.Barrier(20)
    results: list[SyrotpClient] = []
    results_lock = threading.Lock()

    def worker():
        barrier.wait()
        c = get_syrotp_client()
        with results_lock:
            results.append(c)

    threads = [threading.Thread(target=worker) for _ in range(20)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert len(results) == 20
    first = results[0]
    assert all(c is first for c in results)


# ----- async singleton per event loop ---------------------------------------


async def test_get_syrotp_async_client_returns_a_real_client():
    from syrotp.django import get_syrotp_async_client

    client = get_syrotp_async_client()
    assert isinstance(client, AsyncSyrotpClient)


async def test_get_syrotp_async_client_returns_singleton_within_one_loop():
    from syrotp.django import get_syrotp_async_client

    a = get_syrotp_async_client()
    b = get_syrotp_async_client()
    assert a is b


def test_async_clients_differ_across_event_loops():
    """
    Each fresh event loop builds its own `AsyncSyrotpClient`. Two
    loops never share an instance — important because httpx async
    clients are bound to the loop they were created on.
    """
    from syrotp.django import get_syrotp_async_client

    async def grab() -> AsyncSyrotpClient:
        return get_syrotp_async_client()

    loop_a = asyncio.new_event_loop()
    try:
        client_a = loop_a.run_until_complete(grab())
    finally:
        loop_a.close()

    loop_b = asyncio.new_event_loop()
    try:
        client_b = loop_b.run_until_complete(grab())
    finally:
        loop_b.close()

    assert client_a is not client_b


def test_get_syrotp_async_client_outside_event_loop_raises():
    from syrotp.django import get_syrotp_async_client

    # Calling from a sync test (no running loop) → RuntimeError.
    with pytest.raises(RuntimeError):
        get_syrotp_async_client()


# ----- close / aclose lifecycle ---------------------------------------------


def test_close_syrotp_clients_drops_sync_singleton():
    from syrotp.django import close_syrotp_clients, get_syrotp_client

    first = get_syrotp_client()
    close_syrotp_clients()
    second = get_syrotp_client()
    assert first is not second


def test_close_syrotp_clients_clears_async_map():
    """`close_syrotp_clients()` clears the async map; the next async
    request rebuilds. We verify by populating the map from one loop,
    closing, then checking the map is empty."""
    from syrotp.django import _async_clients, close_syrotp_clients, get_syrotp_async_client

    async def populate() -> AsyncSyrotpClient:
        return get_syrotp_async_client()

    loop = asyncio.new_event_loop()
    try:
        loop.run_until_complete(populate())
    finally:
        loop.close()

    assert len(_async_clients) >= 1

    close_syrotp_clients()
    assert len(_async_clients) == 0


async def test_aclose_syrotp_clients_awaits_close_on_current_loop():
    """`aclose_syrotp_clients()` properly awaits `aclose` on the
    current loop's async client — we verify the underlying httpx
    client is closed after the call."""
    from syrotp.django import aclose_syrotp_clients, get_syrotp_async_client

    client = get_syrotp_async_client()
    # httpx.AsyncClient exposes `is_closed` as a public-ish bool.
    assert client._http.is_closed is False

    await aclose_syrotp_clients()

    assert client._http.is_closed is True


async def test_aclose_syrotp_clients_is_idempotent():
    from syrotp.django import aclose_syrotp_clients, get_syrotp_async_client

    get_syrotp_async_client()
    await aclose_syrotp_clients()
    # Second call should not raise even though there's nothing to close.
    await aclose_syrotp_clients()
