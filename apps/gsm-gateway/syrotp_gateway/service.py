"""
The orchestrator. Three loops, one process:

  1. reader  — every poll_seconds, AT+CMGL, push to queue, AT+CMGD
  2. worker  — drain queue, POST signed inbound, retry with backoff
  3. heartbeat — every heartbeat_seconds, POST signed heartbeat

A single threading.Event signals shutdown; SIGTERM / SIGINT trip it,
and every loop checks before sleeping.
"""

from __future__ import annotations

import logging
import signal
import threading
import time

import httpx

from .client import SyrotpClient, Result
from .config import GatewayConfig
from .modem import GsmModem
from .queue import InboundQueue

log = logging.getLogger(__name__)

# Exponential backoff for a single queue item — caps at 10 minutes.
_BACKOFF_SCHEDULE_SECONDS = (5, 15, 60, 180, 300, 600)
_MAX_ATTEMPTS_4XX = 5  # drop after this many 4xx (excluding 401, see below)


def _backoff_for_attempt(attempt: int) -> int:
    return _BACKOFF_SCHEDULE_SECONDS[
        min(attempt, len(_BACKOFF_SCHEDULE_SECONDS) - 1)
    ]


class GatewayService:
    def __init__(self, cfg: GatewayConfig) -> None:
        self.cfg = cfg
        self.queue = InboundQueue(cfg.queue_db_path)
        self.modem = GsmModem(cfg.modem_port, baudrate=cfg.modem_baudrate)
        self.client = SyrotpClient(
            base_url=cfg.server_url,
            receiver_id=cfg.receiver_id,
            signing_key=cfg.signing_key,
        )
        self._stop = threading.Event()
        # Auth-failure latch: once we see a 401 we stop trying to upload
        # (keeps us from DoS'ing the server on a bad key) but the reader
        # keeps queueing so a fix + restart drains backlog.
        self._auth_failed = threading.Event()
        self._threads: list[threading.Thread] = []

    # ----- lifecycle -----------------------------------------------------

    def start(self) -> None:
        log.info(
            "starting syrotp gsm gateway: receiver=%s msisdn=%s server=%s modem=%s",
            self.cfg.receiver_id, self.cfg.receiver_msisdn,
            self.cfg.server_url, self.cfg.modem_port,
        )
        self.modem.open()
        for fn, name in (
            (self._reader_loop, "reader"),
            (self._worker_loop, "worker"),
            (self._heartbeat_loop, "heartbeat"),
        ):
            t = threading.Thread(target=fn, name=name, daemon=True)
            t.start()
            self._threads.append(t)

    def stop(self) -> None:
        if self._stop.is_set():
            return
        log.info("shutdown requested")
        self._stop.set()
        for t in self._threads:
            t.join(timeout=8.0)
        self.modem.close()
        self.client.close()

    def install_signal_handlers(self) -> None:
        for s in (signal.SIGINT, signal.SIGTERM):
            signal.signal(s, lambda *_: self.stop())

    def join(self) -> None:
        try:
            while not self._stop.is_set():
                # Sleep in short slices so signals are responsive.
                self._stop.wait(0.5)
        except KeyboardInterrupt:
            self.stop()

    # ----- loops --------------------------------------------------------

    def _reader_loop(self) -> None:
        log.info("reader: poll every %.1fs", self.cfg.poll_seconds)
        while not self._stop.is_set():
            try:
                self._read_once()
            except Exception:
                log.exception("reader iteration failed")
            self._stop.wait(self.cfg.poll_seconds)

    def _read_once(self) -> None:
        items = self.modem.list_sms()
        if not items:
            return
        log.info("reader: %d SMS on modem", len(items))
        for sms in items:
            # Idempotency key derived from modem index + sender + first 32
            # chars of body. The server rejects duplicates with 409, so
            # a perfect key isn't required — this is just our local hint.
            key = f"gsm:{self.cfg.receiver_id}:{sms.received_at_ms}:{sms.index}:{sms.sender[-12:]}"
            added = self.queue.add(
                from_=sms.sender,
                to=self.cfg.receiver_msisdn,
                body=sms.body,
                received_at_ms=sms.received_at_ms,
                idempotency_key=key,
                sim_slot=self.cfg.sim_slot,
            )
            log.info("reader: queued idx=%d added=%s", sms.index, added)
            # Always delete from the modem after we've persisted (or
            # confirmed dup). Keeping SMS on the modem fills the SIM /
            # ME storage and stalls future deliveries.
            self.modem.delete_sms(sms.index)

    def _worker_loop(self) -> None:
        log.info("worker: started")
        while not self._stop.is_set():
            if self._auth_failed.is_set():
                # Don't spin — wait long enough to log occasionally.
                self._stop.wait(30)
                continue
            try:
                drained = self._drain_once()
            except Exception:
                log.exception("worker iteration failed")
                drained = 0
            # If nothing drained, sleep a bit; otherwise loop right away.
            if drained == 0:
                self._stop.wait(2.0)

    def _drain_once(self) -> int:
        items = self.queue.snapshot(limit=50)
        if not items:
            return 0
        for item in items:
            if self._stop.is_set():
                break
            try:
                res = self.client.post_inbound(
                    from_=item.from_,
                    to=item.to,
                    body=item.body,
                    received_at_ms=item.received_at_ms,
                    idempotency_key=item.idempotency_key,
                    sim_slot=item.sim_slot,
                )
            except httpx.HTTPError as e:
                log.warning("upload network error item=%d: %s", item.id, e)
                self.queue.bump_attempts(
                    item.id, backoff_seconds=_backoff_for_attempt(item.attempts)
                )
                continue
            self._handle_upload_result(item.id, item.attempts, res)
        return len(items)

    def _handle_upload_result(self, item_id: int, attempts: int, res: Result) -> None:
        if 200 <= res.status < 300 or res.status == 409:
            log.info("upload ok item=%d status=%d", item_id, res.status)
            self.queue.remove(item_id)
            return
        if res.status == 401:
            log.error("upload 401 — signing key likely wrong; pausing worker")
            self._auth_failed.set()
            return
        if 400 <= res.status < 500:
            log.warning(
                "upload %d item=%d attempts=%d body=%s",
                res.status, item_id, attempts + 1, res.body[:200],
            )
            if attempts + 1 >= _MAX_ATTEMPTS_4XX:
                log.error("dropping item %d after %d 4xx attempts", item_id, attempts + 1)
                self.queue.remove(item_id)
            else:
                self.queue.bump_attempts(
                    item_id, backoff_seconds=_backoff_for_attempt(attempts)
                )
            return
        # 5xx / unexpected: backoff and retry forever.
        log.warning("upload %d item=%d attempts=%d (transient)", res.status, item_id, attempts + 1)
        self.queue.bump_attempts(item_id, backoff_seconds=_backoff_for_attempt(attempts))

    def _heartbeat_loop(self) -> None:
        log.info("heartbeat: every %ds", self.cfg.heartbeat_seconds)
        while not self._stop.is_set():
            try:
                signal_dbm = self.modem.signal_dbm()
                depth = self.queue.depth()
                res = self.client.heartbeat(queue_depth=depth, sim_signal_dbm=signal_dbm)
                if 200 <= res.status < 300:
                    log.info("heartbeat ok depth=%d signal=%s", depth, signal_dbm)
                else:
                    log.warning("heartbeat %d: %s", res.status, res.body[:200])
            except Exception:
                log.exception("heartbeat failed")
            self._stop.wait(self.cfg.heartbeat_seconds)
