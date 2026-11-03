"""An empty post-tool completion with todo items still open continues instead of winding down.

2026-10-31: a 7-item todo list had pending items, the model emitted an empty
completion after a tool batch, and the tools-stripped wind-down ended the turn
("good checkpoint to report"); the user had to type "go".
"""

from __future__ import annotations

import json
import logging
import sys
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_tool_loop import (  # shared loop harness.
    _build_router,
    _StubMCPClient,
    _ToolLoopEngine,
    _ToolPlan,
)

from sidecar.ai.mcp.models import MCPToolDescriptor
from sidecar.ai.routing.loop_runtime import LoopRuntime
from sidecar.ai.routing.pending_todos import pending_todo_items
from sidecar.ai.routing.router import ToolExecutionOutcome
from sidecar.ai.tools.models import GenerationResult, ToolCallRequest

_PENDING = [
    {"content": "Write the parser", "status": "completed"},
    {"content": "Wire the parser into the CLI", "status": "in_progress"},
    {"content": "Add tests", "status": "pending"},
]


def _todo_outcome(output: str, *, success: bool = True) -> ToolExecutionOutcome:
    return ToolExecutionOutcome(tool_name="todo_write", output=output, success=success)


def _todos(items: list[dict[str, str]]) -> str:
    return json.dumps({"count": len(items), "todos": items})


# -- pending_todo_items --------------------------------------------------------


def test_pending_items_come_from_the_latest_todo_write() -> None:
    outcomes = [
        _todo_outcome(_todos(_PENDING)),
        ToolExecutionOutcome(tool_name="read_file", output="x", success=True),
    ]

    assert pending_todo_items(outcomes) == ["Wire the parser into the CLI", "Add tests"]


def test_a_cleared_list_or_a_later_all_complete_write_has_nothing_pending() -> None:
    cleared = json.dumps({"cleared": True, "reason": "all items completed", "count": 0})

    assert pending_todo_items([_todo_outcome(cleared)]) == []
    assert pending_todo_items([_todo_outcome(_todos(_PENDING)), _todo_outcome(cleared)]) == []


def test_a_failed_todo_write_falls_back_to_the_previous_list() -> None:
    outcomes = [_todo_outcome(_todos(_PENDING)), _todo_outcome("Tool failed", success=False)]

    assert pending_todo_items(outcomes) == ["Wire the parser into the CLI", "Add tests"]


def test_malformed_results_and_no_todo_write_have_nothing_pending() -> None:
    for output in ("not json", "[]", json.dumps({"todos": "nope"}), json.dumps({"todos": [1]})):
        assert pending_todo_items([_todo_outcome(output)]) == []
    assert pending_todo_items([]) == []
    assert pending_todo_items([SimpleNamespace(tool_name="todo_write")]) == []


# -- the loop -------------------------------------------------------------------


class _TodoClient(_StubMCPClient):
    def __init__(self, todo_output: str) -> None:
        super().__init__(
            (
                MCPToolDescriptor(
                    name="todo_write",
                    description="Replace the todo list.",
                    input_schema={"type": "object", "additionalProperties": True},
                    side_effecting=False,
                    server_name="stub",
                ),
            )
        )
        self._todo_output = todo_output

    def execute_tool(self, tool_name, arguments, *, timeout_seconds=None, cancel_handle=None):
        result = super().execute_tool(
            tool_name, arguments, timeout_seconds=timeout_seconds, cancel_handle=cancel_handle
        )
        return SimpleNamespace(**{**vars(result), "output": self._todo_output})


def _run(todo_output: str, plans: list[_ToolPlan], *, max_iterations: int = 5):
    engine = _ToolLoopEngine(
        plans=[
            _ToolPlan(
                result=GenerationResult(
                    content="",
                    finish_reason="tool_calls",
                    tool_calls=(
                        ToolCallRequest(
                            tool_id="todo_write",
                            arguments={"todos": _PENDING},
                            call_id="call_todo",
                        ),
                    ),
                )
            ),
            *plans,
        ]
    )
    router = _build_router(
        engine=engine, mcp_client=_TodoClient(todo_output), extra_snapshot_tools=("todo_write",)
    )
    router._config = replace(router._config, tools_todo_enabled=True)
    decision = router.build_chat_decision(
        request_id="req_pending_todos",
        messages=[{"role": "user", "content": "Build the parser."}],
        latest_user_content="Build the parser.",
        mode="assist",
        approvals_pre_granted=True,
        runtime=LoopRuntime(request_id="req_pending_todos", max_iterations=max_iterations),
    )
    return engine, decision


def _empty() -> _ToolPlan:
    return _ToolPlan(result=GenerationResult(content="", finish_reason="stop"))


def test_an_empty_completion_with_pending_todos_continues_with_tools(caplog) -> None:
    caplog.set_level(logging.WARNING, logger="sidecar.ai.routing.tool_loop")
    engine, decision = _run(
        _todos(_PENDING),
        [
            _empty(),
            _ToolPlan(
                result=GenerationResult(content="All three items are done.", finish_reason="stop")
            ),
        ],
    )

    assert engine.call_count == 3
    assert decision.response_text == "All three items are done."
    assert decision.completion_source != "model_winddown"
    retry_request = engine.requests[2]
    assert retry_request["tools"], "the continuation keeps tools"
    nudges = [
        str(message.get("content", ""))
        for message in retry_request["messages"]
        if "pending" in str(message.get("content", "")).lower()
        and "todo" in str(message.get("content", "")).lower()
    ]
    assert nudges and "Wire the parser into the CLI" in nudges[-1]
    retries = [
        record
        for record in caplog.records
        if record.__dict__.get("event") == "ai.router.post_tool_recovery_retry"
    ]
    assert [record.__dict__["data"]["trigger"] for record in retries] == [
        "empty_with_pending_todos"
    ]


def test_a_second_empty_completion_falls_back_instead_of_retrying_again() -> None:
    engine, decision = _run(_todos(_PENDING), [_empty(), _empty(), _empty()])

    assert engine.call_count == 3
    assert decision.response_text.strip()
    assert decision.completion_source == "deterministic_tool_fallback"


def test_an_empty_completion_with_every_todo_done_still_winds_down() -> None:
    cleared = json.dumps({"cleared": True, "reason": "all items completed", "count": 0})
    engine, decision = _run(
        cleared,
        [
            _empty(),
            _ToolPlan(
                result=GenerationResult(content="Summary of the work.", finish_reason="stop")
            ),
        ],
    )

    assert engine.call_count == 3
    assert decision.response_text == "Summary of the work."
    assert decision.completion_source == "model_winddown"
    assert engine.requests[-1]["tools"] == []
