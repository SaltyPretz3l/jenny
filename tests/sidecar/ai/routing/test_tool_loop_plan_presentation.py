"""The tool loop asks a Plan Mode turn to present its plan through exit_plan_mode.

MQ-001: a prose plan used to finalize as an ordinary reply with no plan card.
MQ-024: a long investigation hit the working-time deadline without a plan.
"""

from __future__ import annotations

import time
from dataclasses import replace
from typing import Any

from sidecar.ai.mcp.models import MCPToolDescriptor
from sidecar.ai.routing.loop_events import StreamResetEvent
from sidecar.ai.routing.loop_runtime import LoopRuntime
from sidecar.ai.routing.plan_presentation import PLAN_PROSE_NUDGE
from sidecar.ai.tools.models import GenerationResult, ToolCallRequest
from sidecar.runtime.chat_models import ChatRequestContext
from tests.sidecar.ai.routing.test_tool_loop import (
    _build_router,
    _StubMCPClient,
    _ToolLoopEngine,
    _ToolPlan,
)

_PROSE_PLAN = "Plan: create an empty hello.txt in the workspace root, then confirm it exists."
_DEADLINE_MARKER = "close to its"


def _descriptor(name: str) -> MCPToolDescriptor:
    return MCPToolDescriptor(
        name=name,
        description=f"{name} stub.",
        input_schema={"type": "object", "properties": {}},
        side_effecting=False,
        server_name="stub",
    )


def _reply(content: str) -> _ToolPlan:
    return _ToolPlan(result=GenerationResult(content=content, finish_reason="stop"))


def _call(tool_id: str, call_id: str, **arguments: Any) -> _ToolPlan:
    return _ToolPlan(
        result=GenerationResult(
            content="",
            tool_calls=(ToolCallRequest(tool_id=tool_id, arguments=arguments, call_id=call_id),),
            finish_reason="tool_calls",
        )
    )


def _exit_plan_mode() -> _ToolPlan:
    return _call(
        "exit_plan_mode",
        "call_exit",
        title="Create hello.txt",
        steps=["Create an empty hello.txt", "Confirm it exists"],
    )


def _read() -> _ToolPlan:
    return _call("read_file", "call_read", path="notes.md")


class _ClockedEngine(_ToolLoopEngine):
    """Moves a fake clock to *after_first* once the first generation returns."""

    def __init__(self, plans: list[_ToolPlan], clock: list[float], after_first: float) -> None:
        super().__init__(plans)
        self._clock = clock
        self._after_first = after_first

    def _next_plan(self) -> _ToolPlan:
        plan = super()._next_plan()
        self._clock[0] = self._after_first
        return plan


def _run_turn(
    plans: list[_ToolPlan],
    *,
    plan_mode: bool = True,
    max_iterations: int = 12,
    remaining_after_first: float | None = None,
) -> tuple[_ToolLoopEngine, Any, list[Any]]:
    start = time.monotonic()
    clock = [start]
    engine: _ToolLoopEngine = (
        _ToolLoopEngine(plans)
        if remaining_after_first is None
        else _ClockedEngine(plans, clock, start + 1_500.0 - remaining_after_first)
    )
    router = _build_router(
        engine=engine,
        mcp_client=_StubMCPClient(
            tuple(_descriptor(name) for name in ("read_file", "exit_plan_mode", "ask_user"))
        ),
        max_tools_per_turn=64,
        extra_snapshot_tools=("exit_plan_mode", "ask_user"),
    )
    router._config = replace(router._config, max_tokens=4096)
    context = ChatRequestContext(
        request_id="req_plan_presentation",
        trace_id="trace_plan_presentation",
        session_id="session_plan_presentation",
        mode="assist",
        approvals_pre_granted=False,
        workspace_root_present=True,
        plan_mode=plan_mode,
        read_only=plan_mode,
    )
    events: list[Any] = []
    decision = router.build_chat_decision(
        request_id=context.request_id,
        messages=[{"role": "user", "content": "I only need to see your plan card."}],
        latest_user_content="I only need to see your plan card.",
        mode="assist",
        approvals_pre_granted=False,
        request_context=context,
        runtime=LoopRuntime(
            emit=events.append,
            request_id=context.request_id,
            request_context=context,
            max_iterations=max_iterations,
            streaming=True,
            clock=lambda: clock[0],
            wall_clock_deadline=start + 1_500.0,
        ),
    )
    return engine, decision, events


