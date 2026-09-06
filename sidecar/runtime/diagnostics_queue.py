"""Bounded priority queue and listener for sidecar diagnostics."""

from __future__ import annotations

import logging
import threading
from collections import Counter, deque
from dataclasses import dataclass
from time import monotonic
from typing import Callable

DEFAULT_CAPACITY = 2_048
DEFAULT_SEVERE_RESERVE = 256
DIRECT_WRITE = "direct_write"
ENQUEUED = "enqueued"
DROPPED = "dropped"
_SEVERE_LEVEL = logging.WARNING


@dataclass(frozen=True)
class DiagnosticsLossSnapshot:
    dropped_by_level: dict[str, int]
    dropped_count: int
    capacity: int
    severe_reserve: int
    high_water_mark: int
    direct_write_count: int


def _level_name(record: logging.LogRecord) -> str:
    return logging.getLevelName(record.levelno).upper()


class BoundedDiagnosticsQueue:
    """FIFO queue that protects WARN/ERROR capacity under overload."""

    def __init__(
        self,
        *,
        capacity: int = DEFAULT_CAPACITY,
        severe_reserve: int = DEFAULT_SEVERE_RESERVE,
    ) -> None:
        self.capacity = max(1, int(capacity))
        self.severe_reserve = min(max(0, int(severe_reserve)), self.capacity)
        self._low_priority_limit = self.capacity - self.severe_reserve
        self._records: deque[logging.LogRecord] = deque()
        self._condition = threading.Condition()
        self._accepting = True
        self._pending_drops: Counter[str] = Counter()
        self._cumulative_drops: Counter[str] = Counter()
        self._high_water_mark = 0
        self._direct_write_count = 0

    def __len__(self) -> int:
        with self._condition:
            return len(self._records)

    @property
    def high_water_mark(self) -> int:
        with self._condition:
            return self._high_water_mark

    @property
    def is_closed(self) -> bool:
        with self._condition:
            return not self._accepting

    def _record_drop_locked(self, record: logging.LogRecord) -> None:
        level = _level_name(record)
        self._pending_drops[level] += 1
        self._cumulative_drops[level] += 1

    def record_external_drop(self, record: logging.LogRecord) -> None:
        with self._condition:
            self._record_drop_locked(record)

    def _low_priority_count_locked(self) -> int:
        return sum(record.levelno < _SEVERE_LEVEL for record in self._records)

    def _evict_oldest_locked(self, levelno: int) -> bool:
        for index, record in enumerate(self._records):
            if record.levelno == levelno:
                del self._records[index]
                self._record_drop_locked(record)
                return True
        return False

    def enqueue(self, record: logging.LogRecord) -> str:
        with self._condition:
            if not self._accepting:
                self._record_drop_locked(record)
                return DROPPED
            if record.levelno < _SEVERE_LEVEL:
                low_full = self._low_priority_count_locked() >= self._low_priority_limit
                total_full = len(self._records) >= self.capacity
                if record.levelno >= logging.INFO:
                    while (low_full or total_full) and self._evict_oldest_locked(logging.DEBUG):
                        low_full = self._low_priority_count_locked() >= self._low_priority_limit
                        total_full = len(self._records) >= self.capacity
                if low_full or total_full:
                    self._record_drop_locked(record)
                    return DROPPED
            else:
                while len(self._records) >= self.capacity and self._evict_oldest_locked(
                    logging.DEBUG
                ):
                    pass
                while len(self._records) >= self.capacity and self._evict_oldest_locked(
                    logging.INFO
                ):
                    pass
                if len(self._records) >= self.capacity:
                    self._direct_write_count += 1
                    return DIRECT_WRITE
            self._records.append(record)
            self._high_water_mark = max(self._high_water_mark, len(self._records))
            self._condition.notify()
            return ENQUEUED

    def get(self, timeout: float | None = None) -> logging.LogRecord | None:
        deadline = None if timeout is None else monotonic() + max(0.0, timeout)
        with self._condition:
            while not self._records:
                if not self._accepting:
                    return None
                remaining = None if deadline is None else deadline - monotonic()
                if remaining is not None and remaining <= 0:
                    return None
                self._condition.wait(remaining)
            return self._records.popleft()

    def close_admission(self) -> None:
        with self._condition:
            self._accepting = False
            self._condition.notify_all()

    def discard_remaining(self) -> int:
        with self._condition:
            count = len(self._records)
            while self._records:
                self._record_drop_locked(self._records.popleft())
            self._condition.notify_all()
            return count

    def take_loss_snapshot(self, *, force: bool = False) -> DiagnosticsLossSnapshot | None:
        with self._condition:
            if not self._pending_drops:
                return None
            if not force and len(self._records) >= self._low_priority_limit:
                return None
            dropped = dict(sorted(self._pending_drops.items()))
            self._pending_drops.clear()
            return DiagnosticsLossSnapshot(
                dropped_by_level=dropped,
                dropped_count=sum(dropped.values()),
                capacity=self.capacity,
                severe_reserve=self.severe_reserve,
                high_water_mark=self._high_water_mark,
                direct_write_count=self._direct_write_count,
            )


