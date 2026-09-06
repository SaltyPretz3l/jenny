"""Shared concurrency assertions for tests that hand work to threads.

A bare ``thread.join(timeout=...)`` returns the same way whether the worker
finished or is still running, so a hung thread is indistinguishable from a fast
one. The test then inspects shared state, closes connections, or returns while
the worker is still live -- and the regression it exists to catch shows up as a
pass, because the assertions read state the worker never got to touch.

Always assert termination after a bounded join. Prefer these helpers over
hand-rolling the check so the failure message stays uniform.
"""

from __future__ import annotations

import threading
import time
from collections.abc import Iterable

DEFAULT_JOIN_TIMEOUT_SECONDS = 5.0


def join_or_fail(
    thread: threading.Thread,
    *,
    timeout: float = DEFAULT_JOIN_TIMEOUT_SECONDS,
    what: str | None = None,
) -> None:
    """Join ``thread`` and fail if it is still running afterwards."""
    thread.join(timeout=timeout)
    if thread.is_alive():
        label = what or thread.name or repr(thread)
        raise AssertionError(
            f"{label} did not finish within {timeout}s and is still running; "
            "anything this test inspects next is racing the worker."
        )


def join_all_or_fail(
    threads: Iterable[threading.Thread],
    *,
    timeout: float = DEFAULT_JOIN_TIMEOUT_SECONDS,
    what: str | None = None,
) -> None:
    """Join every thread under one shared deadline, failing on any survivor.

    The deadline is shared rather than per-thread so N workers cannot stretch
    the wait to N * timeout.
    """
    pending = list(threads)
    deadline = time.monotonic() + timeout
    for thread in pending:
        thread.join(timeout=max(0.0, deadline - time.monotonic()))
    alive = [thread.name or repr(thread) for thread in pending if thread.is_alive()]
    if alive:
        label = what or "worker threads"
        raise AssertionError(
            f"{label} still running after {timeout}s: {', '.join(alive)}; "
            "anything this test inspects next is racing them."
        )
