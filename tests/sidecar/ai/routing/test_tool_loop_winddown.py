from __future__ import annotations

from sidecar.ai.routing.loop_events import StreamResetEvent, TokenDeltaEvent
from sidecar.ai.routing.loop_runtime import LoopRuntime
from sidecar.ai.routing.router import ToolExecutionOutcome
from sidecar.ai.routing.tool_loop import _empty_post_tool_context_response
from sidecar.ai.routing.tool_loop_recovery import _max_iterations_fallback_response
from sidecar.ai.tools.models import GenerationResult, ToolCallRequest

from .test_tool_loop import (
    _build_router,
    _mermaid_descriptor,
    _StubMCPClient,
    _ToolLoopEngine,
    _ToolPlan,
)


class _FailingWindDownEngine(_ToolLoopEngine):
    def generate_with_tools(self, **kwargs):
        if self.call_count == 2:
            self.requests.append(kwargs)
            self.call_count += 1
            raise RuntimeError("wind-down failed")
        return super().generate_with_tools(**kwargs)


def _run(plans: list[_ToolPlan], *, engine_type=_ToolLoopEngine):
    engine = engine_type(plans=plans)
    router = _build_router(
        engine=engine,
        mcp_client=_StubMCPClient((_mermaid_descriptor(),)),
        tools_mermaid_enabled=True,
    )
    decision = router.build_chat_decision(
        request_id="req_empty_final_winddown",
        messages=[{"role": "user", "content": "Generate a diagram."}],
        latest_user_content="Generate a diagram.",
        mode="assist",
        approvals_pre_granted=True,
        runtime=LoopRuntime(
            request_id="req_empty_final_winddown",
            max_iterations=4,
        ),
    )
    return engine, decision


def _tool_plan() -> _ToolPlan:
    return _ToolPlan(
        result=GenerationResult(
            content="",
            finish_reason="tool_calls",
            tool_calls=(
                ToolCallRequest(
                    tool_id="mermaid_generate",
                    arguments={"prompt": "flowchart TD\n  A --> B"},
                    call_id="call_empty_final_winddown",
                ),
            ),
        )
    )


def test_empty_final_after_tool_work_runs_wind_down_generation() -> None:
    engine, decision = _run(
        [
            _tool_plan(),
            _ToolPlan(result=GenerationResult(content="  \t", finish_reason="stop")),
            _ToolPlan(
                result=GenerationResult(
                    content="The diagram was generated successfully.",
                    finish_reason="stop",
                )
            ),
        ]
    )

    assert engine.call_count == 3
    assert decision.response_text == "The diagram was generated successfully."
    assert decision.completion_source == "model_winddown"
    assert engine.requests[-1]["tools"] == []


def test_empty_wind_down_uses_deterministic_tool_outcome_fallback() -> None:
    engine, decision = _run(
        [
            _tool_plan(),
            _ToolPlan(result=GenerationResult(content="", finish_reason="stop")),
            _ToolPlan(result=GenerationResult(content="", finish_reason="stop")),
        ]
    )

    assert engine.call_count == 3
    assert "mermaid_generate" in decision.response_text
    assert "completed" in decision.response_text.lower()
    assert decision.completion_source == "deterministic_tool_fallback"


def test_empty_mixed_tool_batch_summary_preserves_successes_and_failures() -> None:
    response = _empty_post_tool_context_response(
        [
            ToolExecutionOutcome(
                tool_name="read_file",
                output="README contents",
                success=True,
            ),
            ToolExecutionOutcome(
                tool_name="run_command",
                output="process bootstrap failed",
                success=False,
                error_code="CMP-TOOL-0001",
            ),
        ]
    )

    assert response is not None
    assert "Some tool calls succeeded and others failed" in response
    assert "read_file: README contents" in response
    assert "run_command [CMP-TOOL-0001]: process bootstrap failed" in response


