"""Behavioral counts for the row-60 prompt heuristic instrumentation."""

from dataclasses import replace
from types import SimpleNamespace
from typing import Any

import pytest

from sidecar.ai.routing.heuristic_fires import emit_continuation_relevance, emit_heuristic_fire
from sidecar.ai.routing.loop_events import HeuristicFireEvent
from sidecar.ai.routing.loop_runtime import LoopRuntime
from sidecar.ai.routing.plan_presentation import final_prose_nudge
from sidecar.ai.routing.propose_presentation import final_propose_nudge
from sidecar.ai.routing.tool_budget_filter import apply_budget_aware_tool_filter
from sidecar.ai.routing.tool_loop_calls import _ToolCallPhasesMixin
from sidecar.ai.tools.models import GenerationResult, ToolCallRequest
from sidecar.runtime.chat_models import ChatRequestContext
from tests.sidecar.ai.routing.test_plan_presentation import _loop, _reply
from tests.sidecar.ai.routing.test_promise_nudge import _PROMISE, _descriptor, _run_turn
from tests.sidecar.ai.routing.test_promise_nudge import _reply as promise_reply
from tests.sidecar.ai.routing.test_propose_routing import _loop as propose_loop
from tests.sidecar.ai.routing.test_tool_budget_filter_probe_parity import (
    _filter_input,
    _force_budget_pressure,
    _incident_tool_contract,
    _IncidentFilterKernel,
)
from tests.sidecar.ai.routing.test_tool_loop import (
    _build_router,
    _mermaid_descriptor,
    _StubMCPClient,
    _ToolLoopEngine,
    _ToolPlan,
)
from tests.sidecar.ai.routing.test_tool_loop_write_progress import (
    _APPROVED_PLAN,
    READS_WITHOUT_WRITE_LIMIT,
    _read_plans,
)


def fires(events: list[Any], name: str) -> list[Any]:
    return [event for event in events if isinstance(event, HeuristicFireEvent) and event.name == name]


@pytest.mark.parametrize("reply, expected", [(_PROMISE, 1), ("All done.", 0)])
def test_promise_fire(reply: str, expected: int) -> None:
    _, _, events = _run_turn([promise_reply(reply), promise_reply("All done.")])
    assert len(fires(events, "promise_nudge")) == expected


@pytest.mark.parametrize("reply, expected", [("Plan: edit the config.", 1), ("All done.", 0)])
def test_plan_prose_fire(reply: str, expected: int) -> None:
    loop = _loop()
    assert final_prose_nudge(loop, _reply(reply), 1) == bool(expected)
    assert len(fires(loop.events, "plan_prose_nudge")) == expected


@pytest.mark.parametrize("reply, expected", [("I would edit greet().", 1), ("Which file?", 0)])
def test_propose_fire(reply: str, expected: int) -> None:
    loop = propose_loop()
    assert final_propose_nudge(loop, _reply(reply), 1) == bool(expected)
    assert len(fires(loop.events, "propose_nudge")) == expected
    final_propose_nudge(loop, _reply(reply), 2)
    assert len(fires(loop.events, "propose_nudge")) == expected


def _call(name: str = "mermaid_generate", index: int = 0) -> _ToolPlan:
    return _ToolPlan(result=GenerationResult(
        content="", finish_reason="tool_calls", tool_calls=(ToolCallRequest(
            tool_id=name, arguments={"path": f"file_{index}.py", "prompt": "flowchart TD\n A-->B"},
            call_id=f"call_{index}",
        ),),
    ))


def _turn(plans: list[_ToolPlan], **options: Any) -> tuple[Any, list[Any], Any]:
    """Use the existing router/engine harness through build_chat_decision."""
    engine = _ToolLoopEngine(plans)
    router = _build_router(
        engine=engine, tools_mermaid_enabled=True,
        max_tools_per_turn=options.get("tool_limit", 64),
        mcp_client=_StubMCPClient((
            _mermaid_descriptor(), _descriptor("read_file", side_effecting=False),
            _descriptor("edit_file", side_effecting=True),
            _descriptor("glob_files", side_effecting=False),
        ), success=options.get("success", True)),
    )
    router._config = replace(router._config, max_tokens=4096)
    query = options.get("query", "Help with the project.")
    context = ChatRequestContext(
        request_id="req-fires", trace_id=None, session_id="session-fires", mode="assist",
        workspace_root_present=True, approvals_pre_granted=True,
        approved_plan=options.get("approved_plan"),
    )
    events: list[Any] = []
    decision = router.build_chat_decision(
        request_id=context.request_id, messages=[{"role": "user", "content": query}],
        latest_user_content=query, mode="assist", approvals_pre_granted=True,
        request_context=context, runtime=LoopRuntime(
            emit=events.append, request_id=context.request_id, request_context=context,
            max_iterations=options.get("iterations", 8), streaming=True,
        ),
    )
    return decision, events, engine


@pytest.mark.parametrize("bad_reply, trigger", [
    ("I don't have any previous context or tool results to work with.", "ignored_failure_context"),
    ("Hi! I'm Jenny, your AI companion. How can I help today?", "invalid_restart:generic_greeting"),
])
def test_post_tool_recovery_retry_and_fallback(bad_reply: str, trigger: str) -> None:
    decision, events, _ = _turn(
        [_call(), promise_reply(bad_reply), promise_reply(bad_reply)],
        success=trigger != "ignored_failure_context",
    )
    assert [event.detail for event in fires(events, "post_tool_recovery")] == [
        {"trigger": trigger, "action": "retry"}, {"trigger": trigger, "action": "fallback"},
    ]
    assert decision.completion_source == "deterministic_tool_fallback"


