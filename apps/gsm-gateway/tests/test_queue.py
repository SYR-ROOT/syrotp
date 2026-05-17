"""
SQLite queue lifecycle tests. We don't mock SQLite — the on-disk file
is the production code path, and tests against a fresh tmp file run
in milliseconds.
"""
from __future__ import annotations

import time
from pathlib import Path

import pytest

from syrotp_gateway.queue import InboundQueue


@pytest.fixture
def queue(tmp_path: Path) -> InboundQueue:
    return InboundQueue(tmp_path / "queue.db")


def _add(q: InboundQueue, key: str, body: str = "VERIFY 123456") -> bool:
    return q.add(
        from_="+963991111111",
        to="+963998887777",
        body=body,
        received_at_ms=int(time.time() * 1000),
        idempotency_key=key,
    )


def test_add_and_snapshot(queue: InboundQueue):
    assert _add(queue, "k1") is True
    items = queue.snapshot()
    assert len(items) == 1
    assert items[0].idempotency_key == "k1"
    assert items[0].attempts == 0


def test_duplicate_key_returns_false(queue: InboundQueue):
    assert _add(queue, "k1") is True
    assert _add(queue, "k1") is False
    assert len(queue.snapshot()) == 1


def test_remove(queue: InboundQueue):
    _add(queue, "k1")
    [item] = queue.snapshot()
    queue.remove(item.id)
    assert queue.snapshot() == []


def test_bump_attempts_schedules_future_retry(queue: InboundQueue):
    _add(queue, "k1")
    [item] = queue.snapshot()
    queue.bump_attempts(item.id, backoff_seconds=60)
    # next_try is 60s in the future, so the snapshot must be empty now.
    assert queue.snapshot() == []
    # Forcing a far-future "now" by manipulating snapshot's filter would
    # require freezing time; instead just assert depth tracks it.
    assert queue.depth() == 1


def test_bump_attempts_increments_counter(queue: InboundQueue):
    _add(queue, "k1")
    [item] = queue.snapshot()
    queue.bump_attempts(item.id, backoff_seconds=0)
    [refreshed] = queue.snapshot()
    assert refreshed.attempts == 1
    queue.bump_attempts(refreshed.id, backoff_seconds=0)
    [refreshed2] = queue.snapshot()
    assert refreshed2.attempts == 2


def test_depth(queue: InboundQueue):
    assert queue.depth() == 0
    _add(queue, "k1")
    _add(queue, "k2")
    _add(queue, "k3")
    assert queue.depth() == 3


def test_snapshot_orders_by_id(queue: InboundQueue):
    for i in range(5):
        _add(queue, f"k{i}")
    items = queue.snapshot()
    ids = [it.id for it in items]
    assert ids == sorted(ids)


def test_snapshot_respects_limit(queue: InboundQueue):
    for i in range(20):
        _add(queue, f"k{i}")
    items = queue.snapshot(limit=7)
    assert len(items) == 7
