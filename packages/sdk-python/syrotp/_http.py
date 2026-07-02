"""
Internal HTTP transport. NOT a public API — anything here can change
between PATCH releases.

Centralizes:
  - mapping HTTP status codes to the typed error classes
  - the retry policy from sdk-generation.md §7
  - User-Agent assembly
  - timeout enforcement (the SDK never defaults to infinite)

The retry loop is intentionally written without an external retry
library so the policy stays auditable in one ~80-line block.
"""

from __future__ import annotations

import json
import logging
import random
import time
from typing import Any, Callable, Optional  # noqa: F401  (Callable used in signatures)

import httpx

from . import errors

log = logging.getLogger("syrotp")

# Backoff schedule per attempt index, in seconds. Capped at 4s.
# attempt 0 = initial try, no wait before it.
_BACKOFF_BASE_SECONDS: tuple[float, ...] = (0.0, 0.25, 0.5, 1.0, 2.0, 4.0)
_BACKOFF_CAP_SECONDS = 4.0
_BACKOFF_JITTER_FRACTION = 0.4  # ±40% multiplicative jitter


def _backoff_for(attempt: int) -> float:
    base = _BACKOFF_BASE_SECONDS[min(attempt, len(_BACKOFF_BASE_SECONDS) - 1)]
    if base == 0.0:
        return 0.0
    delta = base * _BACKOFF_JITTER_FRACTION
    # uniform in [base - delta, base + delta]; capped.
    return min(_BACKOFF_CAP_SECONDS, max(0.0, random.uniform(base - delta, base + delta)))


def _parse_retry_after(value: Optional[str]) -> Optional[int]:
    if not value:
        return None
    try:
        n = int(value.strip())
    except (TypeError, ValueError):
        return None
    return max(0, n)


def _error_from_response(res: httpx.Response, body_text: str) -> errors.SyrotpError:
    """Map an HTTP response to the typed error. Caller raises."""
    code: str
    message: str
    request_id: Optional[str] = None
    try:
        body = json.loads(body_text) if body_text else {}
        err = body.get("error") if isinstance(body, dict) else None
        if isinstance(err, dict):
            code = str(err.get("code") or f"http_{res.status_code}")
            message = str(err.get("message") or f"request failed with status {res.status_code}")
            rid = err.get("request_id")
            request_id = str(rid) if rid is not None else None
        else:
            code = f"http_{res.status_code}"
            message = f"request failed with status {res.status_code}"
    except json.JSONDecodeError:
        code = "bad_response"
        message = f"non-JSON response (status {res.status_code})"

    status = res.status_code
    if status == 401 or status == 403:
        return errors.SyrotpAuthError(code=code, message=message, http_status=status, request_id=request_id)
    if status == 400:
        return errors.SyrotpValidationError(code=code, message=message, http_status=status, request_id=request_id)
    if status == 429:
        return errors.SyrotpRateLimitError(
            code=code,
            message=message,
            http_status=status,
            request_id=request_id,
            retry_after_seconds=_parse_retry_after(res.headers.get("Retry-After")),
        )
    if 500 <= status < 600:
        return errors.SyrotpServerError(code=code, message=message, http_status=status, request_id=request_id)
    # Other 4xx (404, 409 etc.) — surface as a generic SyrotpError so the
    # caller decides. We deliberately don't lump them into "validation".
    return errors.SyrotpError(code=code, message=message, http_status=status, request_id=request_id)


def _is_retriable(exc: BaseException) -> bool:
    return isinstance(
        exc,
        (errors.SyrotpNetworkError, errors.SyrotpServerError, errors.SyrotpRateLimitError),
    )


def execute_with_retries(
    transport: Callable[[], httpx.Response],
    *,
    max_retries: int,
    on_response: Callable[[httpx.Response], Any],
) -> Any:
    """
    Run `transport()` up to `max_retries + 1` times. On each non-final
    attempt, retriable errors trigger a backoff sleep and another try.

    `on_response` parses a successful response and returns the caller's
    final value. It MUST raise an SyrotpError for non-2xx, which gives
    this loop a single failure shape to reason about.

    `time.sleep` is called by attribute lookup (not closed over), so
    tests can monkeypatch `syrotp._http.time.sleep` to avoid waiting.
    """
    if max_retries < 0:
        raise ValueError("max_retries must be >= 0")

    last_error: Optional[BaseException] = None
    for attempt in range(max_retries + 1):
        try:
            res = transport()
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
                time.sleep(_backoff_for(attempt + 1))
                continue
            raise last_error from e

        try:
            return on_response(res)
        except errors.SyrotpError as oe:
            last_error = oe
            if attempt < max_retries and _is_retriable(oe):
                # Special-case: respect Retry-After on 429.
                if isinstance(oe, errors.SyrotpRateLimitError) and oe.retry_after_seconds is not None:
                    time.sleep(max(_backoff_for(attempt + 1), float(oe.retry_after_seconds)))
                else:
                    time.sleep(_backoff_for(attempt + 1))
                continue
            raise

    # Defensive: loop above always returns or raises, but Python can't
    # prove that. If we somehow fall through, raise the last error.
    assert last_error is not None
    raise last_error
