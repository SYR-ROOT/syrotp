#!/usr/bin/env python3
"""
Send a single gateway heartbeat to keep the CI receiver healthy.

Used by `.github/workflows/ci.yml` between cross-stack SDK smoke steps
so the receiver's `last_heartbeat_at` doesn't age past
`RECEIVER_HEARTBEAT_TIMEOUT_SECONDS` (120s by default) while the next
SDK toolchain (Java/Gradle, Linux Swift, PHP/Composer) is being
provisioned.

Without this, the smoke job sporadically fails with
`SyrotpServerError(no_receiver: no healthy receiver available)` on
whichever SDK happens to run after a slow toolchain step. The retry
isn't a fix — the underlying issue is that the receiver's heartbeat
window is shorter than the gap between smoke steps.

Reads from env:
  - SYROTP_BASE_URL
  - SYROTP_RECEIVER_ID
  - SYROTP_GATEWAY_KEY

Requires the `apps/gsm-gateway` package to be importable (the smoke
job installs it once before the GSM cross-stack step; subsequent
steps reuse the same Python install).

Exits non-zero on any non-200 response so a missing or expired
receiver fails fast instead of being papered over.
"""

from __future__ import annotations

import os
import sys

from syrotp_gateway.client import SyrotpClient


def main() -> int:
    try:
        base_url = os.environ["SYROTP_BASE_URL"]
        receiver_id = os.environ["SYROTP_RECEIVER_ID"]
        signing_key = os.environ["SYROTP_GATEWAY_KEY"]
    except KeyError as missing:
        print(f"ci-heartbeat-revive: missing env var {missing}", file=sys.stderr)
        return 2

    client = SyrotpClient(
        base_url=base_url,
        receiver_id=receiver_id,
        signing_key=signing_key,
    )
    response = client.heartbeat(queue_depth=0, sim_signal_dbm=-77, battery_percent=100)
    print(f"ci-heartbeat-revive: status={response.status}")
    if response.status != 200:
        print(f"ci-heartbeat-revive: body={response.body[:200]}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
