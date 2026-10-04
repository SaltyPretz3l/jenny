"""FG-009: a Plan-mode outside-root refusal tells the model to defer the read.

A read-only Plan-mode turn cannot read files outside the bound workspace root.
The model-facing failure text adds one sentence steering the read into the
build step; the error code, the containment check, and every non-Plan
refusal stay exactly as they were.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

from sidecar.ai.error_codes import CMP_TOOL_INVALID_PATH, CMP_TOOL_OUTSIDE_WORKSPACE
from sidecar.ai.routing.loop_runtime import LoopRuntime
from sidecar.ai.routing.router import ToolExecutionOutcome
from sidecar.ai.routing.tool_call_execution import (
    PLAN_MODE_OUTSIDE_ROOT_HINT,
    execute_tool_calls_sequentially,
)
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.models import ToolCallRequest
from sidecar.runtime.turn_state import LiveRunModeState, bind_live_run_mode_state

_ESCAPE_MESSAGE = "resolved path escapes tools workspace root"


class _Contract:
    def entry(self, _name: str) -> Any | None:
        return None


class _Kernel:
    def __init__(self, failure: ToolExecutionFailure) -> None:
        self._failure = failure

    def _assert_valid_tool_call(self, _call: ToolCallRequest) -> None:
        return

    def _assistant_tool_call_message(self, _result: Any, call: ToolCallRequest) -> dict[str, object]:
        return {"role": "assistant", "tool": call.tool_id}

    def _tool_result_message(
        self, call: ToolCallRequest, _outcome: ToolExecutionOutcome
    ) -> dict[str, object]:
        return {"role": "tool", "tool": call.tool_id}

    def _execute_tool(self, call: ToolCallRequest, **_kwargs: Any) -> ToolExecutionOutcome:
        raise self._failure

    def _update_read_snapshot_cache(self, _cache: dict[str, Any], **_kwargs: Any) -> None:
        return


def _failure(code: str = CMP_TOOL_OUTSIDE_WORKSPACE) -> ToolExecutionFailure:
    return ToolExecutionFailure(code=code, message=_ESCAPE_MESSAGE, retryable=False)


def _run(
    failure: ToolExecutionFailure,
    *,
    request_context: Any | None,
    tool_id: str = "read_file",
) -> ToolExecutionOutcome:
    runtime = LoopRuntime(
        emit=lambda _event: None,
        request_id="req-1",
        session_id="session-1",
        streaming=False,
        tool_call_limit=20,
    )
    outcomes: list[ToolExecutionOutcome] = []
    call = ToolCallRequest(
        tool_id=tool_id, arguments={"path": "G:/outside/rows.csv"}, call_id="c1"
    )
    execute_tool_calls_sequentially(
        indexed_calls=[(call, 1)],
        runtime=runtime,
        kernel=_Kernel(failure),
        result=SimpleNamespace(),
        request_id="req-1",
        session_id="session-1",
        tool_resolution_context=None,
        read_snapshot_cache={},
        outcomes=outcomes,
        working_messages=[],
        iteration_calls=[],
        streamed_event_types=set(),
        tool_payload_ref=[],
        tool_contract=_Contract(),
        request_context=request_context,
    )
    assert len(outcomes) == 1
    return outcomes[0]


_PLAN = SimpleNamespace(plan_mode=True, read_only=True)


def test_plan_mode_outside_root_refusal_carries_the_build_step_hint() -> None:
    outcome = _run(_failure(), request_context=_PLAN)
    assert outcome.success is False
    assert outcome.error_code == CMP_TOOL_OUTSIDE_WORKSPACE
    assert _ESCAPE_MESSAGE in outcome.output
    assert PLAN_MODE_OUTSIDE_ROOT_HINT in outcome.output
    assert "Plan mode" in PLAN_MODE_OUTSIDE_ROOT_HINT
    assert "Build it" in PLAN_MODE_OUTSIDE_ROOT_HINT
    assert "run_command" not in outcome.output


def test_list_dir_outside_root_in_plan_mode_carries_the_hint() -> None:
    outcome = _run(_failure(), request_context=_PLAN, tool_id="list_dir")
    assert PLAN_MODE_OUTSIDE_ROOT_HINT in outcome.output


def test_non_plan_outside_root_refusal_is_unchanged() -> None:
    build = SimpleNamespace(plan_mode=False, read_only=False)
    outcome = _run(_failure(), request_context=build)
    assert PLAN_MODE_OUTSIDE_ROOT_HINT not in outcome.output
    assert outcome.output == (
        f"Tool 'read_file' failed: {_ESCAPE_MESSAGE}. "
        "Review the error and retry with corrected arguments if applicable."
    )


def test_missing_request_context_adds_no_hint() -> None:
    outcome = _run(_failure(), request_context=None)
    assert PLAN_MODE_OUTSIDE_ROOT_HINT not in outcome.output


def test_read_only_subagent_outside_plan_mode_adds_no_hint() -> None:
    child = SimpleNamespace(plan_mode=False, read_only=True)
    outcome = _run(_failure(), request_context=child)
    assert PLAN_MODE_OUTSIDE_ROOT_HINT not in outcome.output


def test_other_plan_mode_failures_add_no_hint() -> None:
    outcome = _run(_failure(CMP_TOOL_INVALID_PATH), request_context=_PLAN)
    assert PLAN_MODE_OUTSIDE_ROOT_HINT not in outcome.output


def test_leaving_plan_mode_mid_turn_drops_the_hint() -> None:
    live = LiveRunModeState(approval_mode="prompt", read_only=True)
    live.update(approval_mode="prompt", read_only=False)
    with bind_live_run_mode_state(live):
        outcome = _run(_failure(), request_context=_PLAN)
    assert PLAN_MODE_OUTSIDE_ROOT_HINT not in outcome.output
