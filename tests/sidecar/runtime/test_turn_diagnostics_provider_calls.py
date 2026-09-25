"""Per-provider-call ledger in ``TurnDiagnosticsStore``.

Split from ``test_turn_diagnostics.py`` (at the 1015-line raw ratchet)."""

from __future__ import annotations

import sidecar.runtime.turn_diagnostics as _td_module
from sidecar.runtime.turn_diagnostics import TurnDiagnosticsStore

# ---------------------------------------------------------------------------
# Per-provider-call ledger (owner turn 2026-09-20 20:21). One turn made three
# provider calls: the answer (aborted by the thinking guard), an internal
# reasoning summary, and the checkpoint continuation that died before its usage
# trailer. The dump showed the summary's usage and visible chars, the first
# call's first-chunk timing, and the third call's request-start offset, all as
# one call. Each provider start must reset the call-scoped fields; the first
# request's timing is kept apart; an internal call's text never counts as
# user-visible output; the fatal call's usage stays unknown.
# ---------------------------------------------------------------------------


def _frozen_clock(monkeypatch) -> list[float]:
    clock = [1000.0]
    monkeypatch.setattr(_td_module.time, "monotonic", lambda: clock[0])
    return clock


def _start_call(store: TurnDiagnosticsStore, request_id: str, **kwargs) -> None:
    store.record_provider_request(
        request_id=request_id,
        think_enabled=True,
        num_predict=16_384,
        temperature=1.0,
        message_count=10,
        tool_count=42,
        tool_capable=True,
        **kwargs,
    )


def _drive_three_call_turn(store: TurnDiagnosticsStore, clock: list[float]) -> None:
    """Replay the owner's turn: answer, internal summary, fatal continuation."""
    store.begin_turn(request_id="req_3", session_id="sess", mode="assist")

    # Call 1: the turn answer, aborted by the thinking guard (no usage trailer).
    clock[0] = 1001.0
    _start_call(store, "req_3")
    clock[0] = 1012.0
    store.record_first_chunk(request_id="req_3")
    clock[0] = 1240.0
    store.complete_provider_request(request_id="req_3")

    # Call 2: the internal reasoning summary.
    clock[0] = 1241.0
    _start_call(store, "req_3", purpose="reasoning_summary")
    clock[0] = 1243.0
    store.record_visible_output(request_id="req_3", text="s" * 431)
    store.record_provider_usage(
        request_id="req_3",
        prompt_eval_count=9628,
        eval_count=78,
        provider_label="openai-compatible",
    )
    store.record_stream_counters(
        request_id="req_3",
        counters={"visible_text_delta_count": 77, "malformed_tool_arguments_count": 0},
    )
    clock[0] = 1251.0
    store.complete_provider_request(request_id="req_3")

    # Call 3: the checkpoint continuation; raised before its usage trailer.
    clock[0] = 1252.0
    _start_call(store, "req_3", purpose="checkpoint_continuation")
    clock[0] = 1262.0
    store.record_first_chunk(request_id="req_3")
    store.record_stream_counters(
        request_id="req_3",
        counters={"visible_text_delta_count": 0, "malformed_tool_arguments_count": 1},
    )
    clock[0] = 1546.0
    store.complete_provider_request(request_id="req_3", outcome="failed")