def test_zero_iteration_fallback_preserves_mixed_tool_outcomes() -> None:
    response = _max_iterations_fallback_response(
        [
            ToolExecutionOutcome(
                tool_name="read_file",
                output="README contents",
                success=True,
            ),
            ToolExecutionOutcome(
                tool_name="run_command",
                output="not a git repository",
                success=False,
                error_code="CMP-TOOL-0008",
            ),
        ]
    )

    assert "Some tool calls succeeded and others failed" in response
    assert "read_file: README contents" in response
    assert "run_command [CMP-TOOL-0008]: not a git repository" in response


def test_zero_iteration_fallback_preserves_failed_only_outcome() -> None:
    response = _max_iterations_fallback_response(
        [
            ToolExecutionOutcome(
                tool_name="run_command",
                output="not a git repository",
                success=False,
                error_code="CMP-TOOL-0008",
            )
        ]
    )

    assert "requested tool call failed or was unavailable" in response
    assert "run_command [CMP-TOOL-0008]: not a git repository" in response


def test_failed_wind_down_uses_deterministic_tool_outcome_fallback() -> None:
    engine, decision = _run(
        [
            _tool_plan(),
            _ToolPlan(result=GenerationResult(content="", finish_reason="stop")),
        ],
        engine_type=_FailingWindDownEngine,
    )

    assert engine.call_count == 3
    assert "mermaid_generate" in decision.response_text
    assert "completed" in decision.response_text.lower()
    assert decision.completion_source == "deterministic_tool_fallback"


def test_visible_final_after_tool_work_does_not_run_wind_down() -> None:
    engine, decision = _run(
        [
            _tool_plan(),
            _ToolPlan(result=GenerationResult(content="Done.", finish_reason="stop")),
        ]
    )

    assert engine.call_count == 2
    assert decision.response_text == "Done."
    assert decision.completion_source == "model"


def test_max_iteration_wind_down_resets_stale_text_before_fallback() -> None:
    engine = _ToolLoopEngine(
        plans=[
            _ToolPlan(
                result=_tool_plan().result,
                stream_chunks=("Planning recursive file search with PowerShell",),
            ),
            _ToolPlan(result=GenerationResult(content="", finish_reason="stop")),
        ]
    )
    router = _build_router(
        engine=engine,
        mcp_client=_StubMCPClient((_mermaid_descriptor(),)),
        tools_mermaid_enabled=True,
    )
    events: list[object] = []
    runtime = LoopRuntime(
        emit=events.append,
        request_id="req_max_iteration_winddown",
        max_iterations=1,
        streaming=True,
    )

    decision = router.build_chat_decision(
        request_id="req_max_iteration_winddown",
        messages=[{"role": "user", "content": "Generate a diagram."}],
        latest_user_content="Generate a diagram.",
        mode="assist",
        approvals_pre_granted=True,
        runtime=runtime,
    )

    reset_reasons = [event.reason for event in events if isinstance(event, StreamResetEvent)]
    replacement_reset_index = max(
        index
        for index, event in enumerate(events)
        if isinstance(event, StreamResetEvent) and event.reason == "deterministic_replacement"
    )
    visible_after_replacement = "".join(
        event.delta
        for event in events[replacement_reset_index + 1 :]
        if isinstance(event, TokenDeltaEvent)
    )

    assert reset_reasons[-2:] == ["model_winddown", "deterministic_replacement"]
    assert visible_after_replacement == decision.response_text
    assert "Planning recursive" not in visible_after_replacement
    assert decision.completion_source == "deterministic_tool_fallback"
    assert "chat.token" in decision.streamed_event_types
    assert getattr(runtime, "completion_reason", None) == "max_iterations_summary"
    # Guards the ToolLoopResult -> _build_chat_decision -> ChatDecision hop for
    # resumable_stop. The approval-resume path has its own test, but this is the
    # route every ordinary budget stop takes, and it is the only one driven by a
    # real wound-down loop rather than a stubbed result.
    assert decision.resumable_stop == "max_iterations"
