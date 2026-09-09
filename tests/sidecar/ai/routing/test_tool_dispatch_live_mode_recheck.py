"""Pre-dispatch live run-mode recheck contracts."""

from __future__ import annotations

from contextlib import nullcontext
from types import SimpleNamespace
from typing import Any, Callable, ContextManager

import pytest

from sidecar.ai.error_codes import CMP_TOOL_PAUSED_UNATTENDED
from sidecar.ai.routing.loop_runtime import LoopRuntime
from sidecar.ai.routing.router import ToolExecutionOutcome
from sidecar.ai.routing.tool_call_execution import execute_tool_calls_sequentially
from sidecar.ai.tools.models import ToolCallRequest
from sidecar.runtime import turn_state


def _call(tool_id: str) -> ToolCallRequest:
    return ToolCallRequest(tool_id=tool_id, arguments={}, call_id=f"call-{tool_id}")


def _descriptor(name: str, *, side_effecting: bool) -> Any:
    return SimpleNamespace(name=name, side_effecting=side_effecting)


class _McpClient:
    def __init__(self, descriptors: dict[str, Any]) -> None:
        self.descriptors = descriptors

    def tool_descriptor(self, name: str) -> Any | None:
        return self.descriptors.get(name)


class _Kernel:
    def __init__(
        self,
        state: turn_state.LiveRunModeState | None,
        *,
        second_side_effecting: bool = True,
        after_first: Callable[[turn_state.LiveRunModeState], None] | None = None,
    ) -> None:
        self._config = SimpleNamespace(tool_result_envelope_enabled=True)
        self._mcp_client = _McpClient(
            {
                "first": _descriptor("first", side_effecting=True),
                "second": _descriptor("second", side_effecting=second_side_effecting),
            }
        )
        self.state = state
        self.after_first = after_first
        self.executed: list[str] = []

    def _execute_tool(self, call: ToolCallRequest, **_kwargs: Any) -> ToolExecutionOutcome:
        self.executed.append(call.tool_id)
        if call.tool_id == "first" and self.state is not None and self.after_first is not None:
            self.after_first(self.state)
        return ToolExecutionOutcome(
            tool_name=call.tool_id,
            output=f"result:{call.tool_id}",
            success=True,
            tool_input=dict(call.arguments),
            call_id=call.call_id,
        )

    def _update_read_snapshot_cache(self, _cache: dict[str, Any], **_kwargs: Any) -> None:
        return

    def _assistant_tool_call_message(
        self,
        _result: Any,
        call: ToolCallRequest,
    ) -> dict[str, object]:
        return {"role": "assistant", "tool": call.tool_id}

    def _tool_result_message(
        self,
        call: ToolCallRequest,
        _outcome: ToolExecutionOutcome,
    ) -> dict[str, object]:
        return {"role": "tool", "tool": call.tool_id}


def _set_prompt(state: turn_state.LiveRunModeState) -> None:
    state.update(approval_mode="prompt", read_only=False)


def _set_prompt_then_auto_run(state: turn_state.LiveRunModeState) -> None:
    state.update(approval_mode="prompt", read_only=False)
    state.update(approval_mode="auto_run", read_only=False)


def _run_batch(
    *,
    state: turn_state.LiveRunModeState | None,
    second_side_effecting: bool = True,
    approvals_pre_granted: bool = False,
    scan_approval_mode: str | None = "auto_run",
    after_first: Callable[[turn_state.LiveRunModeState], None] | None = _set_prompt,
) -> tuple[_Kernel, list[ToolExecutionOutcome]]:
    runtime = LoopRuntime(
        emit=lambda _event: None,
        request_id="req-1",
        session_id="session-1",
        streaming=False,
        tool_call_limit=20,
    )
    kernel = _Kernel(
        state,
        second_side_effecting=second_side_effecting,
        after_first=after_first,
    )
    calls = [_call("first"), _call("second")]
    outcomes: list[ToolExecutionOutcome] = []
    binding: ContextManager[None] = (
        turn_state.bind_live_run_mode_state(state) if state is not None else nullcontext()
    )
    with binding:
        execute_tool_calls_sequentially(
            indexed_calls=[(calls[0], 1), (calls[1], 2)],
            runtime=runtime,
            kernel=kernel,
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
            approvals_pre_granted=approvals_pre_granted,
            scan_approval_mode=scan_approval_mode,
        )
    return kernel, outcomes


def test_prompt_flip_pauses_next_side_effecting_call_and_logs_once(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    events: list[dict[str, Any]] = []
    monkeypatch.setattr(
        "sidecar.ai.routing.tool_call_execution.log_event",
        lambda *_args, **kwargs: events.append(kwargs),
    )
    state = turn_state.LiveRunModeState(approval_mode="auto_run")

    kernel, outcomes = _run_batch(state=state)

    assert kernel.executed == ["first"]
    assert outcomes[0].success is True
    assert outcomes[1].error_code == CMP_TOOL_PAUSED_UNATTENDED
    paused = [event for event in events if event.get("event") == "ai.router.tool_dispatch_paused_unattended"]
    assert len(paused) == 1
    assert paused[0]["data"] == {"tool": "second", "code": CMP_TOOL_PAUSED_UNATTENDED}


def test_prompt_flip_keeps_read_only_second_call_executing() -> None:
    state = turn_state.LiveRunModeState(approval_mode="auto_run")

    kernel, outcomes = _run_batch(state=state, second_side_effecting=False)

    assert kernel.executed == ["first", "second"]
    assert all(outcome.success for outcome in outcomes)


def test_pre_granted_approvals_bypass_pause() -> None:
    state = turn_state.LiveRunModeState(approval_mode="prompt")

    kernel, outcomes = _run_batch(state=state, approvals_pre_granted=True, after_first=None)

    assert kernel.executed == ["first", "second"]
    assert all(outcome.success for outcome in outcomes)


def test_batch_scanned_in_prompt_mode_bypasses_pause() -> None:
    state = turn_state.LiveRunModeState(approval_mode="prompt")

    kernel, outcomes = _run_batch(state=state, scan_approval_mode="prompt", after_first=None)

    assert kernel.executed == ["first", "second"]
    assert all(outcome.success for outcome in outcomes)


def test_unbound_live_state_bypasses_pause() -> None:
    kernel, outcomes = _run_batch(state=None)

    assert kernel.executed == ["first", "second"]
    assert all(outcome.success for outcome in outcomes)


def test_flip_back_to_auto_run_before_next_dispatch_is_not_cached() -> None:
    state = turn_state.LiveRunModeState(approval_mode="auto_run")

    kernel, outcomes = _run_batch(state=state, after_first=_set_prompt_then_auto_run)

    assert kernel.executed == ["first", "second"]
    assert all(outcome.success for outcome in outcomes)
