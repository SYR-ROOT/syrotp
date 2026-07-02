"""
HTTP client for the SYROTP server. Every request is signed with HMAC-SHA256
over "<ts>.<nonce>.<sha256(body)>" — see crypto.build_signature.

Returns a small Result tuple instead of raising for non-2xx, because the
worker decides per-status what to do (retry vs drop vs stop). Network
errors raise httpx exceptions and the worker catches them as transient.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from datetime import datetime, timezone

import httpx

from . import __version__
from .crypto import build_signature

log = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class Result:
    ok: bool
    status: int
    body: str


def _iso8601_utc(epoch_ms: int) -> str:
    return (
        datetime.fromtimestamp(epoch_ms / 1000, tz=timezone.utc)
        .strftime("%Y-%m-%dT%H:%M:%S.")
        + f"{(epoch_ms % 1000):03d}Z"
    )


class SyrotpClient:
    def __init__(
        self,
        base_url: str,
        receiver_id: str,
        signing_key: str,
        *,
        connect_timeout: float = 15.0,
        read_timeout: float = 20.0,
    ) -> None:
        if not base_url:
            raise ValueError("base_url is required")
        if not receiver_id.startswith("rcv_"):
            raise ValueError("receiver_id must start with rcv_")
        if not signing_key:
            raise ValueError("signing_key is required")

        self._base = base_url.rstrip("/")
        self._receiver = receiver_id
        self._key = signing_key
        self._http = httpx.Client(
            timeout=httpx.Timeout(read_timeout, connect=connect_timeout),
            headers={"User-Agent": f"syrotp-gsm-gateway/{__version__}"},
        )

    def close(self) -> None:
        self._http.close()

    def __enter__(self) -> "SyrotpClient":
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    def post_signed(self, path: str, json_body: dict) -> Result:
        # We serialize once and send THOSE EXACT BYTES — the HMAC is bound
        # to body bytes. Re-serializing inside httpx would change spacing
        # and break the signature.
        body_bytes = json.dumps(json_body, separators=(",", ":")).encode("utf-8")
        ts, nonce, sig = build_signature(self._key, body_bytes)
        url = self._base + path
        try:
            res = self._http.post(
                url,
                content=body_bytes,
                headers={
                    "Content-Type": "application/json",
                    "X-SYROTP-Receiver": self._receiver,
                    "X-SYROTP-Timestamp": ts,
                    "X-SYROTP-Nonce": nonce,
                    "X-SYROTP-Signature": sig,
                },
            )
        except httpx.HTTPError as e:
            log.warning("network error posting %s: %s", path, e)
            raise
        text = res.text
        return Result(ok=200 <= res.status_code < 300, status=res.status_code, body=text)

    def post_inbound(
        self,
        *,
        from_: str,
        to: str,
        body: str,
        received_at_ms: int,
        idempotency_key: str,
        sim_slot: int | None = None,
    ) -> Result:
        payload: dict = {
            "from": from_,
            "to": to,
            "body": body,
            "received_at": _iso8601_utc(received_at_ms),
            "idempotency_key": idempotency_key,
        }
        if sim_slot is not None:
            payload["sim_slot"] = sim_slot
        return self.post_signed("/v1/inbound/sms", payload)

    def heartbeat(
        self,
        *,
        queue_depth: int,
        sim_signal_dbm: int | None = None,
        battery_percent: int | None = None,
    ) -> Result:
        payload: dict = {
            "received_at": _iso8601_utc(int(__import__("time").time() * 1000)),
            "queue_depth": queue_depth,
            "app_version": __version__,
        }
        if sim_signal_dbm is not None:
            payload["sim_signal_dbm"] = sim_signal_dbm
        if battery_percent is not None:
            payload["battery_percent"] = battery_percent
        return self.post_signed(f"/v1/receivers/{self._receiver}/heartbeat", payload)
