"""FG-008: the rebuilt compaction window is described by shape only, never content."""

from __future__ import annotations

import json
from types import MethodType, SimpleNamespace
from typing import Any
from unittest.mock import MagicMock

import pytest

from sidecar.ai.context.compaction import COMPACTED_SUMMARY_HEADING
from sidecar.ai.context.compaction_diagnostics import (
    WINDOW_SHAPE_MAX_ROWS,
    compacted_event_extras,
    compaction_window_shape,
)
from sidecar.ai.context.compaction_window import MID_TURN_TASK_STUB, mid_turn_nudge_row
from sidecar.ai.context.token_budget import TokenBudget
from sidecar.ai.routing import tool_loop_compaction
from sidecar.ai.routing.loop_events import ContextCompactedEvent
from sidecar.ai.routing.router import ToolExecutionOutcome
from sidecar.ai.routing.tool_loop_compaction import compact_tool_loop_context
from sidecar.ai.routing.tool_loop_run import _ToolLoopRun
from sidecar.ai.routing.write_progress import READS_WITHOUT_WRITE_LIMIT, WriteProgress

_SUMMARY = f"{COMPACTED_SUMMARY_HEADING}\nDerived conversation data.\n\nSECRET-SUMMARY-BODY"
_TASK = "SECRET-TASK reconcile the March statement"


def _mid_turn_window() -> list[dict[str, Any]]:
    return [
        {"role": "system", "content": "SECRET-PRIMARY system prompt"},
        {"role": "system", "content": _SUMMARY},
        {"role": "user", "content": _TASK},
        {
            "role": "assistant",
            "content": "",
            "tool_calls": [
                {
                    "id": "call_1",
                    "function": {"name": "read_file", "arguments": '{"path": "SECRET.csv"}'},
                }
            ],
        },
        {
            "role": "tool",
            "tool_call_id": "call_1",
            "name": "read_file",
            "content": "SECRET-TOOL-OUTPUT",
        },
        {"role": "assistant", "content": "SECRET-ASSISTANT text"},
        mid_turn_nudge_row(plan_approved_in_turn=False),
    ]


def test_shape_lists_summary_pin_and_tool_rows_with_char_counts() -> None:
    rows = _mid_turn_window()
    shape = compaction_window_shape(rows)

    assert [row["kind"] for row in shape] == [
        "system",
        "summary",
        "task_pin",
        "tool_use",
        "tool_result",
        "text",
        "nudge",
    ]
    assert [row["role"] for row in shape] == [
        "system", "system", "user", "assistant", "tool", "assistant", "system",
    ]
    assert shape[1]["chars"] == len(_SUMMARY)
    assert shape[2]["chars"] == len(_TASK)
    assert shape[3]["tool_name"] == "read_file"
    assert shape[3]["chars"] == len('{"path": "SECRET.csv"}')
    assert shape[4] == {
        "role": "tool", "kind": "tool_result", "chars": len("SECRET-TOOL-OUTPUT"),
        "tool_name": "read_file",
    }
    assert "tool_name" not in shape[5]


def test_shape_carries_no_message_text() -> None:
    serialized = json.dumps(compaction_window_shape(_mid_turn_window()))
    assert "SECRET" not in serialized
    assert COMPACTED_SUMMARY_HEADING not in serialized
    for row in compaction_window_shape(_mid_turn_window()):
        assert set(row) <= {"role", "kind", "chars", "tool_name"}


def test_task_stub_after_the_summary_is_the_pin() -> None:
    rows = _mid_turn_window()
    rows[2] = {"role": "user", "content": MID_TURN_TASK_STUB}
    assert compaction_window_shape(rows)[2]["kind"] == "task_pin"


def test_preflight_window_without_a_nudge_has_no_task_pin() -> None:
    rows = [
        {"role": "system", "content": _SUMMARY},
        {"role": "user", "content": "next question"},
        {"role": "assistant", "content": "answer"},
    ]
    assert [row["kind"] for row in compaction_window_shape(rows)] == [
        "summary", "text", "text",
    ]


