"""Unit tests for the builtin server's cross-thread cancellation slot."""

from __future__ import annotations

import pytest

from sidecar.ai.tools.builtins import cancellation


@pytest.fixture(autouse=True)
def _clean_slot() -> None:
    cancellation.end_tool_call()
    yield
    cancellation.end_tool_call()


def test_cancel_of_active_request_sets_abort_event() -> None:
    event = cancellation.begin_tool_call(7)
    assert cancellation.current_abort_event() is event
    assert cancellation.cancel_request(7) is True
    assert event.is_set()


def test_cancel_of_other_request_leaves_active_call_running() -> None:
    event = cancellation.begin_tool_call(7)
    assert cancellation.cancel_request(8) is False
    assert not event.is_set()


def test_cancel_of_queued_request_aborts_it_when_it_begins() -> None:
    active_event = cancellation.begin_tool_call(7)

    assert cancellation.cancel_request(8) is False
    assert not active_event.is_set()

    cancellation.end_tool_call()
    queued_event = cancellation.begin_tool_call(8)
    assert queued_event.is_set()


def test_pre_cancel_race_marks_next_matching_call_aborted() -> None:
    # The reader thread can observe the cancellation before the dispatch
    # thread registers the call — the slot must not lose it.
    assert cancellation.cancel_request(9) is False
    event = cancellation.begin_tool_call(9)
    assert event.is_set()


def test_pre_cancel_for_other_id_does_not_leak_into_next_call() -> None:
    cancellation.cancel_request(9)
    event = cancellation.begin_tool_call(10)
    assert not event.is_set()


def test_ids_match_across_int_str_drift() -> None:
    event = cancellation.begin_tool_call(11)
    assert cancellation.cancel_request("11") is True
    assert event.is_set()


def test_end_tool_call_clears_slot_and_pre_cancel() -> None:
    cancellation.begin_tool_call(12)
    cancellation.end_tool_call()
    assert cancellation.current_abort_event() is None
    cancellation.cancel_request(13)
    cancellation.end_tool_call()
    event = cancellation.begin_tool_call(13)
    assert not event.is_set()


def test_cancel_request_none_is_ignored() -> None:
    event = cancellation.begin_tool_call(None)
    assert cancellation.cancel_request(None) is False
    assert not event.is_set()


# -- row 180: the per-call wake event, separate from the abort event ------------------------------


def test_wake_of_active_request_sets_the_wake_event_and_leaves_abort_alone() -> None:
    abort = cancellation.begin_tool_call(21)
    wake = cancellation.current_wake_event()
    assert wake is not None and wake is not abort
    assert cancellation.wake_request(21) is True
    assert wake.is_set()
    assert not abort.is_set()


def test_wake_of_another_request_leaves_the_active_call_alone() -> None:
    cancellation.begin_tool_call(21)
    wake = cancellation.current_wake_event()
    assert cancellation.wake_request(22) is False
    assert wake is not None and not wake.is_set()


def test_wake_before_the_call_begins_is_remembered() -> None:
    # The reader thread can see the wake before the dispatch thread registers the call.
    assert cancellation.wake_request(23) is False
    cancellation.begin_tool_call(23)
    wake = cancellation.current_wake_event()
    assert wake is not None and wake.is_set()


def test_a_wake_never_leaks_into_the_next_call_or_a_cancel() -> None:
    cancellation.begin_tool_call(24)
    cancellation.wake_request(24)
    cancellation.end_tool_call()
    assert cancellation.current_wake_event() is None
    abort = cancellation.begin_tool_call(25)
    wake = cancellation.current_wake_event()
    assert wake is not None and not wake.is_set() and not abort.is_set()
    cancellation.cancel_request(25)
    assert abort.is_set() and not wake.is_set()


def test_wake_ids_match_across_int_str_drift_and_none_is_ignored() -> None:
    cancellation.begin_tool_call(26)
    wake = cancellation.current_wake_event()
    assert cancellation.wake_request(None) is False
    assert cancellation.wake_request("26") is True
    assert wake is not None and wake.is_set()
