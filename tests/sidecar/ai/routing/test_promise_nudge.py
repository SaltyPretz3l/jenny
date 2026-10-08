"""A final reply that only promises the work gets one "do it now" nudge (Relay Drift)."""

from __future__ import annotations

from dataclasses import replace
from types import SimpleNamespace
from typing import Any

import pytest

from sidecar.ai.mcp.models import MCPToolDescriptor
from sidecar.ai.routing.loop_events import StreamResetEvent
from sidecar.ai.routing.loop_runtime import LoopRuntime
from sidecar.ai.routing.promise_nudge import (
    PROMISE_NUDGE,
    PROMISE_NUDGE_FLAG,
    _nudged_this_turn,
    looks_like_promise,
)
from sidecar.ai.tools.models import GenerationResult, ToolCallRequest
from sidecar.runtime.chat_models import ChatRequestContext
from tests.sidecar.ai.routing.test_tool_loop import (
    _build_router,
    _StubMCPClient,
    _ToolLoopEngine,
    _ToolPlan,
)

_PROMISE = "I read the brief. I'll create the game first, then add the tests."


@pytest.mark.parametrize(
    "reply",
    [
        _PROMISE,
        "Let me now write index.html with the board.",
        "The folder is empty.\n\nNext, I will scaffold the project.",
        "I’m going to build the level loader.",
    ],
)
def test_a_promise_of_an_action_reads_as_a_promise(reply: str) -> None:
    assert looks_like_promise(reply)


@pytest.mark.parametrize(
    "reply",
    [
        "I'll create the game. Which framework do you want?",
        "Done: index.html is saved. If you want, I'll add sound next.",
        "I'll write the file once you approve the plan.",
        "I can't write there: the folder is read-only, so I'll stop here.",
        "I'll create the game first.\n\nThe brief is all set; nothing else to do.",
        "The game is finished and the tests pass.",
        'Use this sentence: "I will write the file tomorrow."',
        "Example:\n\n```\nI'll create the file.\n```",
        "I cannot access the project until you mount it.\n\nI will create the files once it is there.",
    ],
)
def test_questions_offers_blockers_and_reports_are_not_promises(reply: str) -> None:
    assert not looks_like_promise(reply)


def test_an_approval_resume_remembers_the_nudge_from_this_turn() -> None:
    def loop(rows: list[dict[str, Any]]) -> SimpleNamespace:
        return SimpleNamespace(latest_user_content="Build it.", working_messages=rows)

    this_turn = [
        {"role": "user", "content": "Build it."},
        {"role": "assistant", "content": _PROMISE},
        {"role": "user", "content": PROMISE_NUDGE},
    ]
    earlier_turn = [
        {"role": "user", "content": "Old request."},
        {"role": "user", "content": PROMISE_NUDGE},
        {"role": "user", "content": "Build it."},
    ]
    assert _nudged_this_turn(loop(this_turn))
    assert not _nudged_this_turn(loop(earlier_turn))


def _descriptor(name: str, *, side_effecting: bool) -> MCPToolDescriptor:
    return MCPToolDescriptor(
        name=name,
        description=f"{name} stub.",
        input_schema={"type": "object", "properties": {}},
        side_effecting=side_effecting,
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


def _run_turn(plans: list[_ToolPlan], *, read_only: bool = False) -> tuple[Any, Any, list[Any]]:
    engine = _ToolLoopEngine(plans)
    router = _build_router(
        engine=engine,
        mcp_client=_StubMCPClient(
            (
                _descriptor("read_file", side_effecting=False),
                _descriptor("write_file", side_effecting=True),
            )
        ),
        max_tools_per_turn=64,
    )
    router._config = replace(router._config, max_tokens=4096)
    context = ChatRequestContext(
        request_id="req_promise",
        trace_id="trace_promise",
        session_id="session_promise",
        mode="assist",
        approvals_pre_granted=True,
        workspace_root_present=True,
        read_only=read_only,
    )
    events: list[Any] = []
    decision = router.build_chat_decision(
        request_id=context.request_id,
        messages=[{"role": "user", "content": "Build the puzzle game in the brief."}],
        latest_user_content="Build the puzzle game in the brief.",
        mode="assist",
        approvals_pre_granted=True,
        request_context=context,
        runtime=LoopRuntime(
            emit=events.append,
            request_id=context.request_id,
            request_context=context,
            max_iterations=8,
            streaming=True,
        ),
    )
    return engine, decision, events


def test_a_promise_after_only_reads_gets_one_nudge() -> None:
    engine, decision, events = _run_turn(
        [_call("read_file", "c1", path="brief.md"), _reply(_PROMISE), _reply("Blocked: none.")]
    )

    assert len(engine.requests) == 3
    third = engine.requests[2]["messages"]
    assert third[-1]["content"] == PROMISE_NUDGE
    assert third[-2] == {"role": "assistant", "content": _PROMISE}
    assert any(
        isinstance(event, StreamResetEvent) and event.reason == "nudge_retry"
        for event in events
    )
    assert decision.response_text == "Blocked: none."


def test_the_nudge_fires_at_most_once() -> None:
    engine, decision, _events = _run_turn([_reply(_PROMISE), _reply(_PROMISE)])

    assert len(engine.requests) == 2
    assert decision.response_text == _PROMISE


def test_no_nudge_after_the_turn_wrote_a_file() -> None:
    engine, decision, _events = _run_turn(
        [_call("write_file", "c1", path="index.html", content="<html></html>"), _reply(_PROMISE)]
    )

    assert len(engine.requests) == 2
    assert decision.response_text == _PROMISE


def test_no_nudge_in_a_read_only_turn() -> None:
    engine, _decision, _events = _run_turn([_reply(_PROMISE)], read_only=True)

    assert len(engine.requests) == 1


def test_the_kill_switch_disables_the_nudge(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(PROMISE_NUDGE_FLAG, "0")
    engine, _decision, _events = _run_turn([_reply(_PROMISE)])

    assert len(engine.requests) == 1
