"""Tests for DebouncedNotificationWriter."""

from __future__ import annotations

import time

import pytest

from sidecar.runtime.chat_helpers import DebouncedNotificationWriter


class TestDebouncedNotificationWriter:
    def test_non_debounced_methods_pass_through(self) -> None:
        emitted: list[dict] = []
        writer = DebouncedNotificationWriter(emitted.append, interval_ms=500)
        writer({"method": "chat.token", "params": {"delta": "hello"}})
        writer({"method": "chat.thinking", "params": {"delta": "hmm"}})
        assert len(emitted) == 2

    def test_debounced_method_batched(self) -> None:
        emitted: list[dict] = []
        writer = DebouncedNotificationWriter(emitted.append, interval_ms=10_000)
        # First call goes through (last_emit_time is 0)
        writer({"method": "budget.update", "params": {"tokens": 100}})
        # Subsequent calls within interval are held
        writer({"method": "budget.update", "params": {"tokens": 200}})
        writer({"method": "budget.update", "params": {"tokens": 300}})
        # Only the first one went through (the 0-to-first gap always fires)
        assert len(emitted) == 1
        assert emitted[0]["params"]["tokens"] == 100

    def test_flush_emits_pending(self) -> None:
        emitted: list[dict] = []
        writer = DebouncedNotificationWriter(emitted.append, interval_ms=10_000)
        writer({"method": "budget.update", "params": {"tokens": 100}})
        writer({"method": "budget.update", "params": {"tokens": 999}})
        initial_count = len(emitted)
        writer.flush()
        # The latest pending value should be emitted on flush
        assert len(emitted) == initial_count + 1
        assert emitted[-1]["params"]["tokens"] == 999

    def test_flush_with_no_pending_is_noop(self) -> None:
        emitted: list[dict] = []
        writer = DebouncedNotificationWriter(emitted.append, interval_ms=500)
        writer.flush()
        assert len(emitted) == 0

    def test_multiple_debounced_methods_tracked_separately(self) -> None:
        emitted: list[dict] = []
        writer = DebouncedNotificationWriter(emitted.append, interval_ms=10_000)
        # First call fires immediately (time gap from 0).
        writer({"method": "budget.update", "params": {"v": 1}})
        # Second debounced method held (within interval).
        writer({"method": "cost.update", "params": {"v": 2}})
        assert len(emitted) == 1
        # Flush should emit the held cost.update.
        writer.flush()
        assert len(emitted) == 2
        methods = [e["method"] for e in emitted]
        assert "budget.update" in methods
        assert "cost.update" in methods

    @pytest.mark.slow  # real time.sleep(0.15) to let the debounce interval elapse
    def test_emits_after_interval_elapses(self) -> None:
        emitted: list[dict] = []
        writer = DebouncedNotificationWriter(emitted.append, interval_ms=100)
        writer({"method": "budget.update", "params": {"v": 1}})
        count_after_first = len(emitted)
        # Wait for interval to elapse
        time.sleep(0.15)
        writer({"method": "budget.update", "params": {"v": 2}})
        assert len(emitted) == count_after_first + 1
