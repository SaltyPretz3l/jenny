from __future__ import annotations

from pathlib import Path

import pytest

from sidecar.ai.error_codes import CMP_LOOP_REPEATED_OBSERVATIONS
from sidecar.ai.routing.loop_events import (
    ApprovalRequestedEvent,
    ApprovalResolvedEvent,
    ContextCompactedEvent,
    ContextUsageEvent,
    HeartbeatEvent,
    PhaseCompletedEvent,
    PhaseStartedEvent,
    StopEvent,
    StreamResetEvent,
    ThinkingEvent,
    TokenDeltaEvent,
    ToolCallCompletedEvent,
    ToolCallDeltaEvent,
    ToolExecutingEvent,
    ToolOutputChunkEvent,
    ToolResultEvent,
)
from sidecar.protocol import API_VERSION
from sidecar.runtime.chat_serialization import (
    _serialize_loop_event,
    _serialize_turn_event,
)
from sidecar.runtime.ipc_payloads import IpcPayloadExternalizer


def test_serialize_loop_event_emits_reasoning_phase_notifications() -> None:
    payload = _serialize_loop_event(
        PhaseStartedEvent(
            phase_id="phase_reasoning_req_1",
            phase_kind="reasoning",
            iteration=2,
            thinking_id="think_req_iter2",
        ),
        "req-1",
        trace_id="trace-1",
        session_id="session-1",
    )

    assert payload is not None
    assert payload["method"] == "chat.phase_started"
    assert payload["params"]["phase_id"] == "phase_reasoning_req_1"
    assert payload["params"]["phase_kind"] == "reasoning"
    assert payload["params"]["iteration"] == 2
    assert payload["params"]["thinking_id"] == "think_req_iter2"
    assert payload["params"]["request_id"] == "req-1"
    assert payload["params"]["trace_id"] == "trace-1"
    assert payload["params"]["session_id"] == "session-1"


def test_serialize_tool_output_chunk_emits_live_tail_notification() -> None:
    """W2-1: live output batches map to tool.output_chunk (ephemeral wire event)."""
    event = ToolOutputChunkEvent(
        call_id="call-stream-1",
        tool_name="run_command",
        sequence=3,
        lines=({"stream": "stdout", "text": "building..."}, {"stream": "stderr", "text": "warn"}),
        emitted_lines=41,
        dropped_lines=2,
        elapsed_ms=1500,
    )

    payload = _serialize_loop_event(
        event, "req-chunk", trace_id="trace-chunk", session_id="session-chunk"
    )

    assert payload is not None
    assert payload["method"] == "tool.output_chunk"
    params = payload["params"]
    assert params["tool_call_id"] == "call-stream-1"
    assert params["tool_name"] == "run_command"
    assert params["sequence"] == 3
    assert params["lines"] == [
        {"stream": "stdout", "text": "building..."},
        {"stream": "stderr", "text": "warn"},
    ]
    assert params["emitted_lines"] == 41
    assert params["dropped_lines"] == 2
    assert params["elapsed_ms"] == 1500
    assert params["request_id"] == "req-chunk"
    assert params["session_id"] == "session-chunk"


def test_serialize_turn_event_skips_tool_output_chunks() -> None:
    """Chunks are ephemeral: they must never become canonical turn events."""
    payload = _serialize_turn_event(
        ToolOutputChunkEvent(
            call_id="call-stream-2",
            tool_name="run_command",
            sequence=1,
            lines=({"stream": "stdout", "text": "x"},),
        ),
        "req-chunk-2",
        trace_id=None,
        session_id="session-chunk-2",
        seq=9,
    )

    assert payload is None


def _context_usage_event() -> ContextUsageEvent:
    return ContextUsageEvent(
        phase="iteration",
        iteration=3,
        context_used_tokens=42_000,
        context_used_source="estimate",
        context_tokens_estimate=42_000,
        last_request_input_tokens=900,
        context_window=131_072,
        compact_threshold_tokens=61_000,
        model="qwen",
        provider="ollama",
    )


def test_serialize_context_usage_emits_the_mid_turn_meter_notification() -> None:
    """The composer ring's mid-turn snapshot maps to context.usage, key-by-key."""
    payload = _serialize_loop_event(
        _context_usage_event(),
        "req-usage",
        trace_id="trace-usage",
        session_id="session-usage",
    )

    assert payload is not None
    assert payload["method"] == "context.usage"
    assert payload["params"] == {
        "api_version": API_VERSION,
        "request_id": "req-usage",
        "trace_id": "trace-usage",
        "session_id": "session-usage",
        "phase": "iteration",
        "iteration": 3,
        "context_used_tokens": 42_000,
        "context_used_source": "estimate",
        "context_tokens_estimate": 42_000,
        "last_request_input_tokens": 900,
        "context_window": 131_072,
        "compact_threshold_tokens": 61_000,
        "model": "qwen",
        "provider": "ollama",
    }


def test_serialize_turn_event_skips_context_usage_snapshots() -> None:
    """Meter snapshots are ephemeral: they must never become canonical turn events."""
    payload = _serialize_turn_event(
        _context_usage_event(),
        "req-usage-2",
        trace_id=None,
        session_id="session-usage-2",
        seq=4,
    )

    assert payload is None


