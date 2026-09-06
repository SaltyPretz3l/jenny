"""Approval-resume iteration continuity.

A tool loop paused for approval and resumed must CONTINUE the turn's
iteration numbering instead of restarting at 1: streamed thinking/phase
identities embed ``runtime.current_iteration``
(``think_{request_id}_iter{N}``, ``phase_{kind}_{request_id}_iter{N}_{i}``),
so a restart reuses pre-approval identities and live views key duplicate
"Thought" rows off the colliding ids. The resume path threads the paused
iteration back in as ``LoopRuntime.iteration_base`` sourced from
``ApprovalPlan.completed_iterations``.
"""

from __future__ import annotations

from dataclasses import replace

from sidecar.ai.config import ToolPolicyRule, ToolPolicyRuleMatch, ToolPolicySnapshot
from sidecar.ai.feature_flags import FEATURE_PHASE_EVENTS
from sidecar.ai.mcp.models import MCPToolDescriptor
from sidecar.ai.routing.loop_events import IterationStartEvent, PhaseStartedEvent
from sidecar.ai.routing.loop_runtime import LoopRuntime
from sidecar.ai.tools.models import GenerationResult, ThinkingDelta, ToolCallRequest

from tests.sidecar.ai.routing.test_tool_loop import (
    _StubMCPClient,
    _ToolLoopEngine,
    _ToolPlan,
    _build_router,
)

_REQUEST_ID = "req_iteration_continuity"


def _read_descriptor() -> MCPToolDescriptor:
    return MCPToolDescriptor(
        name="read_file",
        description="Read a file",
        input_schema={"type": "object", "properties": {"path": {"type": "string"}}},
        side_effecting=False,
        server_name="tools",
        tool_family="filesystem",
    )


def _ask_read_policy() -> ToolPolicySnapshot:
    return ToolPolicySnapshot(
        version=2,
        rules=(
            ToolPolicyRule(
                id="ask-reads",
                decision="ask",
                reason="Review all file reads",
                match=ToolPolicyRuleMatch(tool_id="read_file"),
            ),
        ),
    )


def _pausing_router(engine: _ToolLoopEngine):
    router = _build_router(engine=engine, mcp_client=_StubMCPClient((_read_descriptor(),)))
    router._config = replace(
        router._config,
        tool_policy_snapshot=_ask_read_policy(),
        feature_flags={FEATURE_PHASE_EVENTS: True},
    )
    return router


def _run_decision(router, *, runtime: LoopRuntime):
    return router.build_chat_decision(
        request_id=_REQUEST_ID,
        messages=[{"role": "user", "content": "read README"}],
        latest_user_content="read README",
        mode="assist",
        approvals_pre_granted=False,
        runtime=runtime,
    )


def _ask_gated_tool_plan(call_id: str) -> _ToolPlan:
    return _ToolPlan(
        result=GenerationResult(
            content="",
            finish_reason="tool_calls",
            tool_calls=(
                ToolCallRequest(
                    tool_id="read_file",
                    arguments={"path": "README.md"},
                    call_id=call_id,
                ),
            ),
        ),
        stream_chunks=(ThinkingDelta("weighing the read "),),
    )


def _iteration_starts(events: list[object]) -> list[IterationStartEvent]:
    return [event for event in events if isinstance(event, IterationStartEvent)]


def _phase_started_ids(events: list[object]) -> set[str]:
    return {
        event.phase_id
        for event in events
        if isinstance(event, PhaseStartedEvent) and event.phase_id
    }


def _thinking_ids(events: list[object]) -> set[str]:
    return {
        event.thinking_id
        for event in events
        if isinstance(event, PhaseStartedEvent) and event.thinking_id
    }


