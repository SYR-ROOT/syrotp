"""
On-disk queue for inbound SMS pending upload to the SYROTP server.

We use SQLite because:
  - it's stdlib (no extra runtime dependency)
  - it survives crashes and reboots (WAL + fsync)
  - it gives us cheap atomic counters for retry bookkeeping
  - one writer (worker thread) + reader (modem thread) is well within
    SQLite's comfort zone with WAL mode

Items are inserted by the SMS reader and removed by the upload worker
once the server returns 2xx or 409 (duplicate). Permanent client errors
get a few attempts before being dropped to keep the queue from growing
without bound on a misconfigured deployment.
"""

from __future__ import annotations

import sqlite3
import threading
import time
from dataclasses import dataclass
from pathlib import Path

_SCHEMA = """
CREATE TABLE IF NOT EXISTS inbound_queue (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  from_msisdn     TEXT    NOT NULL,
  to_msisdn       TEXT    NOT NULL,
  body            TEXT    NOT NULL,
  received_at_ms  INTEGER NOT NULL,
  idempotency_key TEXT    NOT NULL UNIQUE,
  sim_slot        INTEGER,
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_try_at_ms  INTEGER NOT NULL DEFAULT 0,
  created_at_ms   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_inbound_queue_next_try
  ON inbound_queue (next_try_at_ms);
"""


@dataclass(frozen=True, slots=True)
class QueueItem:
    id: int
    from_: str
    to: str
    body: str
    received_at_ms: int
    idempotency_key: str
    sim_slot: int | None
    attempts: int


class InboundQueue:
    """Thread-safe by virtue of one connection per call + WAL mode."""

    def __init__(self, db_path: str | Path) -> None:
        self._path = str(db_path)
        # Synchronize writes from multiple threads via a process-local lock —
        # SQLite handles this anyway with BEGIN IMMEDIATE, but the lock also
        # serializes our read-modify-write of `attempts` cleanly.
        self._lock = threading.Lock()
        self._init_schema()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self._path, timeout=10.0, isolation_level=None)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        conn.execute("PRAGMA foreign_keys=ON")
        conn.row_factory = sqlite3.Row
        return conn

    def _init_schema(self) -> None:
        with self._lock, self._connect() as conn:
            conn.executescript(_SCHEMA)

    def add(
        self,
        *,
        from_: str,
        to: str,
        body: str,
        received_at_ms: int,
        idempotency_key: str,
        sim_slot: int | None = None,
    ) -> bool:
        """
        Insert one inbound SMS. Returns True if added, False if the
        idempotency key already exists (the modem re-read the same SMS
        before we could AT+CMGD it — safe to ignore).
        """
        now = int(time.time() * 1000)
        with self._lock, self._connect() as conn:
            try:
                conn.execute(
                    """
                    INSERT INTO inbound_queue
                      (from_msisdn, to_msisdn, body, received_at_ms,
                       idempotency_key, sim_slot, created_at_ms)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (from_, to, body, received_at_ms, idempotency_key, sim_slot, now),
                )
                return True
            except sqlite3.IntegrityError:
                return False

    def snapshot(self, *, limit: int = 100) -> list[QueueItem]:
        """Items whose next_try_at_ms is in the past, oldest first."""
        now = int(time.time() * 1000)
        with self._lock, self._connect() as conn:
            rows = conn.execute(
                """
                SELECT id, from_msisdn, to_msisdn, body, received_at_ms,
                       idempotency_key, sim_slot, attempts
                FROM inbound_queue
                WHERE next_try_at_ms <= ?
                ORDER BY id ASC
                LIMIT ?
                """,
                (now, limit),
            ).fetchall()
        return [
            QueueItem(
                id=r["id"],
                from_=r["from_msisdn"],
                to=r["to_msisdn"],
                body=r["body"],
                received_at_ms=r["received_at_ms"],
                idempotency_key=r["idempotency_key"],
                sim_slot=r["sim_slot"],
                attempts=r["attempts"],
            )
            for r in rows
        ]

    def bump_attempts(self, item_id: int, *, backoff_seconds: int) -> None:
        """Bump attempts and schedule the next try `backoff_seconds` from now."""
        next_try = int(time.time() * 1000) + backoff_seconds * 1000
        with self._lock, self._connect() as conn:
            conn.execute(
                """
                UPDATE inbound_queue
                SET attempts = attempts + 1,
                    next_try_at_ms = ?
                WHERE id = ?
                """,
                (next_try, item_id),
            )

    def remove(self, item_id: int) -> None:
        with self._lock, self._connect() as conn:
            conn.execute("DELETE FROM inbound_queue WHERE id = ?", (item_id,))

    def depth(self) -> int:
        with self._lock, self._connect() as conn:
            row = conn.execute("SELECT COUNT(*) AS n FROM inbound_queue").fetchone()
        return int(row["n"])