def test_serialize_chat_token_includes_additive_sequence() -> None:
    payload = _serialize_loop_event(
        TokenDeltaEvent(delta="Hello", token_index=7),
        "req-token",
        trace_id="trace-token",
        session_id="session-token",
    )

    assert payload is not None
    assert payload["method"] == "chat.token"
    assert payload["params"]["delta"] == "Hello"
    assert payload["params"]["role"] == "assistant"
    assert payload["params"]["sequence"] == 7
    assert payload["params"]["request_id"] == "req-token"
    assert payload["params"]["trace_id"] == "trace-token"
    assert payload["params"]["session_id"] == "session-token"


def test_serialize_turn_event_emits_ephemeral_tool_input_delta() -> None:
    payload = _serialize_turn_event(
        ToolCallDeltaEvent(
            call_id="call-1",
            tool_name="read_file",
            arguments_delta='{"path":"C:/Users/example/private.txt"}',
            sequence=4,
        ),
        "req-tool-delta",
        trace_id="trace-tool-delta",
        session_id="session-tool-delta",
        seq=9,
    )

    assert payload is not None
    assert payload["method"] == "turn.event"
    event = payload["params"]
    assert event["v"] == 1
    assert event["turn_id"] == "req-tool-delta"
    assert event["stream_id"] == "req-tool-delta"
    assert event["session_id"] == "session-tool-delta"
    assert event["seq"] == 9
    assert event["type"] == "tool_input_delta"
    assert event["durability"] == "ephemeral"
    assert event["tool_call_id"] == "call-1"
    assert event["payload"]["tool_name"] == "read_file"
    # arguments_delta propagates verbatim except the Windows path is redacted by
    # the canonical turn-event sanitizer — assert the exact post-sanitize value.
    assert event["payload"]["arguments_delta"] == '{"path":"[redacted:path]/private.txt"}'
    assert "C:/Users/example/private.txt" not in str(event["payload"])


def test_serialize_turn_event_emits_durable_tool_call_requested() -> None:
    payload = _serialize_turn_event(
        ToolCallCompletedEvent(
            call_id="call-2",
            tool_name="read_file",
            arguments={"path": "README.md"},
            sequence=5,
        ),
        "req-tool-complete",
        trace_id=None,
        session_id="session-tool-complete",
        seq=10,
    )

    assert payload is not None
    assert payload["method"] == "turn.event"
    event = payload["params"]
    assert event["turn_id"] == "req-tool-complete"
    assert event["seq"] == 10
    assert event["type"] == "tool_call_requested"
    assert event["durability"] == "durable"
    assert event["tool_call_id"] == "call-2"
    assert event["payload"]["tool_name"] == "read_file"
    assert event["payload"]["tool_input"] == {"path": "README.md"}


def test_serialize_chat_token_preserves_zero_sequence() -> None:
    payload = _serialize_loop_event(
        TokenDeltaEvent(delta="First", token_index=0),
        "req-token-zero",
        trace_id="trace-token-zero",
        session_id="session-token-zero",
    )

    assert payload is not None
    assert payload["method"] == "chat.token"
    assert payload["params"]["sequence"] == 0


def test_serialize_loop_event_emits_tool_scoped_completion_metadata() -> None:
    payload = _serialize_loop_event(
        PhaseCompletedEvent(
            phase_id="phase_tool_result_req_1",
            phase_kind="tool_result",
            iteration=1,
            tool_call_id="call-1",
            tool_name="read_file",
        ),
        "req-1",
        trace_id=None,
        session_id="session-1",
    )

    assert payload is not None
    assert payload["method"] == "chat.phase_completed"
    assert payload["params"]["phase_id"] == "phase_tool_result_req_1"
    assert payload["params"]["phase_kind"] == "tool_result"
    assert payload["params"]["iteration"] == 1
    assert payload["params"]["tool_call_id"] == "call-1"
    assert payload["params"]["tool_name"] == "read_file"
    assert payload["params"]["session_id"] == "session-1"


def test_serialize_loop_event_preserves_optional_phase_summaries() -> None:
    started = _serialize_loop_event(
        PhaseStartedEvent(
            phase_id="phase_reasoning_req_2",
            phase_kind="reasoning",
            iteration=1,
            thinking_id="think_req_iter1",
            summary="Inspecting the workspace map",
        ),
        "req-2",
        trace_id="trace-2",
        session_id="session-2",
    )
    completed = _serialize_loop_event(
        PhaseCompletedEvent(
            phase_id="phase_reasoning_req_2",
            phase_kind="reasoning",
            iteration=1,
            thinking_id="think_req_iter1",
            summary="Workspace map reviewed",
        ),
        "req-2",
        trace_id="trace-2",
        session_id="session-2",
    )

    assert started is not None
    assert completed is not None
    assert started["params"]["summary"] == "Inspecting the workspace map"
    assert completed["params"]["summary"] == "Workspace map reviewed"


