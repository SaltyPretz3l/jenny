"""Drive one production Python continuation resume from Node-owned artifacts."""

from __future__ import annotations

import json
import sys
from dataclasses import replace
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from sidecar.ai.mcp.models import MCPToolDescriptor  # noqa: E402
from sidecar.ai.routing import chat_decision  # noqa: E402
from sidecar.ai.routing.router import ChatDecision, ToolExecutionOutcome  # noqa: E402
from sidecar.ai.tools.models import GenerationResult  # noqa: E402
from sidecar.runtime.chat import build_chat_send_response  # noqa: E402
from tests.sidecar.ai.routing.test_tool_loop import (  # noqa: E402
    _build_router,
    _StubMCPClient,
    _ToolLoopEngine,
    _ToolPlan,
)
from tests.sidecar.runtime.test_chat import _build_brain_container  # noqa: E402


class RecordingEngine(_ToolLoopEngine):
    def __init__(self, events: list[list[Any]]) -> None:
        super().__init__(
            [
                _ToolPlan(
                    result=GenerationResult(
                        content="Resumed after the saved read.", finish_reason="stop"
                    )
                )
            ]
        )
        self._events = events

    def get_model_max_output_tokens(self) -> int:
        return 256

    def get_model_context_length(self) -> int:
        return 8192

    def get_inference_budget_context_length(self) -> int:
        # The controlled producer emits one fixed short answer, within this ceiling.
        return 8192

    def generate_with_tools(self, **kwargs: Any) -> GenerationResult:
        self._events.append(["generate"])
        return super().generate_with_tools(**kwargs)

    def stream_with_tools(self, **kwargs: Any):
        self._events.append(["generate"])
        return (yield from super().stream_with_tools(**kwargs))


class RecordingMCPClient(_StubMCPClient):
    def __init__(self, events: list[list[Any]]) -> None:
        super().__init__(
            (
                MCPToolDescriptor(
                    name="read_metric",
                    description="Read a deterministic metric.",
                    input_schema={
                        "type": "object",
                        "properties": {"value": {"type": "integer"}},
                        "required": ["value"],
                        "additionalProperties": False,
                    },
                    side_effecting=False,
                    server_name="integration-test",
                ),
            )
        )
        self._events = events

    def execute_tool(
        self,
        tool_name: str,
        arguments: dict[str, object],
        **kwargs: Any,
    ) -> object:
        self._events.append(["tool", tool_name, dict(arguments)])
        return super().execute_tool(tool_name, arguments, **kwargs)


class RuntimeBridge:
    def __init__(self) -> None:
        self.messages: dict[int, dict[str, Any]] = {}
        self.operation_checks = 0

    def write(self, message: dict[str, Any]) -> None:
        self.messages[int(message["id"])] = message

    def reader_factory(self, rpc_id: int, **_kwargs: Any):
        def read(_timeout: float) -> dict[str, Any]:
            message = self.messages.pop(rpc_id)
            params = message["params"]
            if params.get("kind") in {"tool", "inference"}:
                status = "settled" if params["phase"] == "settle" else "granted"
            else:
                self.operation_checks += 1
                status = "granted"
            return {
                "jsonrpc": "2.0",
                "id": rpc_id,
                "result": {
                    "schema_version": 1,
                    "operation_id": params["operation_id"],
                    "status": status,
                },
            }

        read.close = lambda: None  # type: ignore[attr-defined]
        return read


def main() -> None:
    payload = json.load(sys.stdin)
    events: list[list[Any]] = []
    engine = RecordingEngine(events)
    mcp_client = RecordingMCPClient(events)
    router = _build_router(
        engine=engine,
        mcp_client=mcp_client,
        extra_snapshot_tools=("read_metric",),
    )
    if payload.get("legacy_quota_disabled") is True:
        router._config = replace(
            router._config,
            feature_flags={**(router._config.feature_flags or {}), "resource_discipline": False},
        )
    if "child_result" in payload:
        router._config = replace(router._config, electron_tool_bridge_enabled=True)

        def execute_child(call, **_kwargs):
            if call.tool_id != "session_wait":
                raise AssertionError("Only the pending saved wait may execute")
            events.append(["tool", call.tool_id, dict(call.arguments)])
            return ToolExecutionOutcome(
                tool_name=call.tool_id,
                call_id=call.call_id,
                tool_input=dict(call.arguments),
                success=True,
                output=json.dumps(payload["child_result"]),
            )

        router._execute_tool = execute_child
    brain = _build_brain_container(ChatDecision(None, "unused", None, ()))
    brain.stack.router = router
    brain.stack.engine = engine
    brain.stack.mcp_client = mcp_client
    brain.stack.context_builder = router._context_builder
    brain.stack.config = router._config
    bridge = RuntimeBridge()
    params = dict(payload["fresh_request"])
    params.update(
        {
            "mode": "assist",
            "runtime_continuation_resume": payload["runtime_continuation_resume"],
        }
    )
    original_budget = chat_decision._prepare_context_budget

    def recording_budget(*args: Any, **kwargs: Any):
        events.append(["budget"])
        return original_budget(*args, **kwargs)

    chat_decision._prepare_context_budget = recording_budget
    try:
        response = build_chat_send_response(
            "message_resume_b",
            params,
            approvals_pre_granted=False,
            brain_container=brain,
            invalid_params_code=-32602,
            approval_writer=bridge.write,
            approval_reader_factory=bridge.reader_factory,
        )
    finally:
        chat_decision._prepare_context_budget = original_budget
    print(
        json.dumps(
            {
                "events": events,
                "executions": mcp_client.executions,
                "engine_calls": engine.call_count,
                "operation_checks": bridge.operation_checks,
                "status": response.result["status"],
                "response": response.result["response_text"],
            },
            separators=(",", ":"),
        )
    )


if __name__ == "__main__":
    main()