def test_tool_result_name_falls_back_to_the_matching_call() -> None:
    rows = _mid_turn_window()
    del rows[4]["name"]
    assert compaction_window_shape(rows)[4]["tool_name"] == "read_file"


def test_shape_is_capped() -> None:
    rows = [{"role": "user", "content": "x"}] * (WINDOW_SHAPE_MAX_ROWS + 40)
    assert WINDOW_SHAPE_MAX_ROWS == 128
    assert len(compaction_window_shape(rows)) == WINDOW_SHAPE_MAX_ROWS


def test_compacted_event_extras_carry_window_shape_and_summary_source_omissions() -> None:
    messages = [{"role": "system", "content": _SUMMARY}, {"role": "user", "content": _TASK}]

    extras = compacted_event_extras(
        SimpleNamespace(messages=messages, summary_input_dropped_messages=4)
    )

    assert extras == {
        "window_shape": compaction_window_shape(messages),
        "summary_source_dropped_messages": 4,
    }
    assert compacted_event_extras(
        SimpleNamespace(messages=messages, summary_input_dropped_messages=0)
    )["summary_source_dropped_messages"] == 0
    assert compacted_event_extras(
        SimpleNamespace(messages=messages, summary_input_dropped_messages=-3)
    )["summary_source_dropped_messages"] == 0


def test_tool_loop_compaction_reports_the_window_after_the_repin(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    progress = WriteProgress()
    progress.observe(
        [ToolExecutionOutcome(tool_name="read_file", output="x", success=True)]
        * READS_WITHOUT_WRITE_LIMIT
    )
    assert progress.next_text()  # the outstanding instruction the re-pin appends
    compacted =[{"role": "system", "content": _SUMMARY}, {"role": "user", "content": _TASK}]
    monkeypatch.setattr(
        tool_loop_compaction,
        "compact_context",
        lambda *_args, **_kwargs: SimpleNamespace(
            messages=compacted, tokens_before=900, tokens_after=100, error=None,
            strategy="full", summary_status="created", summary_failure_code=None,
            summary_message={"role": "system", "content": _SUMMARY},
            covered_through_tool_call_id="call_1", summary_input_dropped_messages=0,
        ),
    )
    monkeypatch.setattr(tool_loop_compaction, "resolve_compaction_prompt", lambda _config: None)
    kernel = MagicMock()
    kernel._config.max_tokens = 100
    kernel._config.resolved_user_max_output_tokens = None
    kernel._engine.get_model_max_output_tokens.return_value = 100
    runtime = MagicMock()
    runtime._preview_context_tokens.return_value = 0
    loop = SimpleNamespace(
        budget_tracker=SimpleNamespace(
            budget=TokenBudget(context_window=1_800, max_output_tokens=200, reserved_for_summary=200),
            backend=None,
        ),
        runtime=runtime,
        working_messages=[{"role": "user", "content": _TASK}],
        feature_flags={"context_compaction": True},
        compaction_stalled=False,
        request_id="request",
        session_id="session",
        system_prompt="system",
        latest_user_content=_TASK,
        prompt_cache_enabled=False,
        kernel=kernel,
        request_context=SimpleNamespace(plan_approved_in_turn=False),
        cache_break_detector=None,
        _write_progress=progress,
    )
    loop._after_context_compaction = MethodType(_ToolLoopRun._after_context_compaction, loop)

    compact_tool_loop_context(loop, num_tools=0, force=True)

    events = [
        call.args[0]
        for call in runtime.emit_safe.call_args_list
        if isinstance(call.args[0], ContextCompactedEvent)
    ]
    assert len(events) == 1
    assert events[0].window_shape == compaction_window_shape(loop.working_messages)
    assert [row["kind"] for row in events[0].window_shape] == ["summary", "text", "system"]
