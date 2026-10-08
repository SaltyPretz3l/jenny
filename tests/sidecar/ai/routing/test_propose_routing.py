"""Propose mode routing: live-suggestion injection, the no-suggestion nudge, request context."""

from __future__ import annotations

from dataclasses import replace
from types import SimpleNamespace
from typing import Any

import pytest

from sidecar.ai.config import RuntimeConfig
from sidecar.ai.routing.loop_events import StreamResetEvent
from sidecar.ai.routing.loop_runtime import LoopRuntime
from sidecar.ai.routing.propose_live_suggestions import (
    LIVE_SUGGESTIONS_ARG as ROUTING_LIVE_SUGGESTIONS_ARG,
)
from sidecar.ai.routing.propose_live_suggestions import build_live_suggestions
from sidecar.ai.routing.propose_presentation import PROPOSE_NUDGE, final_propose_nudge
from sidecar.ai.routing.router import ChatDecision, ToolExecutionOutcome
from sidecar.ai.routing.tool_execution_snapshots import freeze_effective_execution_inputs
from sidecar.ai.tools.builtins.propose_suggestion import LIVE_SUGGESTIONS_ARG
from sidecar.ai.tools.models import GenerationResult, ToolCallRequest
from sidecar.runtime.approval_plan import SIDECAR_INJECTED_ARG_KEYS

_NOW = 10_000.0


def _suggestion_outcome(call_id: str, path: str, *, revises: str | None = None,
                        success: bool = True) -> ToolExecutionOutcome:
    record = {"schema_version": 1, "path": path, "kind": "replace",
              "old_string": f"old {call_id}", "revises": revises}
    return ToolExecutionOutcome(
        tool_name="propose_change", output="ok", success=success,
        metadata={"suggested_change": record} if success else {}, call_id=call_id,
    )


def test_live_suggestions_merge_session_context_with_this_requests_calls() -> None:
    session = (
        {"id": "sg_a", "path": "app.py", "kind": "replace", "old_string": "a"},
        {"id": "sg_b", "path": "lib.py", "kind": "replace", "old_string": "b"},
    )
    outcomes = [
        _suggestion_outcome("call_1", "app.py", revises="sg_a"),
        _suggestion_outcome("call_2", "util.py"),
        _suggestion_outcome("call_3", "util.py", success=False),
        ToolExecutionOutcome(tool_name="read_file", output="x", success=True, call_id="r1"),
    ]

    payload = build_live_suggestions(session, outcomes)

    ids = [entry["id"] for entry in payload["live"]]
    # call_1 revises sg_a and keeps its id; call_2 is new and goes by its call id.
    assert ids == ["sg_b", "sg_a", "call_2"]
    assert payload["request_count"] == 2
    assert payload["request_paths"] == ["app.py", "util.py"]


def test_freeze_injects_private_live_suggestions_only_for_propose_change() -> None:
    kernel = SimpleNamespace(_config=SimpleNamespace(tools_workspace_root=None), _mcp_client=None)
    session = ({"id": "sg_a", "path": "app.py", "kind": "replace", "old_string": "a"},)
    forged = {"live": [], "request_count": 0, "request_paths": []}

    frozen = freeze_effective_execution_inputs(
        kernel,
        ToolCallRequest(
            tool_id="propose_change",
            arguments={"path": "app.py", "kind": "replace", LIVE_SUGGESTIONS_ARG: forged},
            call_id="c1",
        ),
        session_id="s1",
        read_snapshot_cache={},
        request_context=SimpleNamespace(suggested_changes_context=session),
        request_outcomes=(_suggestion_outcome("call_0", "app.py"),),
    )
    other = freeze_effective_execution_inputs(
        kernel,
        ToolCallRequest(tool_id="read_file", arguments={"path": "app.py"}, call_id="c2"),
        session_id="s1",
        read_snapshot_cache={},
        request_context=SimpleNamespace(suggested_changes_context=session),
    )

    injected = frozen.effective_tool_arguments[LIVE_SUGGESTIONS_ARG]
    assert [entry["id"] for entry in injected["live"]] == ["sg_a", "call_0"]
    assert injected["request_count"] == 1
    assert LIVE_SUGGESTIONS_ARG not in frozen.visible_tool_arguments
    assert LIVE_SUGGESTIONS_ARG in frozen.injected_arg_keys
    assert LIVE_SUGGESTIONS_ARG in SIDECAR_INJECTED_ARG_KEYS
    assert LIVE_SUGGESTIONS_ARG not in other.effective_tool_arguments
    assert ROUTING_LIVE_SUGGESTIONS_ARG == LIVE_SUGGESTIONS_ARG