def test_serialize_loop_event_bounds_optional_phase_summaries() -> None:
    payload = _serialize_loop_event(
        PhaseStartedEvent(
            phase_id="phase_reasoning_req_long",
            phase_kind="reasoning",
            iteration=1,
            summary="  " + ("phase summary " * 40) + "  ",
        ),
        "req-long",
        trace_id="trace-long",
        session_id="session-long",
    )

    assert payload is not None
    summary = payload["params"]["summary"]
    assert len(summary) <= 240
    assert summary.endswith("...")
    assert "  " not in summary


def test_serialize_stop_event_includes_optional_subcode_when_set() -> None:
    """The semantic stuck-loop detector tags its ``StopEvent`` with
    ``subcode="guardrail_aborted"`` so the backend's terminal-status
    mapping can append the early-stop footer without re-classifying by
    code alone.
    """
    payload = _serialize_loop_event(
        StopEvent(
            reason="Same observation kind=... repeated 4 times consecutively.",
            code=CMP_LOOP_REPEATED_OBSERVATIONS,
            user_hint="Stop calling tools and summarize what you have.",
            subcode="guardrail_aborted",
        ),
        "req-stop",
        trace_id="trace-stop",
        session_id="sess-stop",
    )

    assert payload is not None
    assert payload["method"] == "chat.thinking"
    assert payload["params"]["delta"].startswith("Same observation")
    assert payload["params"]["kind"] == "status"
    assert payload["params"]["code"] == CMP_LOOP_REPEATED_OBSERVATIONS
    assert payload["params"]["subcode"] == "guardrail_aborted"
    assert payload["params"]["user_hint"] == "Stop calling tools and summarize what you have."


def test_serialize_stop_event_omits_subcode_when_none() -> None:
    """A StopEvent without a subcode (e.g. cycle detection) must not
    introduce a ``subcode`` key on the wire — keeps payloads lean and
    avoids ``subcode: null`` ambiguity for backend consumers.
    """
    payload = _serialize_loop_event(
        StopEvent(
            reason="Detected repeated tool calls.",
            code="CMP_LOOP_CYCLE_DETECTED",
        ),
        "req-stop",
        trace_id=None,
        session_id="sess-stop",
    )

    assert payload is not None
    assert "subcode" not in payload["params"]
    assert payload["params"]["code"] == "CMP_LOOP_CYCLE_DETECTED"


# ---------------------------------------------------------------------------
# ThinkingEvent serialization (line 111)
# ---------------------------------------------------------------------------


def test_serialize_loop_event_thinking_event_emits_chat_thinking() -> None:
    """ThinkingEvent is forwarded verbatim as a chat.thinking notification."""
    payload = _serialize_loop_event(
        ThinkingEvent(
            thinking_id="think-abc",
            delta="Pondering the query",
            kind="reasoning",
            persist=True,
        ),
        "req-think",
        trace_id="trace-think",
        session_id="sess-think",
    )

    assert payload is not None
    assert payload["method"] == "chat.thinking"
    params = payload["params"]
    assert params["delta"] == "Pondering the query"
    assert params["thinking_id"] == "think-abc"
    assert params["kind"] == "reasoning"
    assert params["persist"] is True
    assert params["request_id"] == "req-think"


def test_serialize_loop_event_thinking_event_includes_positive_budget() -> None:
    """thinking_budget_chars rides the notification only when positive."""
    included = _serialize_loop_event(
        ThinkingEvent(
            thinking_id="think-budget",
            delta="Reasoning",
            kind="reasoning",
            persist=True,
            thinking_budget_chars=123_456,
        ),
        "req-budget",
        trace_id=None,
        session_id=None,
    )
    assert included is not None
    assert included["params"]["thinking_budget_chars"] == 123_456

    for value in (None, 0, -5):
        omitted = _serialize_loop_event(
            ThinkingEvent(
                thinking_id="think-budget",
                delta="Reasoning",
                kind="reasoning",
                persist=True,
                thinking_budget_chars=value,
            ),
            "req-budget",
            trace_id=None,
            session_id=None,
        )
        assert omitted is not None
        assert "thinking_budget_chars" not in omitted["params"]


def test_serialize_loop_event_thinking_event_persist_false() -> None:
    """ThinkingEvent with persist=False serializes persist accurately."""
    payload = _serialize_loop_event(
        ThinkingEvent(
            thinking_id="think-status",
            delta="Scanning workspace...",
            kind="status",
            persist=False,
        ),
        "req-think-2",
        trace_id=None,
        session_id=None,
    )

    assert payload is not None
    assert payload["method"] == "chat.thinking"
    assert payload["params"]["persist"] is False
    assert payload["params"]["kind"] == "status"
    assert payload["params"]["delta"] == "Scanning workspace..."


# ---------------------------------------------------------------------------
# StreamResetEvent serialization (line 136)
# ---------------------------------------------------------------------------


def test_serialize_loop_event_stream_reset_emits_correct_method() -> None:
    """StreamResetEvent emits a chat.stream_reset notification with ctx fields only."""
    payload = _serialize_loop_event(
        StreamResetEvent(),
        "req-reset",
        trace_id="trace-reset",
        session_id="sess-reset",
    )

    assert payload is not None
    assert payload["method"] == "chat.stream_reset"
    params = payload["params"]
    assert params["request_id"] == "req-reset"
    assert params["trace_id"] == "trace-reset"
    assert params["session_id"] == "sess-reset"
    # reason defaults to "" (treated as discard downstream)
    assert params["reason"] == ""
    # No extra keys beyond context + reason
    assert "delta" not in params


