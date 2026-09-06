from __future__ import annotations

import threading
from dataclasses import FrozenInstanceError

import pytest

from sidecar.ai.routing.loop_runtime import LoopRuntime
from sidecar.ai.routing.tool_observation import (
    ALL_KINDS,
    KIND_MODEL_REASONING_DELTA,
    KIND_MODEL_TOOL_REQUESTED,
    KIND_MODEL_VISIBLE_TEXT_DELTA,
    KIND_TOOL_EXECUTION_FAILED,
    KIND_TOOL_EXECUTION_OBSERVED,
    KIND_TOOL_EXECUTION_STARTED,
    KIND_TURN_COMPLETED,
    KIND_TURN_FAILED,
    KIND_USER_APPROVAL_REJECTED,
    KIND_USER_APPROVAL_REQUESTED,
    ToolObservationEvent,
    ToolObservationStore,
    observation_signature,
    recent_observations_payload,
    tool_argument_fingerprint,
)


def _make_event(
    kind: str = KIND_MODEL_TOOL_REQUESTED,
    *,
    request_id: str = "req_42",
    turn_id: str | None = "turn_a",
    tool_call_id: str | None = "call_001",
    tool_name: str | None = "read_file",
    summary: str = "summary",
    error_code: str | None = None,
    sequence: int = 0,
) -> ToolObservationEvent:
    return ToolObservationEvent(
        kind=kind,
        request_id=request_id,
        turn_id=turn_id,
        tool_call_id=tool_call_id,
        tool_name=tool_name,
        summary=summary,
        error_code=error_code,
        sequence=sequence,
    )


# ---------------------------------------------------------------------------
# Kind constants
# ---------------------------------------------------------------------------


def test_all_kinds_contains_exactly_ten_values() -> None:
    assert len(ALL_KINDS) == 10
    assert ALL_KINDS == frozenset(
        {
            KIND_MODEL_TOOL_REQUESTED,
            KIND_TOOL_EXECUTION_STARTED,
            KIND_TOOL_EXECUTION_OBSERVED,
            KIND_TOOL_EXECUTION_FAILED,
            KIND_USER_APPROVAL_REQUESTED,
            KIND_USER_APPROVAL_REJECTED,
            KIND_MODEL_VISIBLE_TEXT_DELTA,
            KIND_MODEL_REASONING_DELTA,
            KIND_TURN_COMPLETED,
            KIND_TURN_FAILED,
        }
    )


# ---------------------------------------------------------------------------
# DTO behavior
# ---------------------------------------------------------------------------


def test_event_construction_freezes_fields() -> None:
    event = _make_event()
    with pytest.raises(FrozenInstanceError):
        event.kind = "other"  # type: ignore[misc]


def test_to_payload_strips_underscore_prefixed_fields() -> None:
    event = ToolObservationEvent(
        kind=KIND_TURN_COMPLETED,
        request_id="req_x",
        summary="done",
        sequence=7,
        _argument_fingerprint="private-args-hash",
    )
    payload = event.to_payload()
    assert all(not key.startswith("_") for key in payload)
    assert set(payload.keys()) == {
        "kind",
        "request_id",
        "turn_id",
        "tool_call_id",
        "tool_name",
        "summary",
        "error_code",
        "sequence",
    }
    assert payload["sequence"] == 7


# ---------------------------------------------------------------------------
# Store sequencing + eviction
# ---------------------------------------------------------------------------


def test_store_assigns_monotonic_sequence_per_turn() -> None:
    store = ToolObservationStore()
    store.ensure_turn(request_id="req_seq", turn_id="turn_a")
    for _ in range(5):
        store.record(_make_event(request_id="req_seq"))
    events = store.recent_events(request_id="req_seq", limit=10)
    assert tuple(event.sequence for event in events) == (1, 2, 3, 4, 5)