def _loop(*, tool_calls_left: int = 10, **overrides: Any) -> SimpleNamespace:
    events: list[Any] = []
    runtime = LoopRuntime(
        emit=events.append, request_id="req_propose", streaming=True, clock=lambda: _NOW,
        wall_clock_deadline=_NOW + 1_000, tool_call_limit=20,
        tool_calls_consumed=20 - tool_calls_left,
    )
    values: dict[str, Any] = {
        "plan_mode": False,
        "read_only": True,
        "is_sub_agent_request": False,
        "request_context": SimpleNamespace(propose_mode=True),
        "tool_contract": SimpleNamespace(available_names=("read_file", "propose_change")),
        "outcomes": [],
        "runtime": runtime,
        "kernel": SimpleNamespace(_config=replace(RuntimeConfig(engine_type="ollama", model="q"))),
        "iteration_total": 30,
        "loop_cap": SimpleNamespace(pending_extension=lambda: 0),
        "working_messages": [{"role": "user", "content": "Make the greeting friendlier."}],
        "latest_user_content": "Make the greeting friendlier.",
        "streamed_event_types": {"chat.token"},
        "request_id": "req_propose",
        "session_id": "session_propose",
        "_is_continuable_checkpoint": lambda _result: False,
        "events": events,
    }
    values.update(overrides)
    return SimpleNamespace(**values)


_PROSE = "I would change greet() to say hello and update the caller in main.py."


def _reply(content: str = _PROSE, **fields: Any) -> GenerationResult:
    return GenerationResult(content=content, **({"finish_reason": "stop"} | fields))


def test_prose_without_a_recorded_suggestion_gets_one_nudge() -> None:
    loop = _loop()

    assert final_propose_nudge(loop, _reply(), 2) is True
    assert loop.working_messages[-2] == {"role": "assistant", "content": _PROSE}
    assert loop.working_messages[-1] == {"role": "user", "content": PROPOSE_NUDGE}
    assert PROPOSE_NUDGE.startswith("No suggested change was recorded. Call propose_change")
    assert [type(event) for event in loop.events] == [StreamResetEvent]
    # The fold names the real cause: a tool the draft skipped, not the tools (2026-10-05 recheck).
    assert loop.events[0].reason == "nudge_retry"
    assert final_propose_nudge(loop, _reply(), 3) is False


@pytest.mark.parametrize(
    "overrides",
    [
        {"request_context": SimpleNamespace(propose_mode=False)},
        {"is_sub_agent_request": True},
        {"tool_contract": SimpleNamespace(available_names=("read_file",))},
        {"outcomes": [_suggestion_outcome("c1", "app.py")]},
        {"tool_calls_left": 0},
    ],
    ids=["not_propose", "sub_agent", "tool_unavailable", "already_recorded", "budget_spent"],
)
def test_no_nudge(overrides: dict[str, Any]) -> None:
    assert final_propose_nudge(_loop(**overrides), _reply(), 2) is False


def test_no_nudge_for_a_question_or_a_cut_off_reply() -> None:
    assert final_propose_nudge(_loop(), _reply("Which file holds the greeting?"), 2) is False
    assert final_propose_nudge(_loop(), _reply(finish_reason="length"), 2) is False


def test_nudge_honours_the_presentation_kill_switch(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("JENNY_ENABLE_PLAN_PRESENTATION_ASSIST", "0")

    assert final_propose_nudge(_loop(), _reply(), 2) is False


def test_chat_send_propose_mode_is_read_only_with_capped_effort_and_live_context() -> None:
    from sidecar.runtime.chat import build_chat_send_response
    from tests.sidecar.runtime.test_chat import _build_brain_container

    decision = ChatDecision(thinking_text=None, response_text="Ready.", approval_request=None,
                            tool_results=())
    brain_container = _build_brain_container(decision)
    live = {"id": "sg_1", "path": "app.py", "kind": "replace", "old_string": "x"}

    build_chat_send_response(
        "msg-propose",
        {
            "request_id": "req-propose",
            "messages": [{"role": "user", "content": "Suggest a change"}],
            "propose_mode": True,
            "reasoning_effort": "high",
            "suggested_changes_context": {"schema_version": 1, "live": [live]},
        },
        approvals_pre_granted=False,
        brain_container=brain_container,
        invalid_params_code=-32602,
    )

    context = brain_container.stack.router.last_kwargs["request_context"]
    assert context.propose_mode is True
    assert context.read_only is True
    assert context.plan_mode is False
    assert context.reasoning_effort == "medium"
    assert context.suggested_changes_context == (live,)


def test_a_revision_keeps_the_revised_id_so_a_second_revise_names_it_again() -> None:
    session = ({"id": "sg_a", "path": "app.py", "kind": "replace", "old_string": "a"},)
    outcomes = [
        _suggestion_outcome("call_1", "app.py", revises="sg_a"),
        _suggestion_outcome("call_2", "app.py", revises="sg_a"),
    ]

    payload = build_live_suggestions(session, outcomes)

    assert [entry["id"] for entry in payload["live"]] == ["sg_a"]
    assert payload["live"][0]["old_string"] == "old call_2"