def build_loss_record(snapshot: DiagnosticsLossSnapshot) -> logging.LogRecord:
    record = logging.LogRecord(
        name="sidecar.runtime.diagnostics_queue",
        level=logging.WARNING,
        pathname="",
        lineno=0,
        msg="Sidecar diagnostics were dropped under load.",
        args=(),
        exc_info=None,
    )
    record.layer = "sidecar"
    record.component = "sidecar.runtime.diagnostics_queue"
    record.event = "sidecar.runtime.diagnostics_queue_dropped"
    record.status = "degraded"
    record.data = {
        "dropped_by_level": snapshot.dropped_by_level,
        "dropped_count": snapshot.dropped_count,
        "capacity": snapshot.capacity,
        "severe_reserve": snapshot.severe_reserve,
        "high_water_mark": snapshot.high_water_mark,
        "direct_write_count": snapshot.direct_write_count,
    }
    return record


class BoundedDiagnosticsListener:
    """Daemon listener with a bounded shutdown join."""

    def __init__(
        self,
        queue: BoundedDiagnosticsQueue,
        sink: logging.Handler,
        *,
        record_factory: Callable[[DiagnosticsLossSnapshot], logging.LogRecord] = build_loss_record,
    ) -> None:
        self.queue = queue
        self.sink = sink
        self.record_factory = record_factory
        self._thread = threading.Thread(
            target=self._run,
            name="sidecar-diagnostics-listener",
            daemon=True,
        )
        self._started = False
        self._sink_close_lock = threading.Lock()
        self._sink_close: Callable[[], None] | None = None
        self._sink_close_consumed = False

    @property
    def is_alive(self) -> bool:
        return self._thread.is_alive()

    def start(self) -> None:
        if self._started:
            return
        self._started = True
        self._thread.start()

    def _handle_direct(self, record: logging.LogRecord) -> bool:
        try:
            self.sink.handle(record)
            return True
        except Exception:  # noqa: BLE001
            self.queue.record_external_drop(record)
            return False

    def emit_pending_loss(self, *, force: bool = False) -> bool:
        snapshot = self.queue.take_loss_snapshot(force=force)
        if snapshot is None:
            return False
        return self._handle_direct(self.record_factory(snapshot))

    def _run(self) -> None:
        try:
            while True:
                record = self.queue.get(timeout=0.1)
                if record is None:
                    if self.queue.is_closed and len(self.queue) == 0:
                        break
                    continue
                self._handle_direct(record)
                self.emit_pending_loss()
            self.emit_pending_loss(force=True)
        finally:
            # Sink disposal transferred by a timed-out stop happens here —
            # after this thread's last sink use — so close is single-owner.
            with self._sink_close_lock:
                close = self._sink_close
                self._sink_close_consumed = True
            if close is not None:
                try:
                    close()
                except Exception:  # noqa: BLE001
                    pass

    def stop(self, *, timeout_seconds: float = 2.0) -> dict[str, int | bool]:
        self.queue.close_admission()
        if self._started:
            self._thread.join(max(0.0, timeout_seconds))
        timed_out = self.is_alive
        discarded = self.queue.discard_remaining() if timed_out else 0
        if not timed_out:
            self.emit_pending_loss(force=True)
        return {"drained": not timed_out, "timed_out": timed_out, "discarded": discarded}

    def transfer_sink_close(self, close: Callable[[], None]) -> bool:
        """After a timed-out stop, hand sink disposal to the still-draining
        listener thread. False means the thread already finished its final
        sink use (or never started) — the caller keeps ownership."""
        with self._sink_close_lock:
            if self._sink_close_consumed or not self._started or not self.is_alive:
                return False
            self._sink_close = close
            return True
