"""Turn-ending contracts for the tool-cap, diminishing-returns and context-budget stops.

Split from test_tool_loop_recovery.py (600-line test ceiling); shares its harness.
"""

from __future__ import annotations

import logging
import sys
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent))

import pytest  # noqa: E402
from test_tool_loop import (  # noqa: E402 — shared loop harness.
    _build_router,
    _mermaid_descriptor,
    _StubMCPClient,
    _ToolLoopEngine,
    _ToolPlan,
)

from sidecar.ai.context.token_budget import BudgetTracker  # noqa: E402
from sidecar.ai.mcp.models import MCPToolDescriptor  # noqa: E402
from sidecar.ai.routing.loop_events import (  # noqa: E402
    StreamResetEvent,
    ThinkingEvent,
    TokenDeltaEvent,
)
from sidecar.ai.routing.loop_runtime import LoopRuntime  # noqa: E402
from sidecar.ai.routing.tool_loop_recovery import (  # noqa: E402
    _is_tool_call_markup,
    budget_exhausted_wind_down,
    max_iterations_summary,
)
from sidecar.ai.tools.models import (  # noqa: E402
    GenerationResult,
    GenerationUsage,
    ToolCallRequest,
)
from sidecar.protocol import CHAT_THINKING_KIND_STATUS  # noqa: E402


def _tool_plan(*calls: ToolCallRequest) -> _ToolPlan:
    return _ToolPlan(
        result=GenerationResult(content="", finish_reason="tool_calls", tool_calls=calls)
    )


_TOOL_CAP_FOOTER = "Reached this turn's tool limit (1). Reply 'resume' to continue."
_DIMINISHING_RETURNS_FOOTER = (
    "Stopped after 3 tool calls in a row made no progress. Reply 'resume' to continue."
)


def _budget_stop_loop() -> SimpleNamespace:
    runtime = LoopRuntime(
        emit=lambda _event: None,
        request_id="req_budget_stop_detail",
        tool_call_limit=3,
        tool_calls_consumed=2,
    )
    return SimpleNamespace(
        runtime=runtime,
        request_id=runtime.request_id,
        session_id="",
        budget_tracker=SimpleNamespace(current_context_tokens=42),
        outcomes=[],
        usage_totals=None,
        streamed_event_types=set(),
        max_iterations=3,
        _finish=lambda result, *, reason: result,
        _settle_unfinished_tool_results=lambda _reason: None,
    )


@pytest.mark.parametrize("reason", ["tool_cap", "diminishing_returns", "context_budget"])
def test_budget_exhausted_wind_down_sets_resumable_stop(
    monkeypatch: pytest.MonkeyPatch,
    reason: str,
) -> None:
    monkeypatch.setattr(
        "sidecar.ai.routing.tool_loop_recovery.wind_down_response",
        lambda _loop, _spec: ("Budget summary.", "model_winddown"),
    )

    result = budget_exhausted_wind_down(
        _budget_stop_loop(),
        GenerationResult(content="", finish_reason="stop"),
        reason=reason,
    )

    assert result.resumable_stop == reason


def test_max_iterations_summary_sets_resumable_stop(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "sidecar.ai.routing.tool_loop_recovery.wind_down_response",
        lambda _loop, _spec: ("Iteration summary.", "model_winddown"),
    )

    result = max_iterations_summary(_budget_stop_loop())

    assert result.resumable_stop == "max_iterations"


