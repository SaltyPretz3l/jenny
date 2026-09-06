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