@pytest.mark.parametrize("reason", ["tool_continuation", "reflexive_retry"])
def test_serialize_loop_event_stream_reset_forwards_reason(reason: str) -> None:
    """The reset reason rides the chat.stream_reset payload so Electron can branch."""
    payload = _serialize_loop_event(
        StreamResetEvent(reason=reason),
        "req-reset",
        trace_id="trace-reset",
        session_id="sess-reset",
    )

    assert payload is not None
    assert payload["params"]["reason"] == reason


# ---------------------------------------------------------------------------
# ToolExecutingEvent and ToolResultEvent optional fields (lines 144–186)
# ---------------------------------------------------------------------------


def test_serialize_loop_event_tool_executing_no_externalizer() -> None:
    """ToolExecutingEvent without an externalizer serializes arguments inline."""
    payload = _serialize_loop_event(
        ToolExecutingEvent(
            call_id="call-exec-1",
            tool_name="write_file",
            arguments={"path": "/tmp/out.txt", "content": "hello"},
        ),
        "req-exec",
        trace_id="trace-exec",
        session_id="sess-exec",
    )

    assert payload is not None
    assert payload["method"] == "tool.executing"
    params = payload["params"]
    assert params["tool_name"] == "write_file"
    assert params["tool_call_id"] == "call-exec-1"
    assert params["tool_input"] == {"path": "/tmp/out.txt", "content": "hello"}
    assert params["request_id"] == "req-exec"


def test_serialize_loop_event_tool_executing_with_externalizer_calls_harden() -> None:
    """When a payload_externalizer is present, harden_tool_notification is called."""
    calls: list[dict] = []

    class _FakeExternalizer(IpcPayloadExternalizer):
        def harden_tool_notification(self, *, method, params, request_id, trace_id, session_id):
            calls.append(
                {
                    "method": method,
                    "request_id": request_id,
                    "trace_id": trace_id,
                    "session_id": session_id,
                }
            )
            # Return params with a sentinel so we can confirm the return was used
            return {**params, "_hardened": True}

    externalizer = _FakeExternalizer.__new__(_FakeExternalizer)
    object.__setattr__(externalizer, "root", Path("/tmp"))
    object.__setattr__(externalizer, "max_inline_payload_bytes", 65536)

    payload = _serialize_loop_event(
        ToolExecutingEvent(
            call_id="call-hard-1",
            tool_name="read_file",
            arguments={"path": "/tmp/a.txt"},
        ),
        "req-hard",
        trace_id="trace-hard",
        session_id="sess-hard",
        payload_externalizer=externalizer,
    )

    assert payload is not None
    assert payload["method"] == "tool.executing"
    # externalizer was invoked
    assert len(calls) == 1
    assert calls[0]["method"] == "tool.executing"
    assert calls[0]["request_id"] == "req-hard"
    assert calls[0]["trace_id"] == "trace-hard"
    assert calls[0]["session_id"] == "sess-hard"
    # sentinel present confirms hardened payload was used
    assert payload["params"].get("_hardened") is True


def test_serialize_loop_event_tool_result_with_all_optional_fields() -> None:
    """ToolResultEvent optional fields (ui_payload, generated_artifacts, error_code,
    metadata, duration_ms) are all included when populated (lines 167/169/173/177)."""
    payload = _serialize_loop_event(
        ToolResultEvent(
            call_id="call-res-1",
            tool_name="search",
            success=True,
            content="Found 3 results",
            tool_input={"query": "foo"},
            ui_payload={"type": "search_results", "items": []},
            generated_artifacts=({"kind": "file", "path": "/tmp/report.txt"},),
            error_code=None,
            metadata={"latency_ms": 120},
            duration_ms=200.5,
        ),
        "req-res",
        trace_id="trace-res",
        session_id="sess-res",
    )

    assert payload is not None
    assert payload["method"] == "tool.result"
    params = payload["params"]
    assert params["tool_name"] == "search"
    assert params["success"] is True
    assert params["output"] == "Found 3 results"
    assert params["ui_payload"] == {"type": "search_results", "items": []}
    assert params["generated_artifacts"] == [{"kind": "file", "path": "/tmp/report.txt"}]
    assert params["metadata"] == {"latency_ms": 120}
    assert params["duration_ms"] == 200.5
    assert "error_code" not in params


def test_serialize_loop_event_tool_result_with_error_code() -> None:
    """ToolResultEvent with error_code includes that key (line 173)."""
    payload = _serialize_loop_event(
        ToolResultEvent(
            call_id="call-res-err",
            tool_name="run_cmd",
            success=False,
            content="Command failed",
            tool_input={"cmd": "ls /missing"},
            error_code="ENOENT",
        ),
        "req-res-err",
        trace_id=None,
        session_id="sess-res-err",
    )

    assert payload is not None
    assert payload["params"]["success"] is False
    assert payload["params"]["error_code"] == "ENOENT"
    # Optional fields absent when not set
    assert "ui_payload" not in payload["params"]
    assert "generated_artifacts" not in payload["params"]
    assert "metadata" not in payload["params"]
    assert "duration_ms" not in payload["params"]