def test_ensure_turn_preserves_approval_resume_observations_and_sequence() -> None:
    store = ToolObservationStore()
    store.ensure_turn(request_id="req_approval", turn_id="turn_a")
    store.record(
        _make_event(kind=KIND_MODEL_TOOL_REQUESTED, request_id="req_approval")
    )
    store.record(
        _make_event(kind=KIND_USER_APPROVAL_REQUESTED, request_id="req_approval")
    )

    store.ensure_turn(request_id="req_approval", turn_id="turn_a")
    store.record(
        _make_event(kind=KIND_TOOL_EXECUTION_STARTED, request_id="req_approval")
    )
    store.record(
        _make_event(kind=KIND_TOOL_EXECUTION_OBSERVED, request_id="req_approval")
    )

    events = store.recent_events(request_id="req_approval", limit=10)
    assert [event.kind for event in events] == [
        KIND_MODEL_TOOL_REQUESTED,
        KIND_USER_APPROVAL_REQUESTED,
        KIND_TOOL_EXECUTION_STARTED,
        KIND_TOOL_EXECUTION_OBSERVED,
    ]
    assert [event.sequence for event in events] == [1, 2, 3, 4]
    assert {event.turn_id for event in events} == {"turn_a"}


def test_store_evicts_oldest_when_per_turn_cap_exceeded() -> None:
    store = ToolObservationStore(max_events_per_turn=10)
    store.ensure_turn(request_id="req_cap")
    for index in range(15):
        store.record(_make_event(request_id="req_cap", summary=f"event-{index}"))
    events = store.recent_events(request_id="req_cap", limit=20)
    assert len(events) == 10
    # Oldest five (event-0 .. event-4) dropped; remaining sequence numbers
    # are 6..15 (1-indexed assignment, 15 events appended total).
    assert tuple(event.sequence for event in events) == tuple(range(6, 16))
    assert events[0].summary == "event-5"
    assert events[-1].summary == "event-14"


def test_store_evicts_oldest_turn_when_retention_cap_exceeded() -> None:
    store = ToolObservationStore(max_retained_turns=3)
    for index in range(5):
        store.ensure_turn(request_id=f"req_{index}")
        store.record(_make_event(request_id=f"req_{index}"))
    snapshot = store.retention_snapshot()
    assert snapshot["retained_turn_count"] == 3
    assert snapshot["turn_eviction_count"] == 2
    assert store.recent_events(request_id="req_0", limit=10) == ()
    assert store.recent_events(request_id="req_1", limit=10) == ()
    assert len(store.recent_events(request_id="req_4", limit=10)) == 1


def test_recent_events_returns_last_n() -> None:
    store = ToolObservationStore()
    store.ensure_turn(request_id="req_recent")
    for index in range(12):
        store.record(_make_event(request_id="req_recent", summary=f"event-{index}"))
    recent = store.recent_events(request_id="req_recent", limit=5)
    assert len(recent) == 5
    assert recent[0].summary == "event-7"
    assert recent[-1].summary == "event-11"


def test_recent_events_returns_empty_for_unknown_request_id() -> None:
    store = ToolObservationStore()
    assert store.recent_events(request_id="missing") == ()


def test_record_lazily_creates_buffer_when_ensure_turn_skipped() -> None:
    store = ToolObservationStore()
    store.record(_make_event(request_id="req_lazy", summary="hello"))
    events = store.recent_events(request_id="req_lazy", limit=10)
    assert len(events) == 1
    assert events[0].sequence == 1


# ---------------------------------------------------------------------------
# Payload helper
# ---------------------------------------------------------------------------


def test_recent_observations_payload_shape() -> None:
    store = ToolObservationStore()
    store.ensure_turn(request_id="req_payload")
    for index in range(3):
        store.record(
            _make_event(
                request_id="req_payload",
                tool_call_id=f"call_{index}",
                summary=f"summary-{index}",
            )
        )
    payload = recent_observations_payload(store, request_id="req_payload", limit=50)
    assert isinstance(payload, list)
    assert len(payload) == 3
    for entry in payload:
        assert set(entry.keys()) == {
            "kind",
            "request_id",
            "turn_id",
            "tool_call_id",
            "tool_name",
            "summary",
            "error_code",
            "sequence",
        }
    assert [entry["sequence"] for entry in payload] == [1, 2, 3]


def test_recent_observations_payload_returns_empty_for_none_store() -> None:
    assert recent_observations_payload(None, request_id="req") == []


def test_recent_observations_payload_returns_empty_for_missing_request_id() -> None:
    store = ToolObservationStore()
    assert recent_observations_payload(store, request_id="") == []
    assert recent_observations_payload(store, request_id=None) == []


def test_recent_observations_payload_handles_store_failure() -> None:
    class _FaultyStore:
        def recent_events(self, **_: object) -> tuple[ToolObservationEvent, ...]:
            raise RuntimeError("boom")

    payload = recent_observations_payload(
        _FaultyStore(),  # type: ignore[arg-type]
        request_id="req_x",
    )
    assert payload == []


