"""
Typed error hierarchy. Mirrors docs/sdk-contract.md §5.

Application code is expected to catch by category:

    try:
        client.start_verification(phone="...", purpose="login")
    except SyrotpRateLimitError as e:
        backoff_and_retry(e.retry_after_seconds)
    except SyrotpValidationError as e:
        # surface to user; do NOT auto-retry
        ...
    except SyrotpError as e:
        # catch-all for unexpected categories
        ...

Every error carries:
  - code         : short, stable string (e.g. "validation_error")
  - message      : human-readable; MUST NOT contain the api_key
  - http_status  : HTTP status code, or 0 for purely-local failures
  - request_id   : the server-issued request_id from the response, if any

`__str__` and `__repr__` deliberately do NOT include any kwarg the
SDK was constructed with — neither api_key nor request body — so a
naive `print(e)` cannot leak credentials into logs.
"""

from __future__ import annotations

from typing import Optional


class SyrotpError(Exception):
    """Base class for all SDK-raised errors."""

    def __init__(
        self,
        code: str,
        message: str,
        *,
        http_status: int = 0,
        request_id: Optional[str] = None,
    ) -> None:
        # Python's Exception.__init__ stores args; we override __str__ so
        # it shows only code + message, never anything passed via kwargs
        # at the SDK boundary.
        super().__init__(message)
        self.code = code
        self.message = message
        self.http_status = http_status
        self.request_id = request_id

    def __str__(self) -> str:
        if self.request_id:
            return f"{self.code}: {self.message} (request_id={self.request_id})"
        return f"{self.code}: {self.message}"

    def __repr__(self) -> str:
        cls = type(self).__name__
        return (
            f"{cls}(code={self.code!r}, message={self.message!r}, "
            f"http_status={self.http_status!r}, request_id={self.request_id!r})"
        )


class SyrotpConfigError(SyrotpError):
    """
    Construction-time validation failure. Bad base_url, missing
    api_key, out-of-range timeout_ms / retries, etc.

    NOT retriable.
    """

    def __init__(self, message: str, *, code: str = "config_error") -> None:
        super().__init__(code=code, message=message)


class SyrotpAuthError(SyrotpError):
    """
    HTTP 401 / 403. Bad / missing API key, or key kind not allowed
    for this endpoint.

    NOT retriable — keys don't fix themselves; retrying just generates
    log noise.
    """


class SyrotpValidationError(SyrotpError):
    """
    HTTP 400 (server-side validation), or local input validation.

    NOT retriable. Surface to the user; the input is wrong.
    """


class SyrotpRateLimitError(SyrotpError):
    """
    HTTP 429. Exposes `retry_after_seconds` parsed from the
    `Retry-After` response header.

    Retriable, bounded, respecting the server's hint.
    """

    def __init__(
        self,
        code: str,
        message: str,
        *,
        http_status: int = 429,
        request_id: Optional[str] = None,
        retry_after_seconds: Optional[int] = None,
    ) -> None:
        super().__init__(code=code, message=message, http_status=http_status, request_id=request_id)
        self.retry_after_seconds = retry_after_seconds


class SyrotpNetworkError(SyrotpError):
    """
    DNS, TLS, connection refused, connection reset, broken response.

    Retriable, bounded, with jittered backoff.
    """


class SyrotpServerError(SyrotpError):
    """
    HTTP 5xx.

    Retriable, bounded, with jittered backoff. Frequent occurrences
    should be surfaced to operations.
    """


class SyrotpTimeoutError(SyrotpError):
    """
    The per-request deadline (`timeout_ms`) elapsed before the server
    finished responding.

    NOT retriable by the SDK — the caller's deadline already expired.
    The caller decides whether to retry with a fresh deadline.
    """

    def __init__(
        self,
        message: str = "request timed out",
        *,
        code: str = "timeout",
        http_status: int = 0,
        request_id: Optional[str] = None,
    ) -> None:
        super().__init__(code=code, message=message, http_status=http_status, request_id=request_id)


__all__ = [
    "SyrotpError",
    "SyrotpConfigError",
    "SyrotpAuthError",
    "SyrotpValidationError",
    "SyrotpRateLimitError",
    "SyrotpNetworkError",
    "SyrotpServerError",
    "SyrotpTimeoutError",
]