def test_tool_cap_markup_final_runs_clean_visible_wind_down(caplog) -> None:
    caplog.set_level(logging.INFO, logger="sidecar.ai.routing.tool_loop")
    engine = _ToolLoopEngine(
        plans=[
            _tool_plan(
                ToolCallRequest(
                    tool_id="mermaid_generate",
                    arguments={"prompt": "flowchart TD\n  a --> b"},
                    call_id="call_cap_markup",
                ),
            ),
            _ToolPlan(
                result=GenerationResult(
                    content=(
                        "<tool_call><function=run_command><parameter=command>"
                        "dir</parameter></function></tool_call>"
                    ),
                    finish_reason="stop",
                )
            ),
            _ToolPlan(
                result=GenerationResult(
                    content="I created the diagram and cannot run another tool this turn.",
                    finish_reason="stop",
                )
            ),
        ]
    )
    events: list[object] = []
    decision = _build_router(
        engine=engine,
        mcp_client=_StubMCPClient((_mermaid_descriptor(),)),
        tools_mermaid_enabled=True,
        max_tools_per_turn=1,
    ).build_chat_decision(
        request_id="req_tool_cap_markup",
        messages=[{"role": "user", "content": "Create a diagram, then run dir."}],
        latest_user_content="Create a diagram, then run dir.",
        mode="assist",
        approvals_pre_granted=True,
        runtime=LoopRuntime(
            emit=events.append,
            request_id="req_tool_cap_markup",
            max_iterations=4,
            streaming=True,
        ),
    )

    assert "<tool_call" not in decision.response_text
    assert "<function=" not in decision.response_text
    assert decision.response_text.endswith(_TOOL_CAP_FOOTER)
    assert engine.requests[-1]["tools"] == []
    assert any(
        isinstance(event, ThinkingEvent)
        and event.kind == CHAT_THINKING_KIND_STATUS
        and event.delta == _TOOL_CAP_FOOTER
        for event in events
    )
    cap_records = [
        record
        for record in caplog.records
        if record.__dict__.get("event") == "ai.router.tool_cap_reached"
    ]
    assert len(cap_records) == 1
    assert cap_records[0].levelno == logging.INFO
    assert cap_records[0].__dict__["data"] == {"limit": 1, "tool_calls_used": 1}


def test_tool_cap_prose_final_is_kept_without_regeneration() -> None:
    engine = _ToolLoopEngine(
        plans=[
            _tool_plan(
                ToolCallRequest(
                    tool_id="mermaid_generate",
                    arguments={"prompt": "flowchart TD\n  a --> b"},
                    call_id="call_cap_prose",
                ),
            ),
            _ToolPlan(
                result=GenerationResult(
                    content="The diagram is complete.",
                    finish_reason="stop",
                )
            ),
        ]
    )
    decision = _build_router(
        engine=engine,
        mcp_client=_StubMCPClient((_mermaid_descriptor(),)),
        tools_mermaid_enabled=True,
        max_tools_per_turn=1,
    ).build_chat_decision(
        request_id="req_tool_cap_prose",
        messages=[{"role": "user", "content": "Create a diagram."}],
        latest_user_content="Create a diagram.",
        mode="assist",
        approvals_pre_granted=True,
        runtime=LoopRuntime(
            emit=lambda _event: None,
            request_id="req_tool_cap_prose",
            max_iterations=3,
        ),
    )

    assert decision.response_text.startswith("The diagram is complete.")
    assert decision.response_text.endswith(_TOOL_CAP_FOOTER)
    assert decision.response_text.count(_TOOL_CAP_FOOTER) == 1
    assert engine.call_count == 2


def test_diminishing_returns_regenerates_without_reusing_pre_tool_text(
    monkeypatch: pytest.MonkeyPatch,
    caplog,
) -> None:
    caplog.set_level(logging.INFO, logger="sidecar.ai.routing.tool_loop")
    tracker = BudgetTracker()
    monkeypatch.setattr(
        "sidecar.ai.routing.chat_decision.is_feature_flag_enabled",
        lambda _flags, _name: True,
    )
    monkeypatch.setattr(
        "sidecar.ai.routing.chat_decision.apply_budget_check",
        lambda messages, _config, _engine, *, num_tools=0, reasoning_effort=None: (
            messages,
            None,
            tracker,
        ),
    )
    usage = GenerationUsage(output_tokens=100)
    tool_names = ("no_progress_one", "no_progress_two", "no_progress_three")
    engine = _ToolLoopEngine(
        plans=[
            _ToolPlan(
                result=GenerationResult(
                    content="Let me check the file.",
                    finish_reason="tool_calls",
                    tool_calls=(
                        ToolCallRequest(
                            tool_id=tool_name,
                            arguments={"path": f"file-{index}.txt"},
                            call_id=f"call_no_progress_{index}",
                        ),
                    ),
                    usage=usage,
                )
            )
            for index, tool_name in enumerate(tool_names)
        ]
        + [
            _ToolPlan(
                result=GenerationResult(
                    content="The file checks kept failing, so I could not make progress.",
                    finish_reason="stop",
                )
            )
        ]
    )
    events: list[object] = []
    decision = _build_router(
        engine=engine,
        mcp_client=_StubMCPClient(
            tuple(
                MCPToolDescriptor(
                    name=tool_name,
                    description="Fail without progress",
                    input_schema={"type": "object"},
                    side_effecting=False,
                    server_name="tools",
                )
                for tool_name in tool_names
            ),
            success=False,
        ),
        max_tools_per_turn=10,
        extra_snapshot_tools=tool_names,
    ).build_chat_decision(
        request_id="req_diminishing_returns",
        messages=[{"role": "user", "content": "Check three files."}],
        latest_user_content="Check three files.",
        mode="assist",
        approvals_pre_granted=True,
        runtime=LoopRuntime(
            emit=events.append,
            request_id="req_diminishing_returns",
            max_iterations=5,
        ),
    )

    assert not decision.response_text.startswith("Let me check the file.")
    assert decision.response_text.count("Let me check the file.") == 0
    assert decision.response_text.endswith(_DIMINISHING_RETURNS_FOOTER)
    assert engine.call_count == 4
    assert engine.requests[-1]["tools"] == []
    assert any(
        isinstance(event, ThinkingEvent)
        and event.kind == CHAT_THINKING_KIND_STATUS
        and event.delta == _DIMINISHING_RETURNS_FOOTER
        for event in events
    )
    stop_records = [
        record
        for record in caplog.records
        if record.__dict__.get("event") == "ai.router.diminishing_returns_stop"
    ]
    assert len(stop_records) == 1
    assert stop_records[0].levelno == logging.INFO
    assert stop_records[0].__dict__["data"] == {
        "consecutive_no_progress_window_size": 3,
        "tool_calls_used": 3,
    }