def test_post_tool_recovery_control() -> None:
    _, events, _ = _turn([_call(), promise_reply("The diagram is ready.")])
    assert fires(events, "post_tool_recovery") == []


@pytest.mark.parametrize("fake_reply, canned", [
    ("Let me use web search to check the weather in Nashville.", 1),
    ("I cannot perform a live lookup.", 0),
])
def test_current_info_fires(fake_reply: str, canned: int) -> None:
    _, events, _ = _turn(
        [promise_reply(fake_reply)], query="What is the weather in Nashville today?",
    )
    assert len(fires(events, "current_info_context_row")) == 1
    assert len(fires(events, "current_info_canned_reply")) == canned


def test_current_info_control() -> None:
    _, events, _ = _turn([promise_reply("All done.")])
    assert fires(events, "current_info_context_row") == []
    assert fires(events, "current_info_canned_reply") == []


@pytest.mark.parametrize("query, reply, trigger", [
    ("Please use glob_files to find Markdown.", "I can answer directly.", "explicit_tool_request"),
    ("Help with the project.", "Let me use glob files to inspect the workspace.", "fake_tool_use"),
])
def test_tool_use_retry_and_fallback(query: str, reply: str, trigger: str) -> None:
    _, events, _ = _turn([promise_reply(reply), promise_reply(reply)], query=query)
    assert [event.detail for event in fires(events, "tool_use_nudge")] == [
        {"trigger": trigger, "action": "retry"}, {"trigger": trigger, "action": "fallback"},
    ]


def test_tool_use_control() -> None:
    _, events, _ = _turn([promise_reply("All done.")])
    assert fires(events, "tool_use_nudge") == []


@pytest.mark.parametrize("count, expected", [(READS_WITHOUT_WRITE_LIMIT, 1), (2, 0)])
def test_write_progress_fire(count: int, expected: int) -> None:
    _, events, _ = _turn(_read_plans(count), approved_plan=_APPROVED_PLAN)
    emitted = fires(events, "write_progress_nudge")
    assert len(emitted) == expected
    if emitted:
        assert emitted[0].detail == {"rung": 0}


@pytest.mark.parametrize("limit, expected", [(1, 1), (64, 0)])
def test_tool_budget_fire(limit: int, expected: int) -> None:
    _, events, _ = _turn([_call(), promise_reply("Diagram ready.")], tool_limit=limit)
    assert len(fires(events, "tool_budget_exhausted_row")) == expected


@pytest.mark.parametrize("tool_steps, expected", [(3, 1), (0, 0)])
def test_wind_down_fire(tool_steps: int, expected: int) -> None:
    _, events, _ = _turn(
        [*(_call("read_file", i) for i in range(tool_steps)), promise_reply("All done.")],
        iterations=4,
    )
    assert len(fires(events, "wind_down_row")) == expected


def test_cycle_hint_fire() -> None:
    events: list[Any] = []
    loop = SimpleNamespace(
        runtime=LoopRuntime(emit=events.append), working_messages=[],
        tool_resolution_context=None, request_id="req-cycle", session_id="session-cycle",
        streamed_event_types=set(),
    )
    reason = SimpleNamespace(code="CMP-LOOP-0003", user_hint="Try another approach.")
    _ToolCallPhasesMixin._apply_cycle_hint(loop, reason, 2, reset_visible_text=False)
    assert loop.working_messages == [{"role": "system", "content": reason.user_hint}]
    assert [event.detail for event in fires(events, "loop_cycle_hint")] == [{"code": reason.code}]
    _, control, _ = _turn([promise_reply("All done.")])
    assert fires(control, "loop_cycle_hint") == []


@pytest.mark.parametrize("latest, history, plan, enabled, expected", [
    ("continue", "Fix the parser.", None, True, 1),
    ("continue", "", None, True, 0),
    ("Fix another file.", "Fix the parser.", None, True, 0),
    ("continue", "Fix the parser.", {"title": "Approved"}, True, 0),
    ("continue", "Fix the parser.", None, False, 0),
])
def test_continuation_relevance_fire(  # noqa: PLR0913 - parameterized filter truth table.
    monkeypatch: pytest.MonkeyPatch, latest: str, history: str,
    plan: dict[str, str] | None, enabled: bool, expected: int,
) -> None:
    _force_budget_pressure(monkeypatch)
    base = _filter_input(_IncidentFilterKernel())
    context = replace(
        base, latest_user_content=latest,
        semantic_history=[{"role": "user", "content": history}],
        request_context=replace(base.request_context, approved_plan=plan),
        tool_search_enabled=enabled,
    )
    contract = _incident_tool_contract()
    apply_budget_aware_tool_filter(
        context, tool_contract=contract, tool_payload=list(contract.prompt_schemas),
        tool_statuses=contract.status_entries,
    )
    events: list[Any] = []
    loop = SimpleNamespace(
        runtime=LoopRuntime(emit=events.append), request_context=context.request_context,
        tool_resolution_context=context.tool_resolution_context, latest_user_content=latest,
        working_messages=context.semantic_history,
    )
    emit_continuation_relevance(loop)
    assert len(fires(events, "continuation_relevance")) == expected


def test_emission_failure_does_not_change_the_nudge() -> None:
    loop = _loop()

    def broken_emit(event: Any) -> None:
        if isinstance(event, HeuristicFireEvent):
            raise RuntimeError("broken diagnostic sink")

    loop.runtime.emit = broken_emit
    assert final_prose_nudge(loop, _reply("Plan: edit the config."), 1)
    assert len(loop.working_messages) == 3


def test_helper_preserves_scalar_details() -> None:
    events: list[Any] = []
    emit_heuristic_fire(LoopRuntime(emit=events.append), "test", rung=2, active=True)
    assert [event.detail for event in fires(events, "test")] == [{"rung": 2, "active": True}]
