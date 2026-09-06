from __future__ import annotations

import logging
import threading
import time

from sidecar.runtime.diagnostics_queue import (
    DIRECT_WRITE,
    DROPPED,
    ENQUEUED,
    BoundedDiagnosticsListener,
    BoundedDiagnosticsQueue,
    build_loss_record,
)


def _record(level: int, message: str) -> logging.LogRecord:
    return logging.LogRecord("test", level, "", 0, message, (), None)


class _CollectingHandler(logging.Handler):
    def __init__(self) -> None:
        super().__init__()
        self.records: list[logging.LogRecord] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.records.append(record)


def test_low_priority_occupancy_respects_severe_reserve() -> None:
    queue = BoundedDiagnosticsQueue(capacity=4, severe_reserve=1)
    assert [queue.enqueue(_record(logging.DEBUG, str(i))) for i in range(3)] == [
        ENQUEUED,
        ENQUEUED,
        ENQUEUED,
    ]
    assert queue.enqueue(_record(logging.DEBUG, "overflow")) == DROPPED
    assert len(queue) == 3


def test_info_evicts_debug_before_info_is_dropped() -> None:
    queue = BoundedDiagnosticsQueue(capacity=2, severe_reserve=0)
    queue.enqueue(_record(logging.DEBUG, "debug"))
    queue.enqueue(_record(logging.INFO, "info-1"))
    assert queue.enqueue(_record(logging.INFO, "info-2")) == ENQUEUED
    assert [queue.get().getMessage(), queue.get().getMessage()] == ["info-1", "info-2"]


def test_severe_evicts_debug_then_info_without_evicting_severe() -> None:
    queue = BoundedDiagnosticsQueue(capacity=3, severe_reserve=0)
    for level, message in (
        (logging.DEBUG, "debug"),
        (logging.INFO, "info"),
        (logging.WARNING, "warn"),
    ):
        queue.enqueue(_record(level, message))
    assert queue.enqueue(_record(logging.ERROR, "error-1")) == ENQUEUED
    assert queue.enqueue(_record(logging.ERROR, "error-2")) == ENQUEUED
    assert [queue.get().getMessage() for _ in range(3)] == ["warn", "error-1", "error-2"]


def test_all_severe_saturation_requests_direct_write() -> None:
    queue = BoundedDiagnosticsQueue(capacity=2, severe_reserve=1)
    queue.enqueue(_record(logging.WARNING, "warn"))
    queue.enqueue(_record(logging.ERROR, "error"))
    assert queue.enqueue(_record(logging.ERROR, "direct")) == DIRECT_WRITE
    assert len(queue) == 2


def test_direct_sink_failure_is_swallowed_and_counted() -> None:
    class _ThrowingHandler(logging.Handler):
        def handle(self, record: logging.LogRecord) -> bool:
            _ = record
            raise OSError("sink gone")

    queue = BoundedDiagnosticsQueue(capacity=1, severe_reserve=1)
    listener = BoundedDiagnosticsListener(queue, _ThrowingHandler())
    record = _record(logging.ERROR, "lost")

    assert listener._handle_direct(record) is False
    snapshot = queue.take_loss_snapshot(force=True)
    assert snapshot is not None
    assert snapshot.dropped_by_level == {"ERROR": 1}


def test_eviction_preserves_fifo_order_for_survivors() -> None:
    queue = BoundedDiagnosticsQueue(capacity=3, severe_reserve=0)
    queue.enqueue(_record(logging.INFO, "info-1"))
    queue.enqueue(_record(logging.DEBUG, "debug"))
    queue.enqueue(_record(logging.INFO, "info-2"))
    queue.enqueue(_record(logging.INFO, "info-3"))
    assert [queue.get().getMessage() for _ in range(3)] == ["info-1", "info-2", "info-3"]


def test_concurrent_producers_never_exceed_capacity() -> None:
    queue = BoundedDiagnosticsQueue(capacity=32, severe_reserve=4)

    def produce(prefix: int) -> None:
        for index in range(200):
            queue.enqueue(_record(logging.INFO, f"{prefix}-{index}"))

    threads = [threading.Thread(target=produce, args=(index,)) for index in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert len(queue) <= 32
    assert queue.high_water_mark <= 32


def test_recovery_emits_one_coalesced_bounded_loss_record() -> None:
    queue = BoundedDiagnosticsQueue(capacity=2, severe_reserve=0)
    queue.enqueue(_record(logging.DEBUG, "secret-payload"))
    queue.enqueue(_record(logging.INFO, "survivor"))
    queue.enqueue(_record(logging.INFO, "replacement"))
    queue.get()

    snapshot = queue.take_loss_snapshot()
    assert snapshot is not None
    record = build_loss_record(snapshot)
    assert record.event == "sidecar.runtime.diagnostics_queue_dropped"
    assert record.data["capacity"] == 2
    assert record.data["high_water_mark"] == 2
    assert "secret-payload" not in str(record.data)
    assert queue.take_loss_snapshot() is None


def test_listener_shutdown_drains_records_in_order() -> None:
    queue = BoundedDiagnosticsQueue(capacity=8, severe_reserve=2)
    sink = _CollectingHandler()
    listener = BoundedDiagnosticsListener(queue, sink)
    listener.start()
    for message in ("one", "two", "three"):
        queue.enqueue(_record(logging.INFO, message))

    result = listener.stop(timeout_seconds=1.0)

    assert result == {"drained": True, "timed_out": False, "discarded": 0}
    assert [record.getMessage() for record in sink.records] == ["one", "two", "three"]


def test_listener_reports_one_loss_episode_after_recovery() -> None:
    queue = BoundedDiagnosticsQueue(capacity=2, severe_reserve=0)
    sink = _CollectingHandler()
    queue.enqueue(_record(logging.DEBUG, "drop-me"))
    queue.enqueue(_record(logging.INFO, "keep-1"))
    queue.enqueue(_record(logging.INFO, "keep-2"))
    listener = BoundedDiagnosticsListener(queue, sink)
    listener.start()
    listener.stop(timeout_seconds=1.0)

    events = [getattr(record, "event", None) for record in sink.records]
    assert events.count("sidecar.runtime.diagnostics_queue_dropped") == 1


def test_timed_shutdown_returns_within_bound_and_discards_pending() -> None:
    entered = threading.Event()
    release = threading.Event()

    class _BlockingHandler(logging.Handler):
        def emit(self, record: logging.LogRecord) -> None:
            _ = record
            entered.set()
            release.wait(1.0)

    queue = BoundedDiagnosticsQueue(capacity=4, severe_reserve=1)
    listener = BoundedDiagnosticsListener(queue, _BlockingHandler())
    listener.start()
    queue.enqueue(_record(logging.INFO, "blocked"))
    queue.enqueue(_record(logging.WARNING, "discarded"))
    assert entered.wait(0.5)

    started = time.monotonic()
    result = listener.stop(timeout_seconds=0.02)
    elapsed = time.monotonic() - started
    release.set()

    assert elapsed < 0.2
    assert result["timed_out"] is True
    assert result["discarded"] == 1