def test_serialize_loop_event_tool_result_with_externalizer_calls_harden() -> None:
    """ToolResultEvent with externalizer invokes harden_tool_notification."""
    calls: list[dict] = []

    class _FakeExternalizer2(IpcPayloadExternalizer):
        def harden_tool_notification(self, *, method, params, request_id, trace_id, session_id):
            calls.append({"method": method, "request_id": request_id})
            return {**params, "_hardened": True}

    externalizer = _FakeExternalizer2.__new__(_FakeExternalizer2)
    object.__setattr__(externalizer, "root", Path("/tmp"))
    object.__setattr__(externalizer, "max_inline_payload_bytes", 65536)

    payload = _serialize_loop_event(
        ToolResultEvent(
            call_id="call-res-hard",
            tool_name="search",
            success=True,
            content="ok",
            tool_input={},
        ),
        "req-hard-res",
        trace_id=None,
        session_id="sess-hard-res",
        payload_externalizer=externalizer,
    )

    assert payload is not None
    assert payload["method"] == "tool.result"
    assert len(calls) == 1
    assert calls[0]["method"] == "tool.result"
    assert calls[0]["request_id"] == "req-hard-res"
    assert payload["params"].get("_hardened") is True


# ---------------------------------------------------------------------------
# HeartbeatEvent serialization (line 188)
# ---------------------------------------------------------------------------


def test_serialize_loop_event_heartbeat_includes_elapsed_seconds() -> None:
    """HeartbeatEvent emits a chat.thinking notification with elapsed time."""
    payload = _serialize_loop_event(
        HeartbeatEvent(elapsed_seconds=42.7),
        "req-hb",
        trace_id=None,
        session_id="sess-hb",
    )

    assert payload is not None
    assert payload["method"] == "chat.thinking"
    params = payload["params"]
    # elapsed rendered as integer seconds in the message
    assert "43s" in params["delta"]
    assert params["kind"] == "status"
    assert params["persist"] is False
    assert params["thinking_id"] == "think_req-hb_heartbeat"


# ---------------------------------------------------------------------------
# ContextCompactedEvent serialization (line 216)
# ---------------------------------------------------------------------------


def test_serialize_loop_event_context_compacted_emits_correct_fields() -> None:
    """ContextCompactedEvent emits a context.compacted notification."""
    payload = _serialize_loop_event(
        ContextCompactedEvent(
            strategy="full",
            tokens_before=8000,
            tokens_after=2500,
            phase="preflight",
            summary_status="created",
            input_complete=True,
            summary_message={"role": "system", "content": "bounded summary"},
        ),
        "req-compact",
        trace_id="trace-compact",
        session_id="sess-compact",
    )

    assert payload is not None
    assert payload["method"] == "context.compacted"
    params = payload["params"]
    assert params["strategy"] == "full"
    assert params["tokens_before"] == 8000
    assert params["tokens_after"] == 2500
    assert params["phase"] == "preflight"
    assert params["summary_status"] == "created"
    assert params["input_complete"] is True
    assert params["summary_message"] == {
        "role": "system",
        "content": "bounded summary",
    }
    assert params["request_id"] == "req-compact"


def test_serialize_loop_event_context_compacted_emits_covered_through_tool_call_id() -> None:
    covered_through = "call_" + ("7" * 200)
    payload = _serialize_loop_event(
        ContextCompactedEvent(
            strategy="full",
            tokens_before=8000,
            tokens_after=2500,
            covered_through_tool_call_id=covered_through,
        ),
        "req-compact-covered-through",
        trace_id=None,
        session_id=None,
    )

    assert payload is not None
    assert payload["params"]["covered_through_tool_call_id"] == covered_through[:128]


def test_serialize_loop_event_context_compacted_omits_covered_through_when_absent() -> None:
    payload = _serialize_loop_event(
        ContextCompactedEvent(
            strategy="full",
            tokens_before=8000,
            tokens_after=2500,
        ),
        "req-compact-no-covered-through",
        trace_id=None,
        session_id=None,
    )

    assert payload is not None
    assert "covered_through_tool_call_id" not in payload["params"]


def test_serialize_loop_event_context_compacted_preserves_not_applicable() -> None:
    payload = _serialize_loop_event(
        ContextCompactedEvent(
            strategy="micro",
            tokens_before=4525,
            tokens_after=4525,
            phase="tool_loop",
            summary_status="not_applicable",
            reason_code="summary_prefix_unavailable",
            input_complete=False,
        ),
        "req-compact-not-applicable",
        trace_id=None,
        session_id="sess-compact",
    )

    assert payload is not None
    params = payload["params"]
    assert params["summary_status"] == "not_applicable"
    assert params["reason_code"] == "summary_prefix_unavailable"
    assert params["input_complete"] is False


# ---------------------------------------------------------------------------
# Unknown event type returns None (sentinel/fallthrough)
# ---------------------------------------------------------------------------


