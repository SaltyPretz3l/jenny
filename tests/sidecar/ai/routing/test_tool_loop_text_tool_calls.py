"""HB-031: a tool call written as text on a tools-less leg never runs and never persists.

Shares the test_tool_loop harness, like test_tool_loop_budget_endings.py.
"""

from __future__ import annotations

import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_tool_loop import (  # shared loop harness.
    _build_router,
    _mermaid_descriptor,
    _StubMCPClient,
    _ToolLoopEngine,
    _ToolPlan,
)

from sidecar.ai.mcp.models import MCPToolDescriptor
from sidecar.ai.routing.loop_events import StreamResetEvent, TokenDeltaEvent
from sidecar.ai.routing.loop_runtime import LoopRuntime
from sidecar.ai.tools.models import GenerationResult, ToolCallRequest

_TOOL_CAP_FOOTER = "Reached this turn's tool limit (1). Reply 'resume' to continue."
_PROSE = "Now writing the code."
# Trimmed from the persisted HB-031 leak (Qwen3-Coder template, opener included).
_LEAK = (
    f"{_PROSE}\n\n<tool_call>\n<function=edit_file>\n"
    "<parameter=path>\nbank_recon/matching.py\n</parameter>\n"
    "<parameter=old_string>\n# --- G5 fix: noise-tolerant text gate\n</parameter>\n"
    "<parameter=new_string>\n# --- G5 fix: strict token-subset rescue\n</parameter>\n"
    "</function>\n</tool_call>"
)


def _edit_file_descriptor() -> MCPToolDescriptor:
    return MCPToolDescriptor(
        name="edit_file",
        description="Edit a file.",
        input_schema={"type": "object", "additionalProperties": True},
        side_effecting=False,
        server_name="stub",
    )


def _mermaid_call() -> _ToolPlan:
    call = ToolCallRequest(
        tool_id="mermaid_generate",
        arguments={"prompt": "flowchart TD\n  a --> b"},
        call_id="call_text_tool_cap",
    )
    return _ToolPlan(
        result=GenerationResult(content="", finish_reason="tool_calls", tool_calls=(call,))
    )


def _decide(engine: _ToolLoopEngine, runtime: LoopRuntime):
    return _build_router(
        engine=engine,
        mcp_client=_StubMCPClient((_mermaid_descriptor(), _edit_file_descriptor())),
        tools_mermaid_enabled=True,
        max_tools_per_turn=1,
        extra_snapshot_tools=("edit_file",),
    ).build_chat_decision(
        request_id=runtime.request_id,
        messages=[{"role": "user", "content": "Fix the matcher."}],
        latest_user_content="Fix the matcher.",
        mode="assist",
        approvals_pre_granted=True,
        runtime=runtime,
    )


def _assert_no_markup(text: str) -> None:
    assert "<tool_call" not in text
    assert "<function=" not in text
    assert "<parameter=" not in text


def _streamed_after_last_reset(events: list[object]) -> str:
    resets = [index for index, event in enumerate(events) if isinstance(event, StreamResetEvent)]
    assert resets, "the already-streamed markup must be reset"
    assert events[resets[-1]].reason == "deterministic_replacement"
    return "".join(
        event.delta for event in events[resets[-1] + 1 :] if isinstance(event, TokenDeltaEvent)
    )


def _dropped_records(caplog) -> list[logging.LogRecord]:
    return [
        record
        for record in caplog.records
        if record.__dict__.get("event") == "ai.router.text_tool_call_dropped"
    ]


def test_resumed_leg_with_a_spent_tool_budget_ends_as_tool_cap() -> None:
    # The approval / continuation resume builds a new run without the
    # tools-stripped flag; the spent runtime budget alone must arm the ending.
    engine = _ToolLoopEngine(plans=[_ToolPlan(result=GenerationResult(content=_LEAK, finish_reason="stop"))])
    runtime = LoopRuntime(
        emit=lambda _event: None,
        request_id="req_text_call_resumed",
        max_iterations=3,
        tool_call_limit=1,
        tool_calls_consumed=1,
    )

    decision = _decide(engine, runtime)

    assert decision.response_text.endswith(_TOOL_CAP_FOOTER)
    assert decision.resumable_stop == "tool_cap"
    _assert_no_markup(decision.response_text)
    assert engine.call_count == 1


def test_in_loop_cap_strips_prose_prefixed_markup_and_says_it_did_not_run(caplog) -> None:
    caplog.set_level(logging.INFO, logger="sidecar.ai.routing.tool_loop")
    engine = _ToolLoopEngine(
        plans=[_mermaid_call(), _ToolPlan(result=GenerationResult(content=_LEAK, finish_reason="stop"))]
    )
    events: list[object] = []
    runtime = LoopRuntime(
        emit=events.append, request_id="req_text_call_in_loop", max_iterations=4, streaming=True
    )

    decision = _decide(engine, runtime)

    text = decision.response_text
    assert text.startswith(_PROSE)
    assert "`edit_file`" in text
    assert "did not run" in text
    _assert_no_markup(text)
    assert text.endswith(_TOOL_CAP_FOOTER)
    assert text.count(_TOOL_CAP_FOOTER) == 1
    assert decision.resumable_stop == "tool_cap"
    assert engine.call_count == 2, "the prose is kept; no regeneration"
    streamed = _streamed_after_last_reset(events)
    assert streamed and streamed in text and "did not run" in streamed
    _assert_no_markup(streamed)
    (record,) = _dropped_records(caplog)
    assert record.levelno == logging.INFO
    assert record.__dict__["data"] == {
        "tools": ["edit_file"],
        "complete": True,
        "reason": "tool_cap",
        "shape": "qwen_xml",
    }


def test_tools_stripped_wind_down_never_persists_markup(caplog) -> None:
    # Markup-only final -> the tools-stripped wind-down runs, and that leg
    # writes prose plus another text call (truncated this time).
    caplog.set_level(logging.INFO, logger="sidecar.ai.routing.tool_loop")
    markup_only = _LEAK.split("\n\n", 1)[1]
    wind_down = "I made the diagram; the matcher edit is still pending.\n\n" + markup_only[:90]
    engine = _ToolLoopEngine(
        plans=[
            _mermaid_call(),
            _ToolPlan(result=GenerationResult(content=markup_only, finish_reason="stop")),
            _ToolPlan(result=GenerationResult(content=wind_down, finish_reason="stop")),
        ]
    )
    events: list[object] = []
    runtime = LoopRuntime(
        emit=events.append, request_id="req_text_call_wind_down", max_iterations=4, streaming=True
    )

    decision = _decide(engine, runtime)

    text = decision.response_text
    assert engine.call_count == 3
    assert engine.requests[-1]["tools"] == []
    assert text.startswith("I made the diagram; the matcher edit is still pending.")
    assert "`edit_file`" in text and "did not run" in text
    _assert_no_markup(text)
    assert text.endswith(_TOOL_CAP_FOOTER)
    assert decision.resumable_stop == "tool_cap"
    streamed = _streamed_after_last_reset(events)
    assert streamed and streamed in text
    _assert_no_markup(streamed)
    (record,) = _dropped_records(caplog)
    assert record.__dict__["data"] == {
        "tools": ["edit_file"],
        "complete": False,
        "reason": "tools_stripped",
        "shape": "qwen_xml",
    }
