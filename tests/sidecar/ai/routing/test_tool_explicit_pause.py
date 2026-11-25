from __future__ import annotations

from typing import Any

import pytest

from sidecar.ai.mcp.models import MCPToolDescriptor
from sidecar.ai.routing.loop_events import ToolExecutingEvent, ToolResultEvent
from sidecar.ai.routing.loop_runtime import LoopRuntime
from sidecar.ai.routing.tool_resource_deferral import ToolLoopSuspended
from sidecar.ai.tools.models import GenerationResult, ToolCallRequest
from sidecar.runtime.chat_models import ChatRequestContext
from tests.sidecar.ai.routing.test_tool_loop import (
    _build_router,
    _StubMCPClient,
    _ToolLoopEngine,
    _ToolPlan,
)


class _Checkpoint:
    def __init__(self, paused: bool) -> None:
        self.paused = paused
        self.probes: list[Any] = []

    def __call__(self, _continuation: Any) -> dict[str, Any]:
        raise AssertionError("no resource wait was requested")

    def probe_pause(self, continuation: Any) -> dict[str, Any] | None:
        self.probes.append(continuation)
        return {"checkpoint_id": "checkpoint_pause"} if self.paused else None


def _run(*, paused: bool, iteration_base: int = 0, preview: bool = False):
    descriptor = MCPToolDescriptor(
        name="read_metric", description="Read a metric", side_effecting=False,
        input_schema={"type": "object", "properties": {"value": {"type": "integer"}},
                      "required": ["value"]}, server_name="tools",
    )
    engine = _ToolLoopEngine([_ToolPlan(GenerationResult(
        content="", tool_calls=(ToolCallRequest(
            call_id="call_1", tool_id="read_metric", arguments={"value": 7},
        ),), finish_reason="tool_calls",
    )), _ToolPlan(GenerationResult(content="Done.", finish_reason="stop"))])
    client = _StubMCPClient((descriptor,))
    router = _build_router(engine=engine, mcp_client=client)
    context = ChatRequestContext(request_id="stream_1", session_id="session_1",
                                 mode="assist", workspace_root_present=True,
                                 trace_id="trace_1", approvals_pre_granted=False)
    callback = _Checkpoint(paused)
    events: list[Any] = []
    runtime = LoopRuntime(request_id="stream_1", session_id="session_1", streaming=True,
                          emit=events.append, continuation_checkpoint=callback, logical_turn_id="turn_1",
                          request_context=context, iteration_base=iteration_base)
    if preview:
        stream = engine.stream_with_tools

        def with_preview(**kwargs):
            result = yield from stream(**kwargs)
            runtime.preview_images["previous"] = object()
            return result

        engine.stream_with_tools = with_preview

    def execute():
        return router.build_chat_decision(
            request_id="stream_1", messages=[{"role": "user", "content": "Read the metric."}],
            latest_user_content="Read the metric.", mode="assist", approvals_pre_granted=False,
            request_context=context, runtime=runtime,
        )
    return execute, callback, client, events, engine


def test_real_first_batch_pauses_before_any_tool_effect_or_executing_event() -> None:
    execute, callback, client, events, engine = _run(paused=True)
    with pytest.raises(ToolLoopSuspended) as caught:
        execute()
    assert caught.value.checkpoint_ref == {"checkpoint_id": "checkpoint_pause"}
    assert engine.call_count == 1
    assert client.executions == []
    assert not any(isinstance(event, (ToolExecutingEvent, ToolResultEvent)) for event in events)
    assert len(callback.probes) == 1
    saved = callback.probes[0]
    assert saved.pending.wait is None
    assert saved.pending.tool_id == "read_metric"
    assert saved.pending.frozen_input()["visible_tool_arguments"] == {"value": 7}
    assert saved.current_iteration == 1
    assert saved.pending.frozen_input()["execution_context_payload"]["logical_turn_id"] == "turn_1"


def test_continue_probe_preserves_normal_tool_dispatch() -> None:
    execute, callback, client, _events, engine = _run(paused=False)
    execute()
    assert len(callback.probes) == 1
    assert len(client.executions) == 1
    assert engine.call_count == 2


@pytest.mark.parametrize("options", [{"iteration_base": 1}, {"preview": True}])
def test_unsafe_boundary_does_not_probe_or_claim_a_checkpoint(options) -> None:
    execute, callback, client, _events, _engine = _run(paused=True, **options)
    execute()
    assert callback.probes == []
    assert len(client.executions) == 1


class _RealPositionProbe(_Checkpoint):
    """Runs the checkpoint's own position checks, as the request to Electron would."""

    def probe_pause(self, continuation: Any) -> dict[str, Any] | None:
        from sidecar.runtime import continuation_checkpoint

        self.probes.append(continuation)
        continuation_checkpoint._position(continuation)
        return None


@pytest.mark.parametrize("setting", [200, 400, 500])
def test_any_tools_per_turn_setting_passes_the_first_batch_probe(setting) -> None:
    # Settings offer 1..500 tool calls per turn; a checkpoint cap of 256 failed every
    # first batch above it with continuation_tool_call_limit_invalid.
    from dataclasses import replace

    from sidecar.ai.config import parse_runtime_config

    parsed = parse_runtime_config({"engine_type": "api-provider", "cloud_max_tools_per_turn": setting})
    descriptor = MCPToolDescriptor(
        name="read_metric", description="Read a metric", side_effecting=False,
        input_schema={"type": "object", "properties": {"value": {"type": "integer"}},
                      "required": ["value"]}, server_name="tools")
    engine = _ToolLoopEngine([
        _ToolPlan(GenerationResult(content="", tool_calls=(ToolCallRequest(
            call_id="call_1", tool_id="read_metric", arguments={"value": 7}),),
            finish_reason="tool_calls")),
        _ToolPlan(GenerationResult(content="Done.", finish_reason="stop")),
    ])
    router = _build_router(engine=engine, mcp_client=_StubMCPClient((descriptor,)),
                           engine_type="api-provider")
    router._config = replace(router._config, cloud_max_tools_per_turn=parsed.cloud_max_tools_per_turn)
    context = ChatRequestContext(request_id="stream_1", session_id="session_1", mode="assist",
                                 workspace_root_present=True, trace_id="trace_1",
                                 approvals_pre_granted=False)
    probe = _RealPositionProbe(paused=False)
    runtime = LoopRuntime(request_id="stream_1", session_id="session_1", streaming=True,
                          emit=lambda _e: None, continuation_checkpoint=probe,
                          logical_turn_id="turn_1", request_context=context)
    router.build_chat_decision(
        request_id="stream_1", messages=[{"role": "user", "content": "Read."}],
        latest_user_content="Read.", mode="assist", approvals_pre_granted=False,
        request_context=context, runtime=runtime)
    assert [item.tool_call_limit for item in probe.probes] == [setting]