def test_serialize_loop_event_returns_none_for_unknown_event() -> None:
    """An unrecognised event type returns None (caller silently skips it)."""

    class _UnknownEvent:
        pass

    result = _serialize_loop_event(
        _UnknownEvent(),
        "req-unknown",
        trace_id=None,
        session_id=None,
    )
    assert result is None


# ---------------------------------------------------------------------------
# _serialize_turn_event — ThinkingEvent paths (lines 285–313)
# ---------------------------------------------------------------------------


def test_serialize_turn_event_thinking_reasoning_kind_emits_reasoning_delta() -> None:
    """ThinkingEvent with kind='reasoning' produces a reasoning_delta turn event."""
    payload = _serialize_turn_event(
        ThinkingEvent(
            thinking_id="think-turn-1",
            delta="Deep reasoning text",
            kind="reasoning",
            persist=False,
        ),
        "req-turn-think",
        trace_id=None,
        session_id="sess-turn-think",
        seq=3,
    )

    assert payload is not None
    assert payload["method"] == "turn.event"
    event = payload["params"]
    assert event["type"] == "reasoning_delta"
    assert event["payload"]["delta"] == "Deep reasoning text"
    assert event["payload"]["thinking_id"] == "think-turn-1"
    assert event["payload"]["kind"] == "reasoning"
    assert event["seq"] == 3


def test_serialize_turn_event_thinking_persist_true_emits_reasoning_delta() -> None:
    """ThinkingEvent with persist=True also produces reasoning_delta regardless of kind."""
    payload = _serialize_turn_event(
        ThinkingEvent(
            thinking_id="think-persist",
            delta="Persisted status text",
            kind="status",
            persist=True,
        ),
        "req-think-persist",
        trace_id=None,
        session_id=None,
        seq=1,
    )

    assert payload is not None
    event = payload["params"]
    assert event["type"] == "reasoning_delta"
    assert event["payload"]["persist"] is True
    assert event["payload"]["delta"] == "Persisted status text"


def test_serialize_turn_event_thinking_status_kind_persist_false_emits_status_part() -> None:
    """ThinkingEvent with kind='status' and persist=False produces status_part (line 313)."""
    payload = _serialize_turn_event(
        ThinkingEvent(
            thinking_id="think-eph",
            delta="Ephemeral status",
            kind="status",
            persist=False,
        ),
        "req-think-eph",
        trace_id=None,
        session_id=None,
        seq=2,
    )

    assert payload is not None
    event = payload["params"]
    assert event["type"] == "status_part"
    assert event["payload"]["status_text"] == "Ephemeral status"
    assert event["payload"]["thinking_id"] == "think-eph"
    assert event["payload"]["kind"] == "status"
    assert event["payload"]["persist"] is False


# ---------------------------------------------------------------------------
# _serialize_turn_event — PhaseStartedEvent/PhaseCompletedEvent optional fields
# (lines 286–287, 346–354)
# ---------------------------------------------------------------------------


def test_serialize_turn_event_phase_started_with_all_optional_fields() -> None:
    """phase_started turn event includes thinking_id, tool_call_id, tool_name, summary."""
    payload = _serialize_turn_event(
        PhaseStartedEvent(
            phase_id="phase-full",
            phase_kind="tool_call",
            iteration=1,
            thinking_id="think-phase",
            tool_call_id="call-phase",
            tool_name="write_file",
            summary="Writing output to disk",
        ),
        "req-phase-full",
        trace_id=None,
        session_id="sess-phase",
        seq=4,
    )

    assert payload is not None
    event = payload["params"]
    assert event["type"] == "status_part"
    p = event["payload"]
    assert p["status_text"] == "phase_started"
    assert p["phase_id"] == "phase-full"
    assert p["thinking_id"] == "think-phase"
    assert p["tool_call_id"] == "call-phase"
    assert p["tool_name"] == "write_file"
    assert p["summary"] == "Writing output to disk"
    # tool_call_id propagated to the envelope
    assert event["tool_call_id"] == "call-phase"


def test_serialize_turn_event_phase_completed_optional_fields_absent_when_none() -> None:
    """Optional phase fields are omitted from the payload when not set."""
    payload = _serialize_turn_event(
        PhaseCompletedEvent(
            phase_id="phase-bare",
            phase_kind="reasoning",
            iteration=2,
        ),
        "req-phase-bare",
        trace_id=None,
        session_id=None,
        seq=5,
    )

    assert payload is not None
    event = payload["params"]
    p = event["payload"]
    assert p["status_text"] == "phase_completed"
    assert "thinking_id" not in p
    assert "tool_call_id" not in p
    assert "tool_name" not in p
    assert "summary" not in p


# ---------------------------------------------------------------------------
# _serialize_turn_event — StreamResetEvent, HeartbeatEvent in turn path
# (lines 358–370)
# ---------------------------------------------------------------------------


