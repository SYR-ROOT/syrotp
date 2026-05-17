# SYROTP Python SDK

Official Python SDK for the [Syrian Reverse OTP Protocol](https://github.com/SYR-ROOT/syrotp).
Both **sync** (`SyrotpClient`) and **async** (`AsyncSyrotpClient`)
clients ship in this package. Framework helpers (Django / FastAPI)
ship in follow-up PRs.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](../../LICENSE)
![python](https://img.shields.io/badge/python-3.10%2B-blue)

## Installation

```bash
pip install syrotp-sdk
```

## Quickstart

```python
from syrotp import SyrotpClient, VerificationStatus
from syrotp.errors import SyrotpError

with SyrotpClient(
    base_url="https://otp.example.com",
    api_key="sk_live_...",
) as client:
    v = client.start_verification(phone="+963991234567", purpose="login")
    print(f"Send {v.message!r} to {v.send_to}")

    final = client.wait_for_verification(v.id)
    if final.status == VerificationStatus.VERIFIED:
        print("phone owned by sender")
    elif final.status == VerificationStatus.EXPIRED:
        print("user took too long")
```

A runnable version lives in [`examples/quickstart.py`](examples/quickstart.py).
Set `SYROTP_BASE_URL` and `SYROTP_SECRET_KEY` (or `SYROTP_PUBLIC_KEY`) and
run it.

### Async usage

`AsyncSyrotpClient` exposes the same four methods over `async`/`await`,
backed by `httpx.AsyncClient`. Same retry numbers, same typed errors,
same security canaries — only the call surface differs.

```python
import asyncio
from syrotp import AsyncSyrotpClient, VerificationStatus

async def main():
    async with AsyncSyrotpClient(
        base_url="https://otp.example.com",
        api_key="sk_live_...",
    ) as client:
        v = await client.start_verification(phone="+963991234567", purpose="login")
        print(f"Send {v.message!r} to {v.send_to}")

        final = await client.wait_for_verification(v.id)
        if final.status == VerificationStatus.VERIFIED:
            print("phone owned by sender")

asyncio.run(main())
```

`asyncio.run()` is fine for scripts; in a long-lived async app
(FastAPI, aiohttp, anyio task groups), construct the client once at
startup and reuse it — `httpx.AsyncClient` pools connections.

### FastAPI integration

A small helper sub-package (`syrotp.fastapi`) wires `AsyncSyrotpClient`
into FastAPI's container so handlers can request it via `Depends`.
Install with the optional extra:

```bash
pip install "syrotp-sdk[fastapi]"
```

```python
from fastapi import Depends, FastAPI
from syrotp import AsyncSyrotpClient
from syrotp.fastapi import get_syrotp, setup_syrotp

app = FastAPI()
setup_syrotp(app)  # builds one client at startup, closes it at shutdown

@app.post("/verify/start")
async def start(syrotp: AsyncSyrotpClient = Depends(get_syrotp)):
    return await syrotp.start_verification(
        phone="+963991234567",
        purpose="login",
    )
```

`setup_syrotp(app)` reads `SYROTP_BASE_URL` / `SYROTP_SECRET_KEY` (with
`SYROTP_PUBLIC_KEY` fallback) / `SYROTP_TIMEOUT_MS` / `SYROTP_RETRIES` /
`SYROTP_USER_AGENT` from env via Pydantic Settings v2. To override
programmatically:

```python
from syrotp.fastapi import SyrotpSettings, setup_syrotp

setup_syrotp(app, SyrotpSettings(
    base_url="https://otp.example.com",
    api_key="sk_live_...",
    timeout_ms=10_000,
))
```

If your app already has a lifespan (DB pool, scheduler, …),
`setup_syrotp` composes with it: your startup runs first, then SYROTP's
client is built; shutdown unwinds in the reverse order. Pre-built
endpoints, webhook handlers, and auth/rate-limit middleware are
deliberately not part of this helper — those are opinionated choices
the host app should own.

### Django integration

`syrotp.django` mirrors the FastAPI helper for Django apps. Install
with the optional extra (Django 4.2+):

```bash
pip install "syrotp-sdk[django]"
```

Configure in `settings.py` (env-var fallback also works — same names
as the `syrotp` CLI / `scripts/smoke.mjs`):

```python
# settings.py
SYROTP_BASE_URL = "https://otp.example.com"
SYROTP_SECRET_KEY = "sk_live_..."
# optional:
# SYROTP_TIMEOUT_MS = 15000
# SYROTP_RETRIES = 2
# SYROTP_USER_AGENT = "my-django-app/1.0"
```

You don't need to add anything to `INSTALLED_APPS` — the helpers are
plain functions with lazy initialization.

In a sync view (or a DRF endpoint):

```python
from syrotp.django import get_syrotp_client

def start_verify(request):
    syrotp = get_syrotp_client()
    v = syrotp.start_verification(
        phone=request.POST["phone"],
        purpose="login",
    )
    return JsonResponse({"id": v.id, "send_to": v.send_to})
```

In an async view (Django 4.1+):

```python
from syrotp.django import get_syrotp_async_client

async def start_verify(request):
    syrotp = get_syrotp_async_client()
    v = await syrotp.start_verification(
        phone=request.POST["phone"],
        purpose="login",
    )
    return JsonResponse({"id": v.id, "send_to": v.send_to})
```

The sync client is a process-wide singleton (thread-safe). The async
client is one-singleton-per-event-loop, so test loops and
ASGI-worker loops don't share `httpx.AsyncClient` state. For
management commands or graceful shutdown, call
`syrotp.django.close_syrotp_clients()` (sync) or
`await syrotp.django.aclose_syrotp_clients()` (async).

## Server requirements

- **Minimum SYROTP server version:** `v0.3.0`.
- The SDK is wire-compatible with any `0.x` server. Newer server
  fields are preserved on `Verification.extras`; newer status values
  surface as `VerificationStatus.UNKNOWN`. See
  [`docs/sdk-versioning.md`](../../docs/sdk-versioning.md) for the
  version skew matrix.

## Public surface

```python
class SyrotpClient:
    def __init__(
        self,
        *,
        base_url: str,
        api_key: str,
        timeout_ms: int = 15_000,        # NEVER infinite
        retries: int = 2,                # network / 5xx / 429 only
        user_agent: str | None = None,
    ): ...

    def start_verification(
        self, *, phone: str, purpose: str,
        client_ref: str | None = None, locale: str | None = None,
    ) -> Verification: ...

    def get_verification(self, verification_id: str) -> Verification: ...
    def cancel_verification(self, verification_id: str) -> Verification: ...
    def wait_for_verification(
        self, verification_id: str, *,
        interval_ms: int = 2500, timeout_ms: int = 5 * 60_000,
    ) -> Verification: ...

    def close(self) -> None: ...


class AsyncSyrotpClient:
    """Same constructor signature as SyrotpClient. Methods are
    `async def`; cleanup is `await client.aclose()` (or use the async
    context manager)."""
    async def start_verification(...) -> Verification: ...
    async def get_verification(...) -> Verification: ...
    async def cancel_verification(...) -> Verification: ...
    async def wait_for_verification(...) -> Verification: ...
    async def aclose(self) -> None: ...
```

Plus the typed error hierarchy:

```
SyrotpError                          # base; catch this for "anything went wrong"
├── SyrotpConfigError                # bad construction args
├── SyrotpAuthError                  # 401 / 403  — NEVER retried
├── SyrotpValidationError            # 400 / local input check  — NEVER retried
├── SyrotpRateLimitError             # 429 (carries retry_after_seconds)
├── SyrotpNetworkError               # DNS / TLS / connection failures
├── SyrotpServerError                # 5xx
└── SyrotpTimeoutError               # per-request deadline expired
```

## Conformance

This SDK is SYROTP-compliant per
[`docs/sdk-contract.md`](../../docs/sdk-contract.md). Every box is
checked:

- [x] Constructor accepts `base_url`, `api_key`, `timeout_ms`, `retries`, `user_agent`.
- [x] Constructor rejects bad inputs with `SyrotpConfigError`.
- [x] `start_verification`, `get_verification`, `cancel_verification` return `Verification`.
- [x] `wait_for_verification` polls until non-pending; raises `SyrotpTimeoutError` at the deadline.
- [x] All seven typed error classes exist and are raised in the right categories.
- [x] Default `timeout_ms = 15000` — finite.
- [x] Default `retries = 2`; retries on network / `5xx` / `429` only.
- [x] `Retry-After` is honored on `429`.
- [x] No retry on `4xx` other than `429`. No retry on auth / validation / config / timeout.
- [x] `cancel_verification` capped at one retry to avoid log noise.
- [x] `User-Agent` includes `syrotp-sdk-py/<version>`.
- [x] Plain HTTP to a non-private host triggers a one-time warning at
      construction (no warning for `localhost` / RFC1918).
- [x] `api_key` is never present in `str(error)`, `repr(error)`, or
      anywhere on the `syrotp` logger.
- [x] Request bodies (which include the user's phone) are never
      logged by the SDK.
- [x] Live cross-stack test: every PR runs the SDK's
      `start_verification` / `cancel_verification` against the
      freshly-built TS server in CI's smoke job.

## Logging

The SDK logs to the `syrotp` logger. By default it logs:

- A one-time `WARNING` on construction if `base_url` is plain HTTP to
  a non-private host.
- `WARNING` on network errors during retries (without bodies).

To enable the SDK's logger:

```python
import logging
logging.getLogger("syrotp").setLevel(logging.WARNING)
```

The logger is **never** asked to log any of: `Authorization` header,
`api_key` argument, request body, response body, `phone`, `message`,
or `send_to`. If you wrap the SDK in something that does, you owned
the leak.

## Versioning

This SDK follows [`docs/sdk-versioning.md`](../../docs/sdk-versioning.md):

- `MAJOR` tracks the protocol's `MAJOR`.
- `MINOR` adds backwards-compatible methods / options.
- `PATCH` is bug fixes only.

## Development

```bash
cd packages/sdk-python
python -m venv .venv && . .venv/bin/activate    # or .venv\Scripts\activate on Windows
pip install -e ".[dev]"
pytest
```

## License

MIT — see [`../../LICENSE`](../../LICENSE).