# ---------------------------------------------------------------------------
# Signature semantics
# ---------------------------------------------------------------------------


def test_signature_excludes_request_id_turn_id_and_sequence() -> None:
    base = _make_event()
    same_semantic = ToolObservationEvent(
        kind=base.kind,
        request_id="completely-different",
        turn_id="other-turn",
        tool_call_id=base.tool_call_id,
        tool_name=base.tool_name,
        summary=base.summary,
        error_code=base.error_code,
        sequence=999,
    )
    assert observation_signature(base) == observation_signature(same_semantic)


def test_signature_ignores_summary_variation() -> None:
    a = _make_event(summary="read_file path=a.txt")
    b = _make_event(summary="read_file path=b.txt")
    assert observation_signature(a) == observation_signature(b)


def test_signature_distinguishes_different_kinds() -> None:
    a = _make_event(kind=KIND_TOOL_EXECUTION_STARTED)
    b = _make_event(kind=KIND_TOOL_EXECUTION_OBSERVED)
    assert observation_signature(a) != observation_signature(b)


def test_signature_distinguishes_different_error_codes() -> None:
    a = _make_event(kind=KIND_TOOL_EXECUTION_FAILED, error_code="CMP-TOOL-0001")
    b = _make_event(kind=KIND_TOOL_EXECUTION_FAILED, error_code="CMP-TOOL-0002")
    assert observation_signature(a) != observation_signature(b)


def test_signature_fails_open_on_distinct_call_ids_without_argument_fingerprints() -> None:
    a = _make_event(tool_call_id="call-a")
    b = _make_event(tool_call_id="call-b")
    assert observation_signature(a) != observation_signature(b)


def test_signature_fails_open_without_argument_fingerprint_or_call_id() -> None:
    a = _make_event(tool_call_id="", sequence=1)
    b = _make_event(tool_call_id="", sequence=2)
    assert observation_signature(a) != observation_signature(b)


def test_argument_fingerprint_ignores_volatile_and_private_keys() -> None:
    base = tool_argument_fingerprint({"path": "README.md"})
    decorated = tool_argument_fingerprint(
        {
            "path": "README.md",
            "request_id": "req-other",
            "trace_id": "trace-other",
            "_private": "ignored",
            # The approval-card explanation never changes the effect, so a
            # reworded purpose must not defeat the repeat-call guardrail.
            "purpose": "Explain the call",
        }
    )
    assert base == decorated
    assert base != tool_argument_fingerprint({"path": "other.md"})


def test_runtime_audit_attaches_private_argument_fingerprint_from_emitted_call() -> None:
    store = ToolObservationStore()
    runtime = LoopRuntime(request_id="req-audit", observation_store=store)
    runtime.record_tool_executing(
        call_id="call-a",
        tool_name="read_file",
        arguments={"path": "README.md", "request_id": "volatile"},
    )

    runtime.audit(
        KIND_TOOL_EXECUTION_OBSERVED,
        tool_call_id="call-a",
        tool_name="read_file",
        summary="read completed",
    )

    event = store.recent_events(request_id="req-audit", limit=10)[0]
    assert event._argument_fingerprint == tool_argument_fingerprint(
        {"path": "README.md"}
    )
    assert "_argument_fingerprint" not in event.to_payload()


# ---------------------------------------------------------------------------
# Concurrency
# ---------------------------------------------------------------------------


def test_record_under_concurrent_writers() -> None:
    threads_count = 8
    inserts_per_thread = 50
    total = threads_count * inserts_per_thread
    # Capacity must be >= total so the deque does not evict older events;
    # the assertion below verifies *every* recorded event landed.
    store = ToolObservationStore(max_events_per_turn=total)
    store.ensure_turn(request_id="req_concurrent")

    def _worker(worker_id: int) -> None:
        for index in range(inserts_per_thread):
            store.record(
                _make_event(
                    request_id="req_concurrent",
                    summary=f"w{worker_id}-i{index}",
                )
            )

    threads = [
        threading.Thread(target=_worker, args=(worker_id,))
        for worker_id in range(threads_count)
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    events = store.recent_events(request_id="req_concurrent", limit=total)
    assert len(events) == total
    sequences = [event.sequence for event in events]
    assert sequences == list(range(1, total + 1))
