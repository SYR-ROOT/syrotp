"""
Internal async HTTP transport. NOT a public API — anything here can
change between PATCH releases.

Mirrors `_http.execute_with_retries` exactly, but with `await` and
`asyncio.sleep` so the retry loop doesn't block the event loop.
The retry policy itself, the response→error mapping, and the
backoff schedule live in `_http.py` — this module reuses them so
sync and async stay byte-for-byte identical on retry behavior.
"""

from __future__ import annotations

import asyncio
from typing import Any, Awaitable, Callable

import httpx

from . import errors
from ._http import _backoff_for, _is_retriable


async def aexecute_with_retries(
    transport: Callable[[], Awaitable[httpx.Response]],
    *,
    max_retries: int,
    on_response: Callable[[httpx.Response], Any],
) -> Any:
    """
    Run `transport()` up to `max_retries + 1` times.

    Identical control flow to the sync `execute_with_retries`:
      - Network / 5xx / 429 retriable; bounded retries with jittered
        backoff. `Retry-After` honored on 429.
      - 4xx-other / auth / validation / config / timeout NOT retried.

    `on_response` parses a successful response and returns the caller's
    final value. It MUST raise an `SyrotpError` for non-2xx, which gives
    this loop a single failure shape to reason about.

    `asyncio.sleep` is called by attribute lookup (not closed over),
    so tests can monkeypatch `syrotp._async_http.asyncio.sleep` to a
    no-op coroutine and avoid actually waiting.
    """
    if max_retries < 0:
        raise ValueError("max_retries must be >= 0")

    last_error: BaseException | None = None
    for attempt in range(max_retries + 1):
        try:
            res = await transport()
        except httpx.TimeoutException as e:
            last_error = errors.SyrotpTimeoutError(str(e) or "request timed out")
            # Per the contract: SDK does NOT auto-retry timeouts —
            # the caller's deadline already expired.
            raise last_error from e
        except httpx.HTTPError as e:
            last_error = errors.SyrotpNetworkError(
                code="network_error",
                message=str(e) or "network error",
                http_status=0,
            )
            if attempt < max_retries:
                await asyncio.sleep(_backoff_for(attempt + 1))
                continue
            raise last_error from e

        try:
            return on_response(res)
        except errors.SyrotpError as oe:
            last_error = oe
            if attempt < max_retries and _is_retriable(oe):
                # Special-case: respect Retry-After on 429.
                if (
                    isinstance(oe, errors.SyrotpRateLimitError)
                    and oe.retry_after_seconds is not None
                ):
                    await asyncio.sleep(
                        max(_backoff_for(attempt + 1), float(oe.retry_after_seconds))
                    )
                else:
                    await asyncio.sleep(_backoff_for(attempt + 1))
                continue
            raise

    # Defensive: loop above always returns or raises. If we somehow
    # fall through, raise the last error.
    assert last_error is not None
    raise last_error
