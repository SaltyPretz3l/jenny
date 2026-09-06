"""Unit contract for the process-wide engine-activity clock.

The clock feeds the stream-inactivity watchdog's liveness deferral
(generation_runtime_stream); its whole API is three functions, but the
None-before-first-stamp and monotone-age behaviors are load-bearing — a wrong
default would either defer stalls forever (age 0 when unstamped) or never
defer them (None after stamping).
"""

from __future__ import annotations

import time
from collections.abc import Iterator

import pytest

from sidecar.ai import engine_liveness


@pytest.fixture(autouse=True)
def _isolate_engine_liveness_state() -> Iterator[None]:
    with engine_liveness._state.lock:  # noqa: SLF001
        engine_liveness._state.last_activity_monotonic = None  # noqa: SLF001
        engine_liveness._state.active_generations = 0  # noqa: SLF001
    yield
    with engine_liveness._state.lock:  # noqa: SLF001
        engine_liveness._state.last_activity_monotonic = None  # noqa: SLF001
        engine_liveness._state.active_generations = 0  # noqa: SLF001


def test_clock_is_none_until_first_stamp_and_ages_after() -> None:
    assert engine_liveness.seconds_since_engine_activity() is None

    engine_liveness.record_engine_activity()
    first = engine_liveness.seconds_since_engine_activity()
    assert first is not None and 0.0 <= first < 5.0

    # Windows timer granularity (~15.6ms) can under-sleep; assert monotone
    # growth rather than an exact floor.
    time.sleep(0.05)
    aged = engine_liveness.seconds_since_engine_activity()
    assert aged is not None and aged > first and aged >= 0.01

    # A fresh stamp rewinds the age.
    engine_liveness.record_engine_activity()
    restamped = engine_liveness.seconds_since_engine_activity()
    assert restamped is not None and restamped < aged


def test_generation_counter_tracks_flight_and_floors_at_zero() -> None:
    assert engine_liveness.active_generation_count() == 0
    engine_liveness.begin_generation()
    engine_liveness.begin_generation()
    assert engine_liveness.active_generation_count() == 2
    engine_liveness.end_generation()
    assert engine_liveness.active_generation_count() == 1
    engine_liveness.end_generation()
    # Extra ends never go negative (idempotent close paths).
    engine_liveness.end_generation()
    assert engine_liveness.active_generation_count() == 0