def test_three_call_turn_keeps_first_request_timing_and_leaves_fatal_usage_unknown(
    monkeypatch,
) -> None:
    clock = _frozen_clock(monkeypatch)
    store = TurnDiagnosticsStore()
    _drive_three_call_turn(store, clock)

    snap = store.snapshot()
    assert snap is not None
    # Turn-level timing is the FIRST request's, and stays that way.
    assert snap["time_to_provider_request_start_ms"] == 1000
    assert snap["time_to_first_chunk_ms"] == 11000
    # The current call is tagged, and its fields are its own.
    assert snap["provider_call_count"] == 3
    assert snap["provider_call_ordinal"] == 3
    assert snap["provider_call_purpose"] == "checkpoint_continuation"
    assert snap["provider_call_start_ms"] == 252000
    assert snap["provider_call_outcome"] == "failed"
    assert snap["stream_counters"]["malformed_tool_arguments_count"] == 1
    # The fatal call never reported usage: unknown, not inherited from call 2.
    assert "provider_prompt_eval_count" not in snap
    assert "provider_eval_count" not in snap
    assert "provider_usage_source" not in snap
    # The summary's 431 chars were never shown to the user.
    assert "visible_output_chars" not in snap
    assert "time_to_first_visible_token_ms" not in snap

    calls = snap["provider_calls"]
    assert [call["ordinal"] for call in calls] == [1, 2, 3]
    assert [call["purpose"] for call in calls] == [
        "turn",
        "reasoning_summary",
        "checkpoint_continuation",
    ]
    assert [call["outcome"] for call in calls] == ["completed", "completed", "failed"]
    assert [call["start_ms"] for call in calls] == [1000, 241000, 252000]
    assert calls[0]["time_to_first_chunk_ms"] == 11000
    assert calls[0]["usage"] is None
    assert calls[1]["visible_output_chars"] == 431
    assert calls[1]["usage"] == {"prompt_eval_count": 9628, "eval_count": 78}
    assert calls[1]["stream_counters"]["visible_text_delta_count"] == 77
    assert calls[2]["time_to_first_chunk_ms"] == 10000
    assert calls[2]["usage"] is None
    assert calls[2]["duration_ms"] == 294000


def test_second_provider_call_resets_call_scoped_usage_and_keeps_the_ledger(
    monkeypatch,
) -> None:
    clock = _frozen_clock(monkeypatch)
    store = TurnDiagnosticsStore()
    store.begin_turn(request_id="req_2", session_id="sess", mode="chat")

    clock[0] = 1001.0
    _start_call(store, "req_2")
    store.record_visible_output(request_id="req_2", text="hello")
    store.record_provider_usage(request_id="req_2", prompt_eval_count=10, eval_count=5)
    store.record_stream_counters(request_id="req_2", counters={"visible_text_delta_count": 1})
    store.complete_provider_request(request_id="req_2")

    clock[0] = 1005.0
    _start_call(store, "req_2")

    snap = store.snapshot()
    assert snap is not None
    assert snap["provider_call_ordinal"] == 2
    assert snap["provider_call_purpose"] == "turn"
    assert snap["provider_call_outcome"] == "started"
    assert snap["provider_call_start_ms"] == 5000
    assert snap["time_to_provider_request_start_ms"] == 1000
    assert "provider_prompt_eval_count" not in snap
    assert "provider_eval_count" not in snap
    assert "stream_counters" not in snap
    # A turn-answer call's visible output is the user's; it accumulates.
    assert snap["visible_output_chars"] == 5
    assert snap["provider_calls"][0]["usage"] == {"prompt_eval_count": 10, "eval_count": 5}
    assert snap["provider_calls"][0]["visible_output_chars"] == 5
    assert snap["provider_calls"][1]["usage"] is None


def test_provider_call_ledger_is_bounded() -> None:
    store = TurnDiagnosticsStore()
    store.begin_turn(request_id="req_many", session_id="sess", mode="chat")
    for _ in range(_td_module._MAX_PROVIDER_CALLS_RETAINED + 5):
        _start_call(store, "req_many")

    snap = store.snapshot()
    assert snap is not None
    assert snap["provider_call_count"] == _td_module._MAX_PROVIDER_CALLS_RETAINED + 5
    assert len(snap["provider_calls"]) == _td_module._MAX_PROVIDER_CALLS_RETAINED
    assert snap["provider_calls"][-1]["ordinal"] == _td_module._MAX_PROVIDER_CALLS_RETAINED + 5


def test_snapshot_ledger_is_detached_from_later_calls(monkeypatch) -> None:
    # Land review 2026-09-20: the public payload was a shallow copy, so a
    # snapshot serialized from the dispatch thread shared the live ledger
    # list with the engine thread appending to it.
    clock = _frozen_clock(monkeypatch)
    store = TurnDiagnosticsStore()
    store.begin_turn(request_id="req_iso", session_id="sess", mode="chat")
    clock[0] = 1001.0
    _start_call(store, "req_iso")
    first = store.snapshot()
    assert first is not None

    clock[0] = 1002.0
    _start_call(store, "req_iso", purpose="reasoning_summary")
    store.complete_provider_request(request_id="req_iso", outcome="failed")

    assert first["provider_call_count"] == 1
    assert len(first["provider_calls"]) == 1
    assert first["provider_calls"][0]["outcome"] == "started"
    second = store.snapshot()
    assert second is not None
    assert len(second["provider_calls"]) == 2
