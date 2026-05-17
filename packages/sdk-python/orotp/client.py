"""
Public sync client for the Syrian Reverse OTP Protocol.

    from syrotp import SyrotpClient

    client = SyrotpClient(
        base_url="https://otp.example.com",
        api_key="sk_live_...",
    )
    v = client.start_verification(phone="+963991234567", purpose="login")
    print(f"Send {v.message!r} to {v.send_to}")
    final = client.wait_for_verification(v.id)
    if final.status == "verified":
        ...

The shape of every operation is normative — see ../docs/sdk-contract.md.
The retry policy is normative — see ../docs/sdk-generation.md §7.
"""

from __future__ import annotations

import logging
import re
import time
from typing import Optional

import httpx

from . import errors
from ._http import _error_from_response, execute_with_retries
from ._version import __version__
from .types import Verification, VerificationStatus

log = logging.getLogger("syrotp")

_VERIFICATION_ID_RE = re.compile(r"^vrf_[A-Za-z0-9]+$")
_HTTP_URL_RE = re.compile(r"^https?://", re.IGNORECASE)

DEFAULT_TIMEOUT_MS = 15_000
DEFAULT_RETRIES = 2
DEFAULT_WAIT_INTERVAL_MS = 2_500
MIN_WAIT_INTERVAL_MS = 2_000  # server enforces per-IP read rate limit
DEFAULT_WAIT_TIMEOUT_MS = 5 * 60_000


class SyrotpClient:
    """
    Synchronous SYROTP client. One client = one HTTP connection pool.

    Use as a context manager to release sockets deterministically:

        with SyrotpClient(base_url=..., api_key=...) as client:
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
        transport: Optional[httpx.BaseTransport] = None,
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

        # Warn-on-cleartext for non-loopback / non-RFC1918 hosts. The
        # SDK does NOT outright refuse plain HTTP — local dev and
        # on-prem deployments need it — but ops gets a one-time warning.
        # See docs/sdk-generation.md §5.
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
        # httpx Timeout takes seconds; we expose ms at the SDK boundary
        # because the contract says so.
        timeout_s = timeout_ms / 1000.0
        self._http = httpx.Client(
            transport=transport,
            timeout=httpx.Timeout(timeout_s, connect=min(15.0, timeout_s)),
            headers={"User-Agent": self._user_agent, "Accept": "application/json"},
        )

    # ----- lifecycle ----------------------------------------------------

    def close(self) -> None:
        self._http.close()

    def __enter__(self) -> "SyrotpClient":
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    # ----- public API ---------------------------------------------------

    def start_verification(
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
        data = self._request("POST", "/v1/verifications", body=body)
        return Verification.from_dict(data)

    def get_verification(self, verification_id: str) -> Verification:
        """GET /v1/verifications/{id}. Available with both key kinds."""
        self._check_verification_id(verification_id)
        data = self._request("GET", f"/v1/verifications/{verification_id}")
        return Verification.from_dict(data)

    def cancel_verification(self, verification_id: str) -> Verification:
        """
        POST /v1/verifications/{id}/cancel. Idempotent server-side, but
        the SDK still caps retries at 1 to avoid log noise — see
        docs/sdk-generation.md §7.
        """
        self._check_verification_id(verification_id)
        # Override retries for this single call. min(self._retries, 1)
        # gives 0 if the user opted out of retries, 1 otherwise.
        original = self._retries
        try:
            self._retries = min(original, 1)
            data = self._request("POST", f"/v1/verifications/{verification_id}/cancel")
        finally:
            self._retries = original
        return Verification.from_dict(data)

    def wait_for_verification(
        self,
        verification_id: str,
        *,
        interval_ms: int = DEFAULT_WAIT_INTERVAL_MS,
        timeout_ms: int = DEFAULT_WAIT_TIMEOUT_MS,
    ) -> Verification:
        """
        Poll get_verification until the status is non-pending or the
        deadline elapses.

        Raises SyrotpTimeoutError if the deadline expires while still
        pending. Other errors propagate from get_verification.
        """
        if interval_ms < MIN_WAIT_INTERVAL_MS:
            interval_ms = MIN_WAIT_INTERVAL_MS  # silently floor — the server enforces rate limit
        if timeout_ms <= 0:
            raise errors.SyrotpConfigError("wait timeout_ms must be a positive int")

        deadline = time.monotonic() + timeout_ms / 1000.0
        interval_s = interval_ms / 1000.0
        while True:
            v = self.get_verification(verification_id)
            if v.status != VerificationStatus.PENDING:
                return v
            now = time.monotonic()
            if now >= deadline:
                raise errors.SyrotpTimeoutError("wait_for_verification deadline expired")
            # Sleep but don't overshoot the deadline.
            time.sleep(min(interval_s, deadline - now))

    # ----- internals ----------------------------------------------------

    def _build_user_agent(self, suffix: Optional[str]) -> str:
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

    def _request(self, method: str, path: str, *, body: Optional[dict] = None) -> dict:
        url = f"{self._base_url}{path}"

        def transport() -> httpx.Response:
            headers = {"Authorization": f"Bearer {self._api_key}"}
            if body is not None:
                return self._http.request(method, url, json=body, headers=headers)
            return self._http.request(method, url, headers=headers)

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

        return execute_with_retries(
            transport,
            max_retries=self._retries,
            on_response=on_response,
        )


def _is_loopback_or_private(url: str) -> bool:
    host = _host_only(url)
    if host in ("localhost", "127.0.0.1", "::1"):
        return True
    # Crude RFC1918 check; we don't need DNS resolution here.
    if host.startswith(("10.", "192.168.", "169.254.")):
        return True
    if host.startswith("172."):
        try:
            second = int(host.split(".", 2)[1])
        except (IndexError, ValueError):
            return False
        if 16 <= second <= 31:
            return True
    return False


def _host_only(url: str) -> str:
    # Strip scheme + port + path; we just want the hostname for warnings.
    rest = url.split("://", 1)[-1]
    host = rest.split("/", 1)[0].split(":", 1)[0]
    return host.lower()


__all__ = [
    "SyrotpClient",
    "DEFAULT_TIMEOUT_MS",
    "DEFAULT_RETRIES",
    "DEFAULT_WAIT_INTERVAL_MS",
    "DEFAULT_WAIT_TIMEOUT_MS",
]