def test_serialize_turn_event_stream_reset_emits_status_part() -> None:
    """StreamResetEvent turn event is a status_part with stream_reset event."""
    payload = _serialize_turn_event(
        StreamResetEvent(),
        "req-turn-reset",
        trace_id=None,
        session_id=None,
        seq=7,
    )

    assert payload is not None
    event = payload["params"]
    assert event["type"] == "status_part"
    assert event["payload"]["status_text"] == "stream_reset"
    assert event["payload"]["event"] == "stream_reset"
    assert event["payload"]["reason"] == ""


def test_serialize_turn_event_heartbeat_emits_status_part_with_elapsed() -> None:
    """HeartbeatEvent turn event is a status_part with elapsed_seconds."""
    payload = _serialize_turn_event(
        HeartbeatEvent(elapsed_seconds=15.3),
        "req-turn-hb",
        trace_id=None,
        session_id=None,
        seq=8,
    )

    assert payload is not None
    event = payload["params"]
    assert event["type"] == "status_part"
    p = event["payload"]
    assert "15s" in p["status_text"]
    assert p["elapsed_seconds"] == 15.3


# ---------------------------------------------------------------------------
# _serialize_turn_event — StopEvent (lines 371–396)
# ---------------------------------------------------------------------------


def test_serialize_turn_event_stop_with_user_hint_and_subcode() -> None:
    """StopEvent turn event includes user_hint and subcode when set (lines 393–396)."""
    payload = _serialize_turn_event(
        StopEvent(
            reason="Guardrail triggered.",
            code="CMP_LOOP_GUARDRAIL",
            user_hint="Please summarize.",
            subcode="guardrail_aborted",
        ),
        "req-turn-stop",
        trace_id=None,
        session_id=None,
        seq=9,
    )

    assert payload is not None
    event = payload["params"]
    assert event["type"] == "turn_cancelled"
    p = event["payload"]
    assert p["message"] == "Guardrail triggered."
    assert p["status_text"] == "Guardrail triggered."
    assert p["code"] == "CMP_LOOP_GUARDRAIL"
    assert p["user_hint"] == "Please summarize."
    assert p["subcode"] == "guardrail_aborted"


def test_serialize_turn_event_stop_without_hint_or_subcode() -> None:
    """StopEvent without optional fields omits them from the payload."""
    payload = _serialize_turn_event(
        StopEvent(
            reason="Max iterations reached.",
            code="CMP_LOOP_MAX_ITER",
        ),
        "req-turn-stop-bare",
        trace_id=None,
        session_id=None,
        seq=10,
    )

    assert payload is not None
    event = payload["params"]
    assert event["type"] == "turn_cancelled"
    p = event["payload"]
    assert p["code"] == "CMP_LOOP_MAX_ITER"
    assert "user_hint" not in p
    assert "subcode" not in p


# ---------------------------------------------------------------------------
# _serialize_turn_event — ContextCompactedEvent (lines 373–382)
# ---------------------------------------------------------------------------


def test_serialize_turn_event_context_compacted_emits_status_part() -> None:
    """ContextCompactedEvent turn event is a status_part with compaction stats.

    Note: the canonical turn-event contract redacts fields whose names match
    the token/secret pattern (tokens_before, tokens_after).  We verify the
    envelope type and strategy, which are unaffected.
    """
    payload = _serialize_turn_event(
        ContextCompactedEvent(
            strategy="micro",
            tokens_before=5000,
            tokens_after=1500,
            summary_message={"role": "system", "content": "must not persist"},
        ),
        "req-turn-compact",
        trace_id=None,
        session_id=None,
        seq=11,
    )

    assert payload is not None
    event = payload["params"]
    assert event["type"] == "status_part"
    p = event["payload"]
    assert p["status_text"] == "context_compacted"
    assert p["strategy"] == "micro"
    # The canonical turn-event contract matches "token" in the field NAME and
    # redacts the VALUE (key survives). Assert the concrete redacted sentinel so
    # this test fails if the sanitizer ever stops redacting these counters or
    # the keys stop propagating through the pipeline.
    assert p["tokens_before"] == "[redacted:secret]"
    assert p["tokens_after"] == "[redacted:secret]"
    assert "summary_message" not in p


def test_serialize_turn_event_context_compacted_still_omits_covered_through() -> None:
    payload = _serialize_turn_event(
        ContextCompactedEvent(
            strategy="full",
            tokens_before=5000,
            tokens_after=1500,
            covered_through_tool_call_id="call_7",
        ),
        "req-turn-compact-covered-through",
        trace_id=None,
        session_id=None,
        seq=12,
    )

    assert payload is not None
    assert "covered_through_tool_call_id" not in payload["params"]["payload"]


# ---------------------------------------------------------------------------
# _serialize_turn_event — ToolExecutingEvent (line 455)
# ---------------------------------------------------------------------------


def test_serialize_turn_event_tool_executing_emits_tool_execution_started() -> None:
    """ToolExecutingEvent turn event is tool_execution_started (line 455)."""
    payload = _serialize_turn_event(
        ToolExecutingEvent(
            call_id="call-exec-turn",
            tool_name="run_shell",
            arguments={"cmd": "echo hi"},
        ),
        "req-turn-exec",
        trace_id=None,
        session_id=None,
        seq=12,
    )

    assert payload is not None
    event = payload["params"]
    assert event["type"] == "tool_execution_started"
    assert event["tool_call_id"] == "call-exec-turn"
    p = event["payload"]
    assert p["tool_name"] == "run_shell"
    assert p["tool_input"] == {"cmd": "echo hi"}


