"""Helpers carved out of the chat-decision and tool-call routing modules (row 105 W2-G)."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

from sidecar.ai.error_codes import CMP_LOOP_INVALID_TOOL_CALL, CMP_TOOL_APPROVAL_WINDOW_DROPPED
from sidecar.ai.routing import (
    chat_decision,
    chat_decision_preflight,
    tool_call_execution,
    tool_call_prefilter,
    tool_call_settlement,
    tool_loop_recovery,
    tool_loop_wind_down,
)
from sidecar.ai.routing.loop_runtime import LoopRuntime
from sidecar.ai.routing.tool_loop_call_state import _ToolCallStateMixin
from sidecar.ai.routing.tool_loop_calls import _ToolCallPhasesMixin
from sidecar.ai.routing.tool_loop_run import _ToolLoopRun
from sidecar.ai.tools.models import GenerationResult, ToolCallRequest


class _Kernel:
    _config = SimpleNamespace(max_tools_per_turn=20)

    def _assistant_tool_call_message(self, _result: Any, call: ToolCallRequest) -> dict[str, Any]:
        return {"role": "assistant", "tool": call.tool_id}

    def _tool_result_message(self, call: ToolCallRequest, outcome: Any) -> dict[str, Any]:
        return {"role": "tool", "tool": call.tool_id, "code": outcome.error_code}


def _call(tool_id: str, call_id: str, **arguments: Any) -> ToolCallRequest:
    return ToolCallRequest(tool_id=tool_id, arguments=dict(arguments), call_id=call_id)


def test_original_modules_still_expose_the_carved_out_functions() -> None:
    # Live turns, resumes and patch targets resolve these through the original modules.
    assert tool_call_execution.pre_filter_tool_calls is tool_call_prefilter.pre_filter_tool_calls
    assert tool_call_execution.preparation_refusal is tool_call_prefilter.preparation_refusal
    assert (
        tool_call_execution.settle_dropped_tool_calls
        is tool_call_settlement.settle_dropped_tool_calls
    )
    assert chat_decision._prepare_context_budget is chat_decision_preflight._prepare_context_budget
    for name in (
        "WindDownSpec", "_tool_cap_spent", "budget_exhausted_wind_down", "empty_final_wind_down",
        "max_iterations_summary", "maybe_wind_down_tool_cap_final", "wind_down_response",
    ):
        assert getattr(tool_loop_recovery, name) is getattr(tool_loop_wind_down, name)
    assert _ToolCallStateMixin in _ToolCallPhasesMixin.__mro__
    assert _ToolLoopRun._record_blocked_tool_calls is _ToolCallStateMixin._record_blocked_tool_calls


def test_split_modules_log_under_the_original_logger_names() -> None:
    assert tool_call_prefilter.logger.name == "sidecar.ai.routing.tool_call_execution"
    assert tool_call_settlement.logger.name == "sidecar.ai.routing.tool_call_execution"
    assert chat_decision_preflight.logger.name == "sidecar.ai.routing.chat_decision"
    assert tool_loop_wind_down.logger.name == "sidecar.ai.routing.tool_loop"


def test_placeholder_reason_matches_markers_only_where_it_is_safe() -> None:
    schema = {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}
    writer = SimpleNamespace(side_effecting=True, input_schema=schema)
    reader = SimpleNamespace(side_effecting=False, input_schema=schema)
    reason = tool_call_prefilter._placeholder_arguments_reason

    assert reason(_call("edit", "c1", path="<string>"), writer) == "schema_example_echo"
    assert reason(_call("grep", "c2", path="<string>"), reader) == "schema_example_echo"
    assert reason(_call("grep", "c3", path="a", q="<value>"), reader) is None
    assert reason(_call("edit", "c4", path="a", q=["<value>"]), writer) == "placeholder_literal"
    assert reason(_call("edit", "c5", path="a.txt"), writer) is None


def test_turn_boundary_settles_every_unstarted_call_with_a_paired_row() -> None:
    events: list[Any] = []
    runtime = LoopRuntime(emit=events.append, request_id="req")
    outcomes: list[Any] = []
    working: list[dict[str, Any]] = []
    boundary = SimpleNamespace(
        completion_reason="session_proposed",
        not_executed_output=lambda tool_id: f"{tool_id} did not run",
    )

    settled = tool_call_settlement.settle_after_turn_boundary(
        kernel=_Kernel(), runtime=runtime, result=SimpleNamespace(), request_id="req",
        session_id="s", boundary=boundary,
        unstarted_calls=[(_call("a", "u1"), 2), (_call("b", "u2"), 3)],
        outcomes=outcomes, working_messages=working, iteration_calls=[],
        streamed_event_types=set(),
    )

    assert settled == 2
    assert [outcome.output for outcome in outcomes] == ["a did not run", "b did not run"]
    assert {outcome.error_code for outcome in outcomes} == {CMP_TOOL_APPROVAL_WINDOW_DROPPED}
    assert outcomes[0].metadata["turn_boundary_not_executed"] is True
    assert outcomes[0].metadata["reason"] == "session_proposed"
    assert [message["role"] for message in working] == ["assistant", "tool", "assistant", "tool"]
    assert len(events) == 4


def _unknown_loop() -> SimpleNamespace:
    loop = SimpleNamespace(
        runtime=LoopRuntime(emit=lambda _event: None, request_id="req"), kernel=_Kernel(),
        request_id="req", session_id="s", outcome_index=0, outcomes=[], working_messages=[],
        streamed_event_types=set(), tool_contract=None, finished=[],
    )
    loop._append_failed_tool_context_if_needed = lambda: None
    loop._advance_cycle_history = lambda history, errors, *_args: (history, errors)
    loop.previous_tool_calls = loop.last_tool_calls = ()
    loop.tool_call_history, loop.error_output_history = (), ()
    return loop


def test_unknown_tool_calls_are_recorded_and_the_valid_ones_kept() -> None:
    loop = _unknown_loop()
    valid = (_call("read_file", "v1"),)
    result = GenerationResult(content="", tool_calls=(*valid, _call("nope", "x1")))

    narrowed, all_invalid = _ToolCallStateMixin._record_unknown_tool_calls(
        loop, result, valid, ((result.tool_calls[1], "unknown tool 'nope'"),),
        iteration=1, last_error_output=None,
    )

    assert all_invalid is False
    assert narrowed.tool_calls == valid
    assert [outcome.error_code for outcome in loop.outcomes] == [CMP_LOOP_INVALID_TOOL_CALL]
    assert loop.outcome_index == 1


def test_all_unknown_tool_calls_finish_the_iteration() -> None:
    loop = _unknown_loop()
    unknown = _call("nope", "x1")
    result = GenerationResult(content="", tool_calls=(unknown,))

    _result, all_invalid = _ToolCallStateMixin._record_unknown_tool_calls(
        loop, result, (), ((unknown, "unknown tool 'nope'"),), iteration=1, last_error_output="e",
    )

    assert all_invalid is True
    assert loop.last_tool_calls == (unknown,)
    assert loop.previous_error_output == "e"
