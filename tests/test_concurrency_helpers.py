"""Coverage for the shared thread-join assertions.

These guard a false-green class: a bounded join that never checks liveness.
"""

from __future__ import annotations

import threading
import time

import pytest

from tests._concurrency import join_all_or_fail, join_or_fail

SHARED_DEADLINE_TIMEOUT_SECONDS = 0.2
SHARED_DEADLINE_CEILING_SECONDS = 0.6


def _blocked_thread(release: threading.Event, name: str) -> threading.Thread:
    thread = threading.Thread(target=release.wait, name=name, daemon=True)
    thread.start()
    return thread


def test_join_or_fail_returns_when_the_worker_finishes() -> None:
    done = threading.Event()
    thread = threading.Thread(target=done.set, name="quick")
    thread.start()

    join_or_fail(thread, timeout=5.0)

    assert done.is_set()
    assert not thread.is_alive()


def test_join_or_fail_raises_when_the_worker_is_still_running() -> None:
    release = threading.Event()
    thread = _blocked_thread(release, "stuck-worker")
    try:
        with pytest.raises(AssertionError, match="stuck-worker"):
            join_or_fail(thread, timeout=0.05)
    finally:
        release.set()
        thread.join(timeout=5)


def test_join_or_fail_prefers_an_explicit_label() -> None:
    release = threading.Event()
    thread = _blocked_thread(release, "internal-name")
    try:
        with pytest.raises(AssertionError, match="the save worker"):
            join_or_fail(thread, timeout=0.05, what="the save worker")
    finally:
        release.set()
        thread.join(timeout=5)


def test_join_all_or_fail_names_every_survivor() -> None:
    release = threading.Event()
    threads = [_blocked_thread(release, f"worker-{index}") for index in range(2)]
    try:
        with pytest.raises(AssertionError) as caught:
            join_all_or_fail(threads, timeout=0.05)
        message = str(caught.value)
        assert "worker-0" in message
        assert "worker-1" in message
    finally:
        release.set()
        for thread in threads:
            thread.join(timeout=5)


def test_join_all_or_fail_shares_one_deadline_across_workers() -> None:
    # A per-thread timeout would let four blocked workers stretch the wait to
    # 4 * timeout; the shared deadline keeps it near a single timeout.
    release = threading.Event()
    threads = [_blocked_thread(release, f"slow-{index}") for index in range(4)]
    started = time.monotonic()
    try:
        with pytest.raises(AssertionError):
            join_all_or_fail(threads, timeout=SHARED_DEADLINE_TIMEOUT_SECONDS)
        elapsed = time.monotonic() - started
        assert elapsed < SHARED_DEADLINE_CEILING_SECONDS, (
            f"shared deadline should bound the wait, took {elapsed:.2f}s"
        )
    finally:
        release.set()
        for thread in threads:
            thread.join(timeout=5)
