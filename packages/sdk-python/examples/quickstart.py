"""
Quickstart for the SYROTP Python SDK.

Reads SYROTP_BASE_URL and SYROTP_SECRET_KEY (or SYROTP_PUBLIC_KEY) from
the environment — same convention as `scripts/smoke.mjs` and the
`syrotp` CLI.

Run against a running SYROTP server:

    export SYROTP_BASE_URL=http://localhost:3000
    export SYROTP_SECRET_KEY=sk_live_...
    python examples/quickstart.py +963991234567 login
"""

from __future__ import annotations

import os
import sys

from syrotp import SyrotpClient, VerificationStatus
from syrotp.errors import SyrotpError


def main(argv: list[str]) -> int:
    if len(argv) < 3:
        print(f"usage: {argv[0]} <phone> <purpose>", file=sys.stderr)
        return 2

    base_url = os.environ.get("SYROTP_BASE_URL")
    api_key = os.environ.get("SYROTP_SECRET_KEY") or os.environ.get("SYROTP_PUBLIC_KEY")
    if not base_url or not api_key:
        print("SYROTP_BASE_URL and SYROTP_SECRET_KEY (or SYROTP_PUBLIC_KEY) must be set", file=sys.stderr)
        return 2

    phone, purpose = argv[1], argv[2]

    with SyrotpClient(base_url=base_url, api_key=api_key) as client:
        try:
            v = client.start_verification(phone=phone, purpose=purpose)
        except SyrotpError as e:
            print(f"start_verification failed: {e}", file=sys.stderr)
            return 1

        if v.status != VerificationStatus.PENDING:
            print(f"unexpected status from start: {v.status.value}", file=sys.stderr)
            return 1

        print(f"verification id: {v.id}")
        print(f"  send: {v.message!r}")
        print(f"  to:   {v.send_to}")
        print(f"  for phone {v.phone_masked}")

        # Demo only — cancel right away. A real app would poll
        # wait_for_verification while the user sends the SMS.
        cancelled = client.cancel_verification(v.id)
        print(f"final status after cancel: {cancelled.status.value}")
        return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