_CONTEXT_BUDGET_FOOTER = (
    "Stopped: this turn's context budget is used up. Reply 'resume' to continue."
)


def test_tool_cap_overflow_then_prose_still_gets_footer() -> None:
    # One slot left, two calls requested: one runs, one is rejected (overflow),
    # then the model answers in prose. The resume hint must still be appended.
    engine = _ToolLoopEngine(
        plans=[
            _tool_plan(
                ToolCallRequest(
                    tool_id="mermaid_generate",
                    arguments={"prompt": "flowchart TD\n  a --> b"},
                    call_id="call_overflow_1",
                ),
                ToolCallRequest(
                    tool_id="mermaid_generate",
                    arguments={"prompt": "flowchart TD\n  b --> c"},
                    call_id="call_overflow_2",
                ),
            ),
            _ToolPlan(result=GenerationResult(content="Done.", finish_reason="stop")),
        ]
    )
    decision = _build_router(
        engine=engine,
        mcp_client=_StubMCPClient((_mermaid_descriptor(),)),
        tools_mermaid_enabled=True,
        max_tools_per_turn=1,
    ).build_chat_decision(
        request_id="req_tool_cap_overflow",
        messages=[{"role": "user", "content": "Create two diagrams."}],
        latest_user_content="Create two diagrams.",
        mode="assist",
        approvals_pre_granted=True,
        runtime=LoopRuntime(
            emit=lambda _event: None,
            request_id="req_tool_cap_overflow",
            max_iterations=3,
        ),
    )

    assert decision.response_text.startswith("Done.")
    assert decision.response_text.endswith(_TOOL_CAP_FOOTER)
    assert decision.response_text.count(_TOOL_CAP_FOOTER) == 1
    assert engine.call_count == 2


def test_tool_cap_truncated_final_keeps_stream_terminal_contract() -> None:
    # A post-cap generation cut off by the provider must still surface the
    # retryable stream-incomplete error, not a clean "reply resume" footer.
    engine = _ToolLoopEngine(
        plans=[
            _tool_plan(
                ToolCallRequest(
                    tool_id="mermaid_generate",
                    arguments={"prompt": "flowchart TD\n  a --> b"},
                    call_id="call_cap_truncated",
                ),
            ),
            _ToolPlan(result=GenerationResult(content="Partial", finish_reason="incomplete")),
        ]
    )
    decision = _build_router(
        engine=engine,
        mcp_client=_StubMCPClient((_mermaid_descriptor(),)),
        tools_mermaid_enabled=True,
        max_tools_per_turn=1,
    ).build_chat_decision(
        request_id="req_tool_cap_truncated",
        messages=[{"role": "user", "content": "Create a diagram."}],
        latest_user_content="Create a diagram.",
        mode="assist",
        approvals_pre_granted=True,
        runtime=LoopRuntime(
            emit=lambda _event: None,
            request_id="req_tool_cap_truncated",
            max_iterations=3,
        ),
    )

    assert _TOOL_CAP_FOOTER not in decision.response_text
    assert "cut off" in decision.response_text