# ---------------------------------------------------------------------------
# _serialize_turn_event — ToolResultEvent with all optional fields (lines 464–486)
# ---------------------------------------------------------------------------


def test_serialize_turn_event_tool_result_success_with_all_optional_fields() -> None:
    """ToolResultEvent success path includes all optional fields in the turn event."""
    payload = _serialize_turn_event(
        ToolResultEvent(
            call_id="call-res-turn",
            tool_name="search",
            success=True,
            content="3 results",
            tool_input={"q": "foo"},
            ui_payload={"type": "search", "hits": 3},
            generated_artifacts=({"kind": "report", "path": "/tmp/r.txt"},),
            error_code=None,
            metadata={"latency": 50},
            duration_ms=75.0,
        ),
        "req-turn-res",
        trace_id=None,
        session_id=None,
        seq=13,
    )

    assert payload is not None
    event = payload["params"]
    assert event["type"] == "tool_execution_completed"
    assert event["tool_call_id"] == "call-res-turn"
    p = event["payload"]
    assert p["tool_name"] == "search"
    assert p["success"] is True
    assert p["tool_output_summary"] == "3 results"
    assert p["ui_payload"] == {"type": "search", "hits": 3}
    # Structure rides through intact; the path value is redacted by the
    # canonical contract's path rules (turn_event_contract._sanitize_string),
    # which keep the final segment so tool rows stay readable.
    assert p["generated_artifacts"] == [{"kind": "report", "path": "[redacted:path]/r.txt"}]
    assert p["metadata"] == {"latency": 50}
    assert p["duration_ms"] == 75.0
    assert "error_code" not in p


def test_serialize_turn_event_tool_result_failure_with_error_code() -> None:
    """Failed ToolResultEvent uses tool_execution_failed type and includes error_code."""
    payload = _serialize_turn_event(
        ToolResultEvent(
            call_id="call-res-fail",
            tool_name="run_cmd",
            success=False,
            content="Permission denied",
            tool_input={"cmd": "rm -rf /"},
            error_code="EPERM",
        ),
        "req-turn-fail",
        trace_id=None,
        session_id=None,
        seq=14,
    )

    assert payload is not None
    event = payload["params"]
    assert event["type"] == "tool_execution_failed"
    p = event["payload"]
    assert p["success"] is False
    assert p["error_code"] == "EPERM"
    assert "ui_payload" not in p
    assert "generated_artifacts" not in p
    assert "metadata" not in p
    assert "duration_ms" not in p


# ---------------------------------------------------------------------------
# _serialize_turn_event — unknown event returns None
# ---------------------------------------------------------------------------


def test_serialize_turn_event_returns_none_for_unknown_event() -> None:
    """An unrecognised event type produces None from _serialize_turn_event."""

    class _Alien:
        pass

    result = _serialize_turn_event(
        _Alien(),
        "req-alien",
        trace_id=None,
        session_id=None,
        seq=0,
    )
    assert result is None


# ---------------------------------------------------------------------------
# ApprovalRequestedEvent / ApprovalResolvedEvent in turn events (lines 400–428)
# ---------------------------------------------------------------------------


def test_serialize_turn_event_approval_requested_with_optional_fields() -> None:
    """ApprovalRequestedEvent turn event includes summary and approval_plan_hash."""
    payload = _serialize_turn_event(
        ApprovalRequestedEvent(
            call_id="call-approval-1",
            tool_name="delete_file",
            summary="Delete /etc/hosts",
            approval_plan_hash="abc123",
        ),
        "req-approval",
        trace_id=None,
        session_id=None,
        seq=15,
    )

    assert payload is not None
    event = payload["params"]
    assert event["type"] == "tool_approval_requested"
    assert event["tool_call_id"] == "call-approval-1"
    p = event["payload"]
    assert p["approval_state"] == "pending"
    assert p["tool_name"] == "delete_file"
    # Summary rides through with its path argument redacted — see the note in
    # test_serialize_turn_event_tool_result_success_with_all_optional_fields.
    assert p["summary"] == "Delete [redacted:path]/hosts"
    assert p["approval_plan_hash"] == "abc123"


def test_serialize_turn_event_approval_resolved_approved() -> None:
    """ApprovalResolvedEvent with approved=True serializes correctly."""
    payload = _serialize_turn_event(
        ApprovalResolvedEvent(
            call_id="call-approval-2",
            approved=True,
            status="approved",
            tool_name="delete_file",
            approval_plan_hash="abc123",
        ),
        "req-approval-resolved",
        trace_id=None,
        session_id=None,
        seq=16,
    )

    assert payload is not None
    event = payload["params"]
    assert event["type"] == "tool_approval_resolved"
    assert event["tool_call_id"] == "call-approval-2"
    p = event["payload"]
    assert p["approval_state"] == "approved"
    assert p["approved"] is True
    assert p["tool_name"] == "delete_file"
    assert p["approval_plan_hash"] == "abc123"
