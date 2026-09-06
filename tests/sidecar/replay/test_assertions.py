"""Meta-tests for the replay corpus assertion helpers."""

from __future__ import annotations

from typing import Any

import pytest

from sidecar.ai.routing.loop_events import (
    PhaseStartedEvent,
    ThinkingEvent,
    TokenDeltaEvent,
)
from sidecar.ai.tools.models import (
    GenerationResult,
    StreamingEvent,
    ThinkingDelta,
    ToolCallRequest,
)
from sidecar.runtime.rpc import InvalidNotificationMethodError
from tests.sidecar.replay.assertions import (
    assert_engine_events_match,
    assert_generation_result_matches,
    assert_loop_events_match,
    assert_notifications_match,
    assert_turn_events_match,
)


def test_engine_events_match_passes_for_equal_sequences() -> None:
    actual: list[Any] = [
        StreamingEvent(kind="content", text="hi"),
        ThinkingDelta(text="reasoning", is_complete=True),
    ]
    expected: list[dict[str, Any]] = [
        {"_class": "StreamingEvent", "kind": "content", "text": "hi"},
        {"_class": "ThinkingDelta", "text": "reasoning", "is_complete": True},
    ]
    assert_engine_events_match(actual, expected, fixture_label="t1")


def test_engine_events_match_raises_on_mismatch() -> None:
    actual = [StreamingEvent(kind="content", text="hi")]
    expected = [{"_class": "StreamingEvent", "kind": "content", "text": "ho"}]
    with pytest.raises(AssertionError, match="engine event sequence mismatch"):
        assert_engine_events_match(actual, expected, fixture_label="t-mismatch")


def test_loop_events_match_compares_dataclasses_structurally() -> None:
    actual = [
        TokenDeltaEvent(delta="abc", token_index=0),
        ThinkingEvent(thinking_id="t1", delta="d", kind="reasoning", persist=True),
    ]
    expected = [
        {"_class": "TokenDeltaEvent", "delta": "abc", "token_index": 0},
        {
            "_class": "ThinkingEvent",
            "thinking_id": "t1",
            "delta": "d",
            "kind": "reasoning",
            "persist": True,
        },
    ]
    assert_loop_events_match(actual, expected, fixture_label="loop")


def test_loop_events_match_detects_field_drift() -> None:
    actual = [PhaseStartedEvent(phase_id="p", phase_kind="text", iteration=0)]
    expected = [
        {
            "_class": "PhaseStartedEvent",
            "phase_id": "p",
            "phase_kind": "reasoning",
            "iteration": 0,
        }
    ]
    with pytest.raises(AssertionError, match="loop event sequence mismatch"):
        assert_loop_events_match(actual, expected, fixture_label="phase")


def test_notifications_match_strips_volatile_fields() -> None:
    actual = [
        {
            "method": "chat.token",
            "params": {
                "request_id": "req-1",
                "trace_id": "trace-1",
                "session_id": "sess-1",
                "delta": "hi",
                "role": "assistant",
                "api_version": "2026-04-13",
            },
        }
    ]
    expected = [
        {"method": "chat.token", "params": {"delta": "hi", "role": "assistant"}}
    ]
    assert_notifications_match(actual, expected, fixture_label="notify")


def test_notifications_match_validates_method_against_protocol_allowlist() -> None:
    actual: list[dict[str, Any]] = []
    expected = [{"method": "chat.reasoning", "params": {"delta": "x"}}]
    with pytest.raises(InvalidNotificationMethodError):
        assert_notifications_match(actual, expected, fixture_label="bad-method")


def test_turn_events_match_strips_volatile_fields() -> None:
    actual = [
        {
            "kind": "tool_executing",
            "tool_call_id": "call_1",
            "payload": {"tool_name": "read_file"},
            "event_id": "id-x",
            "started_at": "2026-05-01T00:00:00Z",
            "completed_at": "2026-05-01T00:00:01Z",
            "turn_id": "turn-1",
            "event_seq": 7,
        }
    ]
    expected = [
        {
            "kind": "tool_executing",
            "tool_call_id": "call_1",
            "payload": {"tool_name": "read_file"},
        }
    ]
    assert_turn_events_match(actual, expected, fixture_label="turn-events")


def test_generation_result_matches_validates_scalar_and_tool_calls() -> None:
    actual = GenerationResult(
        content="ok",
        thinking_text="",
        finish_reason="tool_calls",
        tool_calls=(
            ToolCallRequest(tool_id="read_file", arguments={"path": "x"}, call_id="call_1"),
        ),
    )
    expected = {
        "content": "ok",
        "thinking_text": "",
        "finish_reason": "tool_calls",
        "tool_calls": [
            {"tool_id": "read_file", "arguments": {"path": "x"}, "call_id": "call_1"}
        ],
    }
    assert_generation_result_matches(actual, expected, fixture_label="genres")


def test_generation_result_match_detects_tool_call_drift() -> None:
    actual = GenerationResult(
        content="ok",
        finish_reason="tool_calls",
        tool_calls=(
            ToolCallRequest(tool_id="read_file", arguments={"path": "x"}, call_id="call_1"),
        ),
    )
    expected = {
        "content": "ok",
        "thinking_text": "",
        "finish_reason": "tool_calls",
        "tool_calls": [
            {"tool_id": "read_file", "arguments": {"path": "y"}, "call_id": "call_1"}
        ],
    }
    with pytest.raises(AssertionError, match="arguments"):
        assert_generation_result_matches(actual, expected, fixture_label="drift")
