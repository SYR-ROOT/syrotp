"""
Syrian Reverse OTP Protocol — Python SDK.

Sync quickstart:

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

Async quickstart:

    import asyncio
    from syrotp import AsyncSyrotpClient

    async def main():
        async with AsyncSyrotpClient(
            base_url="https://otp.example.com",
            api_key="sk_live_...",
        ) as client:
            v = await client.start_verification(phone="+963991234567", purpose="login")
            final = await client.wait_for_verification(v.id)

    asyncio.run(main())

Both clients share the same `Verification` / `VerificationStatus`
types, error classes, retry numbers, and security canaries — see
`docs/sdk-generation.md` §7 for the canonical retry policy.

For the cross-language API contract, see:
  https://github.com/SYR-ROOT/syrotp/blob/main/docs/sdk-contract.md
"""

from ._version import __version__
from .async_client import AsyncSyrotpClient
from .client import SyrotpClient
from .errors import (
    SyrotpAuthError,
    SyrotpConfigError,
    SyrotpError,
    SyrotpNetworkError,
    SyrotpRateLimitError,
    SyrotpServerError,
    SyrotpTimeoutError,
    SyrotpValidationError,
)
from .types import Verification, VerificationStatus

__all__ = [
    "__version__",
    "SyrotpClient",
    "AsyncSyrotpClient",
    "Verification",
    "VerificationStatus",
    "SyrotpError",
    "SyrotpConfigError",
    "SyrotpAuthError",
    "SyrotpValidationError",
    "SyrotpRateLimitError",
    "SyrotpNetworkError",
    "SyrotpServerError",
    "SyrotpTimeoutError",
]