def _tool_names(request: dict[str, Any]) -> set[str]:
    names = set()
    for schema in request.get("tools") or []:
        function = schema.get("function") if isinstance(schema.get("function"), dict) else schema
        names.add(str(function.get("name")))
    return names


def _rows_containing(request: dict[str, Any], marker: str) -> list[dict[str, Any]]:
    # Local engine builders demote non-leading system rows to the user tier.
    return [
        message
        for message in request["messages"]
        if message.get("role") in {"system", "user"} and marker in str(message.get("content"))
    ]


def _approval_tool(decision: Any) -> str | None:
    request = getattr(decision, "approval_request", None)
    return None if request is None else request.tool_name


def test_plan_mode_prose_plan_gets_one_exit_plan_mode_nudge() -> None:
    engine, decision, events = _run_turn([_reply(_PROSE_PLAN), _exit_plan_mode()])

    assert len(engine.requests) == 2
    second = engine.requests[1]["messages"]
    assert second[-1]["content"] == PLAN_PROSE_NUDGE
    assert second[-2] == {"role": "assistant", "content": _PROSE_PLAN}
    assert any(
        isinstance(event, StreamResetEvent) and event.reason == "post_tool_restart"
        for event in events
    )
    assert _approval_tool(decision) == "exit_plan_mode"


def test_prose_nudge_fires_at_most_once() -> None:
    engine, decision, _events = _run_turn([_reply(_PROSE_PLAN), _reply(_PROSE_PLAN)])

    assert len(engine.requests) == 2
    assert decision.response_text == _PROSE_PLAN
    assert _approval_tool(decision) is None


def test_no_prose_nudge_outside_plan_mode() -> None:
    engine, decision, _events = _run_turn([_reply(_PROSE_PLAN)], plan_mode=False)

    assert len(engine.requests) == 1
    assert decision.response_text == _PROSE_PLAN


def test_no_prose_nudge_for_a_question() -> None:
    question = "Plan: create hello.txt. Should it go in the workspace root?"
    engine, decision, _events = _run_turn([_reply(question)])

    assert len(engine.requests) == 1
    assert decision.response_text == question


def test_no_prose_nudge_for_an_ordinary_answer() -> None:
    answer = "The workspace has no hello.txt yet."
    engine, decision, _events = _run_turn([_reply(answer)])

    assert len(engine.requests) == 1
    assert decision.response_text == answer


def test_plan_mode_near_deadline_offers_only_exit_plan_mode() -> None:
    engine, decision, _events = _run_turn(
        [_read(), _exit_plan_mode()], remaining_after_first=300.0
    )

    assert len(engine.requests) == 2
    assert "read_file" in _tool_names(engine.requests[0])
    assert _rows_containing(engine.requests[0], _DEADLINE_MARKER) == []
    assert _tool_names(engine.requests[1]) == {"exit_plan_mode", "ask_user"}
    rows = _rows_containing(engine.requests[1], "close to its working-time limit")
    assert len(rows) == 1
    assert _approval_tool(decision) == "exit_plan_mode"


def test_last_step_in_plan_mode_offers_only_exit_plan_mode() -> None:
    engine, decision, _events = _run_turn([_read(), _exit_plan_mode()], max_iterations=2)

    assert len(engine.requests) == 2
    assert "read_file" in _tool_names(engine.requests[0])
    assert _tool_names(engine.requests[1]) == {"exit_plan_mode", "ask_user"}
    assert len(_rows_containing(engine.requests[1], "close to its step limit")) == 1
    assert _approval_tool(decision) == "exit_plan_mode"


def test_deadline_gate_lasts_one_step() -> None:
    engine, _decision, _events = _run_turn(
        [_read(), _call("ask_user", "call_ask", question="Which folder?"), _exit_plan_mode()],
        remaining_after_first=300.0,
    )

    assert len(engine.requests) == 3
    assert _tool_names(engine.requests[1]) == {"exit_plan_mode", "ask_user"}
    assert "read_file" in _tool_names(engine.requests[2])
    assert len(_rows_containing(engine.requests[2], _DEADLINE_MARKER)) == 1


def test_no_deadline_gate_outside_plan_mode() -> None:
    engine, _decision, _events = _run_turn(
        [_read(), _reply("Done.")], plan_mode=False, remaining_after_first=300.0
    )

    assert len(engine.requests) == 2
    assert "read_file" in _tool_names(engine.requests[1])
    assert _rows_containing(engine.requests[1], _DEADLINE_MARKER) == []