def test_approval_pause_records_absolute_completed_iteration() -> None:
    engine = _ToolLoopEngine(plans=[_ask_gated_tool_plan("call_pause_iter1")])
    router = _pausing_router(engine)

    decision = _run_decision(
        router,
        runtime=LoopRuntime(request_id=_REQUEST_ID, max_iterations=4, streaming=True),
    )

    assert decision.approval_plan is not None
    assert decision.approval_plan.completed_iterations == 1
    assert decision.approval_plan.remaining_iterations == 3


def test_resumed_loop_continues_numbering_and_phase_ids_stay_unique() -> None:
    # -- Pause: iteration 1 requests approval ------------------------------
    pause_engine = _ToolLoopEngine(plans=[_ask_gated_tool_plan("call_pause_boundary")])
    pause_router = _pausing_router(pause_engine)
    pause_events: list[object] = []

    pause_decision = _run_decision(
        pause_router,
        runtime=LoopRuntime(
            emit=pause_events.append,
            request_id=_REQUEST_ID,
            max_iterations=4,
            streaming=True,
        ),
    )
    plan = pause_decision.approval_plan
    assert plan is not None
    assert [event.iteration for event in _iteration_starts(pause_events)] == [1]

    # -- Resume: mirror ``chat_resume`` -- a fresh loop over the remaining
    # budget with ``iteration_base`` threaded from the paused plan ---------
    resume_engine = _ToolLoopEngine(
        plans=[
            _ToolPlan(
                result=GenerationResult(content="All done.", finish_reason="stop"),
                stream_chunks=(ThinkingDelta("resuming the plan "),),
            ),
        ]
    )
    resume_router = _pausing_router(resume_engine)
    resume_events: list[object] = []

    _run_decision(
        resume_router,
        runtime=LoopRuntime(
            emit=resume_events.append,
            request_id=_REQUEST_ID,
            max_iterations=plan.remaining_iterations,
            iteration_base=plan.completed_iterations,
            current_iteration=plan.completed_iterations,
            streaming=True,
        ),
    )

    resume_starts = _iteration_starts(resume_events)
    assert resume_starts, "resumed loop emitted no IterationStartEvent"
    # Numbering continues from the paused iteration; the displayed total is
    # the whole turn's budget, not the resumed remainder.
    assert resume_starts[0].iteration == plan.completed_iterations + 1 == 2
    assert resume_starts[0].max_iterations == (
        plan.completed_iterations + plan.remaining_iterations
    )

    # Reasoning phase/thinking identities must not collide across the
    # resume boundary (same request_id on both sides, as in a real resume).
    pause_phase_ids = _phase_started_ids(pause_events)
    resume_phase_ids = _phase_started_ids(resume_events)
    assert pause_phase_ids, "pause side emitted no PhaseStartedEvent"
    assert resume_phase_ids, "resume side emitted no PhaseStartedEvent"
    assert not (pause_phase_ids & resume_phase_ids)
    pause_thinking_ids = _thinking_ids(pause_events)
    resume_thinking_ids = _thinking_ids(resume_events)
    assert pause_thinking_ids, "pause side emitted no thinking ids"
    assert resume_thinking_ids, "resume side emitted no thinking ids"
    assert not (pause_thinking_ids & resume_thinking_ids)


def test_second_pause_in_resumed_loop_accumulates_completed_iterations() -> None:
    # A resumed loop that pauses AGAIN must record the absolute iteration so
    # a second resume keeps advancing instead of re-basing at the remainder.
    engine = _ToolLoopEngine(plans=[_ask_gated_tool_plan("call_second_pause")])
    router = _pausing_router(engine)

    decision = _run_decision(
        router,
        runtime=LoopRuntime(
            request_id=_REQUEST_ID,
            max_iterations=3,
            iteration_base=1,
            current_iteration=1,
            streaming=True,
        ),
    )

    plan = decision.approval_plan
    assert plan is not None
    # Paused on absolute iteration 2 (base 1 + first local iteration) with
    # 2 of the turn's 4 total iterations still unspent.
    assert plan.completed_iterations == 2
    assert plan.remaining_iterations == 2
