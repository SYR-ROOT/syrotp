"""
Public async client for the Syrian Reverse OTP Protocol.

    from syrotp import AsyncSyrotpClient

    async with AsyncSyrotpClient(
        base_url="https://otp.example.com",
        api_key="sk_live_...",
    ) as client:
        v = await client.start_verification(phone="+963991234567", purpose="login")
        final = await client.wait_for_verification(v.id)
        if final.status == "verified":
            ...

The four-method shape, the seven typed errors, the retry policy, and
the security canaries are byte-for-byte identical to the sync
{@see SyrotpClient}. Only the call surface differs (`async`/`await`
+ `asyncio.sleep`-based polling). Both clients share the same
`Verification` / `VerificationStatus` types, error classes, and
backoff numbers — see `_http.py` for the canonical retry constants.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Optional

import httpx

from . import errors
from ._async_http import aexecute_with_retries
from ._http import _error_from_response
from ._version import __version__
from .client import (
    DEFAULT_RETRIES,
    DEFAULT_TIMEOUT_MS,
    DEFAULT_WAIT_INTERVAL_MS,
    DEFAULT_WAIT_TIMEOUT_MS,
    MIN_WAIT_INTERVAL_MS,
    _HTTP_URL_RE,
    _VERIFICATION_ID_RE,
    _host_only,
    _is_loopback_or_private,
)
from .types import Verification, VerificationStatus

log = logging.getLogger("syrotp")


class AsyncSyrotpClient:
    """
    Asynchronous SYROTP client. One client = one HTTP connection pool.

    Use as an async context manager to release sockets deterministically:

        async with AsyncSyrotpClient(base_url=..., api_key=...) as client:
            ...
    """

    def __init__(
        self,
        *,
        base_url: str,
        api_key: str,
        timeout_ms: int = DEFAULT_TIMEOUT_MS,
        retries: int = DEFAULT_RETRIES,
        user_agent: Optional[str] = None,
        transport: Optional[httpx.AsyncBaseTransport] = None,
    ) -> None:
        if not isinstance(base_url, str) or not base_url:
            raise errors.SyrotpConfigError("base_url is required")
        if not _HTTP_URL_RE.match(base_url):
            raise errors.SyrotpConfigError("base_url must be an http(s) URL")
        if not isinstance(api_key, str) or not api_key:
            raise errors.SyrotpConfigError("api_key is required")
        if not isinstance(timeout_ms, int) or timeout_ms <= 0:
            raise errors.SyrotpConfigError("timeout_ms must be a positive int")
        if not isinstance(retries, int) or retries < 0:
            raise errors.SyrotpConfigError("retries must be a non-negative int")

        # Cleartext warning is identical to the sync client — the
        # plain-HTTP-to-public-host check doesn't depend on the I/O
        # mode. See `docs/sdk-generation.md` §5.
        if base_url.lower().startswith("http://") and not _is_loopback_or_private(base_url):
            log.warning(
                "syrotp-sdk: base_url is plain HTTP to a non-private host (%s); "
                "use https:// in production",
                _host_only(base_url),
            )

        self._base_url = base_url.rstrip("/")
        self._api_key = api_key
        self._timeout_ms = timeout_ms
        self._retries = retries
        self._user_agent = self._build_user_agent(user_agent)
        timeout_s = timeout_ms / 1000.0
        self._http = httpx.AsyncClient(
            transport=transport,
            timeout=httpx.Timeout(timeout_s, connect=min(15.0, timeout_s)),
            headers={"User-Agent": self._user_agent, "Accept": "application/json"},
        )

    # ----- lifecycle ----------------------------------------------------

    async def aclose(self) -> None:
        await self._http.aclose()

    async def __aenter__(self) -> "AsyncSyrotpClient":
        return self

    async def __aexit__(self, *_: object) -> None:
        await self.aclose()

    # ----- public API ---------------------------------------------------

    async def start_verification(
        self,
        *,
        phone: str,
        purpose: str,
        client_ref: Optional[str] = None,
        locale: Optional[str] = None,
    ) -> Verification:
        """POST /v1/verifications. Required for both pk_live_* and sk_live_* keys."""
        if not isinstance(phone, str) or not phone:
            raise errors.SyrotpValidationError(
                code="validation_error", message="phone is required"
            )
        if not isinstance(purpose, str) or not purpose:
            raise errors.SyrotpValidationError(
                code="validation_error", message="purpose is required"
            )
        body: dict = {"phone": phone, "purpose": purpose}
        if client_ref is not None:
            body["client_ref"] = client_ref
        if locale is not None:
            body["locale"] = locale
        data = await self._request("POST", "/v1/verifications", body=body)
        return Verification.from_dict(data)

    async def get_verification(self, verification_id: str) -> Verification:
        """GET /v1/verifications/{id}. Available with both key kinds."""
        self._check_verification_id(verification_id)
        data = await self._request("GET", f"/v1/verifications/{verification_id}")
        return Verification.from_dict(data)

    async def cancel_verification(self, verification_id: str) -> Verification:
        """
        POST /v1/verifications/{id}/cancel. Idempotent server-side, but
        the SDK still caps retries at 1 to avoid log noise — see
        `docs/sdk-generation.md` §7.
        """
        self._check_verification_id(verification_id)
        # Override retries for this single call. min(self._retries, 1)
        # gives 0 if the user opted out of retries, 1 otherwise.
        original = self._retries
        try:
            self._retries = min(original, 1)
            data = await self._request("POST", f"/v1/verifications/{verification_id}/cancel")
        finally:
            self._retries = original
        return Verification.from_dict(data)

    async def wait_for_verification(
        self,
        verification_id: str,
        *,
        interval_ms: int = DEFAULT_WAIT_INTERVAL_MS,
        timeout_ms: int = DEFAULT_WAIT_TIMEOUT_MS,
    ) -> Verification:
        """
        Poll `get_verification` until the status is non-pending or the
        deadline elapses.

        Raises `SyrotpTimeoutError` if the deadline expires while still
        pending. Other errors propagate from `get_verification`.
        """
        if interval_ms < MIN_WAIT_INTERVAL_MS:
            interval_ms = MIN_WAIT_INTERVAL_MS  # silently floor — the server enforces rate limit
        if timeout_ms <= 0:
            raise errors.SyrotpConfigError("wait timeout_ms must be a positive int")

        loop = asyncio.get_event_loop()
        deadline = loop.time() + timeout_ms / 1000.0
        interval_s = interval_ms / 1000.0
        while True:
            v = await self.get_verification(verification_id)
            if v.status != VerificationStatus.PENDING:
                return v
            now = loop.time()
            if now >= deadline:
                raise errors.SyrotpTimeoutError("wait_for_verification deadline expired")
            # Sleep but don't overshoot the deadline.
            await asyncio.sleep(min(interval_s, deadline - now))

    # ----- internals ----------------------------------------------------

    def _build_user_agent(self, suffix: Optional[str]) -> str:
        import re

        base = f"syrotp-sdk-py/{__version__}"
        if not suffix:
            return base
        # Strip newlines / control chars from caller-supplied suffix so
        # they can't inject extra header lines.
        clean = re.sub(r"[\r\n\x00]", "", suffix).strip()
        return f"{base} {clean}" if clean else base

    @staticmethod
    def _check_verification_id(value: str) -> None:
        if not isinstance(value, str) or not _VERIFICATION_ID_RE.match(value):
            raise errors.SyrotpValidationError(
                code="validation_error",
                message="verification_id must match ^vrf_[A-Za-z0-9]+$",
            )

    async def _request(self, method: str, path: str, *, body: Optional[dict] = None) -> dict:
        url = f"{self._base_url}{path}"

        async def transport() -> httpx.Response:
            headers = {"Authorization": f"Bearer {self._api_key}"}
            if body is not None:
                return await self._http.request(method, url, json=body, headers=headers)
            return await self._http.request(method, url, headers=headers)

        def on_response(res: httpx.Response) -> dict:
            text = res.text or ""
            if 200 <= res.status_code < 300:
                if not text:
                    return {}
                try:
                    parsed = res.json()
                except ValueError as e:
                    raise errors.SyrotpError(
                        code="bad_response",
                        message=f"non-JSON response (status {res.status_code})",
                        http_status=res.status_code,
                    ) from e
                if not isinstance(parsed, dict):
                    raise errors.SyrotpError(
                        code="bad_response",
                        message=f"unexpected JSON shape (status {res.status_code})",
                        http_status=res.status_code,
                    )
                return parsed
            raise _error_from_response(res, text)

        return await aexecute_with_retries(
            transport,
            max_retries=self._retries,
            on_response=on_response,
        )


__all__ = ["AsyncSyrotpClient"]