def test_context_budget_stop_uses_deterministic_summary_without_regeneration(
    monkeypatch: pytest.MonkeyPatch,
    caplog,
) -> None:
    caplog.set_level(logging.INFO, logger="sidecar.ai.routing.tool_loop")
    tracker = BudgetTracker()
    monkeypatch.setattr(tracker, "stop_reason", lambda: "context_budget")
    monkeypatch.setattr(
        "sidecar.ai.routing.chat_decision.is_feature_flag_enabled",
        lambda _flags, _name: True,
    )
    monkeypatch.setattr(
        "sidecar.ai.routing.chat_decision.apply_budget_check",
        lambda messages, _config, _engine, *, num_tools=0, reasoning_effort=None: (
            messages,
            None,
            tracker,
        ),
    )
    engine = _ToolLoopEngine(
        plans=[
            _ToolPlan(
                result=GenerationResult(
                    content="Let me check the file.",
                    finish_reason="tool_calls",
                    tool_calls=(
                        ToolCallRequest(
                            tool_id="mermaid_generate",
                            arguments={"prompt": "flowchart TD\n  a --> b"},
                            call_id="call_context_budget",
                        ),
                    ),
                    usage=GenerationUsage(output_tokens=100),
                )
            ),
        ]
    )
    events: list[object] = []
    decision = _build_router(
        engine=engine,
        mcp_client=_StubMCPClient((_mermaid_descriptor(),)),
        tools_mermaid_enabled=True,
        max_tools_per_turn=10,
    ).build_chat_decision(
        request_id="req_context_budget",
        messages=[{"role": "user", "content": "Create a diagram."}],
        latest_user_content="Create a diagram.",
        mode="assist",
        approvals_pre_granted=True,
        runtime=LoopRuntime(
            emit=events.append,
            request_id="req_context_budget",
            max_iterations=5,
            streaming=True,
        ),
    )

    assert engine.call_count == 1, "no regeneration once the context is over threshold"
    assert "Let me check the file." not in decision.response_text
    assert decision.response_text.endswith(_CONTEXT_BUDGET_FOOTER)
    # The already-streamed pre-tool text must be reset and the replacement
    # streamed, or the live row and the persisted answer diverge.
    assert any(
        isinstance(event, StreamResetEvent) and event.reason == "deterministic_replacement"
        for event in events
    )
    last_reset = max(
        index for index, event in enumerate(events) if isinstance(event, StreamResetEvent)
    )
    streamed_replacement = "".join(
        event.delta
        for event in events[last_reset + 1 :]
        if isinstance(event, TokenDeltaEvent)
    )
    assert streamed_replacement and streamed_replacement in decision.response_text
    assert "Let me check the file." not in streamed_replacement
    assert _DIMINISHING_RETURNS_FOOTER not in decision.response_text
    assert any(
        isinstance(event, ThinkingEvent)
        and event.kind == CHAT_THINKING_KIND_STATUS
        and event.delta == _CONTEXT_BUDGET_FOOTER
        for event in events
    )
    events_logged = [record.__dict__.get("event") for record in caplog.records]
    assert "ai.router.context_budget_stop" in events_logged
    assert "ai.router.diminishing_returns_stop" not in events_logged


def _loop_with_tools(*names: str) -> SimpleNamespace:
    entries = tuple(
        SimpleNamespace(
            descriptor=MCPToolDescriptor(
                name=name,
                description="",
                input_schema={"type": "object"},
                side_effecting=False,
                server_name="tools",
            ),
            available=True,
        )
        for name in names
    )
    return SimpleNamespace(tool_contract=SimpleNamespace(entries=entries))


@pytest.mark.parametrize(
    "text",
    [
        'Here is the manifest:\n```json\n{"name": "world", "version": "1.0.0"}\n```',
        'Then call render({"mode": "dark"}) to repaint.',
        "The model emitted a raw `<tool_call>` block, which is the bug.",
        "Plain prose answer.",
    ],
)
def test_tool_call_markup_detector_ignores_prose(text: str) -> None:
    assert _is_tool_call_markup(text, _loop_with_tools("read_file")) is False


@pytest.mark.parametrize(
    "text",
    [
        "<tool_call><function=run_command><parameter=command>dir</parameter></function></tool_call>",
        "<function=run_command><parameter=command>dir</parameter></function>",
        '<tool_call>{"name": "read_file", "arguments": {"path": "a.txt"}}</tool_call>',
        '```json\n{"name": "read_file", "arguments": {"path": "a.txt"}}\n```',
        'read_file({"path": "a.txt"})',
    ],
)
def test_tool_call_markup_detector_flags_real_markup(text: str) -> None:
    assert _is_tool_call_markup(text, _loop_with_tools("read_file")) is True
