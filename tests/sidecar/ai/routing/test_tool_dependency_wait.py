from __future__ import annotations

import json
from dataclasses import replace
from typing import Any

import pytest

from sidecar.ai.routing.loop_events import ToolExecutingEvent, ToolResultEvent
from sidecar.ai.routing.loop_runtime import LoopRuntime
from sidecar.ai.routing.router import ToolExecutionOutcome
from sidecar.ai.routing.tool_resource_deferral import ToolLoopSuspended
from sidecar.ai.tools.models import GenerationResult, ToolCallRequest
from sidecar.runtime.chat_models import ChatRequestContext
from tests.sidecar.ai.routing.test_tool_loop import _build_router, _ToolLoopEngine, _ToolPlan
from tests.sidecar.runtime.test_continuation_checkpoint import _callback, _result


class Checkpoint:
    def __init__(self):
        self.probes = []

    def __call__(self, _value):
        raise AssertionError("resource checkpoint not expected")

    def probe_pause(self, _value):
        return None

    def probe_dependency(self, value):
        self.probes.append(value)
        return {"checkpoint_id": "dependency_1"}


def run_loop(
    *,
    success=True,
    capability=True,
    preview=False,
    first_tool="session_spawn",
    wait_child="child_1",
):
    spawn = ToolCallRequest(call_id="spawn_1", tool_id=first_tool, arguments={"task": "Read"})
    wait = ToolCallRequest(
        call_id="wait_1", tool_id="session_wait", arguments={"child_work_id": wait_child}
    )
    engine = _ToolLoopEngine(
        [
            _ToolPlan(GenerationResult(content="", tool_calls=(call,), finish_reason="tool_calls"))
            for call in [spawn, wait]
        ]
        + [_ToolPlan(GenerationResult(content="Done", finish_reason="stop"))]
    )
    router = _build_router(engine=engine)
    router._config = replace(router._config, electron_tool_bridge_enabled=True)
    context = ChatRequestContext(
        request_id="stream_1",
        trace_id=None,
        session_id="session_1",
        logical_turn_id="turn_1",
        mode="assist",
        approvals_pre_granted=False,
        workspace_root_present=True,
        runtime_children_enabled=capability,
    )
    checkpoint = Checkpoint()
    events: list[Any] = []
    runtime = LoopRuntime(
        request_id="stream_1",
        logical_turn_id="turn_1",
        session_id="session_1",
        streaming=True,
        emit=events.append,
        continuation_checkpoint=checkpoint,
        request_context=context,
    )
    executed = []

    def execute(call, **_kwargs):
        executed.append(call.tool_id)
        receipt = {
            "root_run_id": "root_1",
            "child_work_id": "child_1",
            "session_id": "sess_child",
            "turn_id": "turn_child",
        }
        return ToolExecutionOutcome(
            tool_name=call.tool_id,
            output=json.dumps(receipt),
            success=success,
            tool_input=dict(call.arguments),
            call_id=call.call_id,
        )

    router._execute_tool = execute
    if preview:
        stream = engine.stream_with_tools

        def with_preview(**kwargs):
            result = yield from stream(**kwargs)
            runtime.preview_images["preview"] = object()
            return result

        engine.stream_with_tools = with_preview

    def run():
        return router.build_chat_decision(
            request_id="stream_1",
            messages=[{"role": "user", "content": "Delegate this inspection"}],
            latest_user_content="Delegate this inspection",
            mode="assist",
            approvals_pre_granted=False,
            request_context=context,
            runtime=runtime,
        )

    return run, checkpoint, events, executed, runtime


def test_real_two_iteration_loop_suspends_before_wait_execution():
    run, checkpoint, events, executed, runtime = run_loop()
    with pytest.raises(ToolLoopSuspended):
        run()
    assert executed == ["session_spawn"]
    assert [event.call_id for event in events if isinstance(event, ToolExecutingEvent)] == [
        "spawn_1"
    ]
    assert [event.call_id for event in events if isinstance(event, ToolResultEvent)] == ["spawn_1"]
    value = checkpoint.probes[0]
    assert value.current_iteration == 2
    assert value.tool_calls_consumed == 2
    assert value.completed_spawn_refs[0].child_work_id == "child_1"
    assert value.pending.frozen_input()["execution_context_payload"]["logical_turn_id"] == "turn_1"
    assert runtime.tool_result_emitted_call_ids == {"spawn_1"}


@pytest.mark.parametrize(
    "options",
    [
        {"success": False},
        {"capability": False},
        {"preview": True},
        {"wait_child": "unrelated_child"},
    ],
)
def test_ineligible_loop_never_claims_dependency_checkpoint(options):
    run, checkpoint, _events, _executed, _runtime = run_loop(**options)
    run()
    assert checkpoint.probes == []


def test_actual_dependency_probe_serializes_closed_checkpoint_request():
    run, checkpoint, _events, _executed, _runtime = run_loop()
    with pytest.raises(ToolLoopSuspended):
        run()
    sent = []
    callback, readers = _callback(sent, _result(operation_id="wait_1"))
    result = callback.probe_dependency(checkpoint.probes[0])
    assert result["checkpoint_id"].startswith("checkpoint_")
    params = sent[0]["params"]
    assert params["phase"] == "dependency_checkpoint"
    assert params["operation_id"] == "wait_1"
    assert params["position"]["tool_calls_consumed"] == 2
    assert params["position"]["current_iteration"] == 2
    assert params["eligibility"]["prior_outcome_count"] == 1
    assert params["eligibility"]["emitted_tool_execution_count"] == 1
    assert params["completed_spawn_refs"] == [
        checkpoint.probes[0].completed_spawn_refs[0].to_wire()
    ]
    assert readers[0].closed
