"""A chat.send with no approval channel must fail closed, not pre-grant.

``process_message`` routes ``chat.send`` to ``process_chat_send_request`` with
``interactive_approval=False`` whenever the server has no multiplexer (the
``multiplexer`` / ``chat_cancel`` kill switches, or a chat.send that arrives
before the multiplexer exists). That route used to run the turn with
``approvals_pre_granted=True``, which skipped every gate in
``approval_if_needed``: the mandatory Python gate, always-ask destructive
tools, policy ASK, destructive shell, strict auto-run and paranoid mode.

These drive the real dispatcher and the real ``ChatRouter`` tool loop with a
scripted engine; only the engine and the MCP client are doubles.
"""

from __future__ import annotations

import logging
from contextlib import nullcontext
from dataclasses import dataclass
from types import SimpleNamespace
from typing import Any

import pytest

from sidecar.ai.config import RuntimeConfig
from sidecar.ai.context.builder import ContextBuilder
from sidecar.ai.mcp.models import MCPToolDescriptor
from sidecar.ai.routing.router import ChatRouter
from sidecar.ai.tools.models import GenerationResult, ToolCallRequest
from sidecar.protocol import API_VERSION, CHAT_SEND_METHOD
from sidecar.runtime import request_dispatch
from sidecar.runtime.turn_state import (
    TERMINAL_SUBCODE_DENIED_POLICY_DANGEROUS_TOOL,
    TURN_STATE_DENIED,
)

LOGGER = logging.getLogger("test.non_interactive_chat_send_approvals")


@dataclass(frozen=True)
class _Plan:
    result: GenerationResult


class _ScriptedEngine:
    def __init__(self, plans: list[_Plan]) -> None:
        self._plans = list(plans)
        self.requests: list[dict[str, Any]] = []
        self.supports_tool_calling = True

    def generate_with_tools(self, **kwargs: Any) -> GenerationResult:
        self.requests.append(kwargs)
        return self._next().result

    def stream_with_tools(self, **kwargs: Any):
        self.requests.append(kwargs)
        return self._next().result
        yield  # pragma: no cover - makes this a generator like the real engines

    def _next(self) -> _Plan:
        if not self._plans:
            return _Plan(GenerationResult(content="done", finish_reason="stop"))
        return self._plans.pop(0)

    def get_model_max_output_tokens(self) -> int | None:
        return None

    def get_model_context_length(self) -> int | None:
        return None


class _RecordingMCPClient:
    def __init__(self, descriptor: MCPToolDescriptor) -> None:
        self._descriptor = descriptor
        self.executions: list[tuple[str, dict[str, object]]] = []

    @property
    def available_tools(self) -> list[MCPToolDescriptor]:
        return [self._descriptor]

    def tool_descriptor(self, tool_name: str) -> MCPToolDescriptor | None:
        return self._descriptor if tool_name == self._descriptor.name else None

    def execute_tool(self, tool_name: str, arguments: dict[str, object], **_kwargs: Any) -> object:
        self.executions.append((tool_name, dict(arguments)))
        return SimpleNamespace(
            tool_name=tool_name, output=f"{tool_name} ran", success=True,
            content_type="text/plain", ui_payload=None, generated_artifacts=(),
            error_code=None, metadata={},
        )


def _descriptor(
    name: str, argument: str, family: str, *, side_effecting: bool = True,
) -> MCPToolDescriptor:
    return MCPToolDescriptor(
        name=name,
        description=f"{name} tool",
        input_schema={
            "type": "object",
            "properties": {argument: {"type": "string"}},
            "required": [argument],
        },
        side_effecting=side_effecting,
        server_name="tools",
        source_kind="builtin",
        tool_family=family,
    )


def _brain(router: ChatRouter, mcp_client: _RecordingMCPClient) -> Any:
    stack = SimpleNamespace(
        raw_config={}, secrets={}, config=router._config, router=router,
        engine=router._engine, context_builder=router._context_builder,
        mcp_client=mcp_client, memory_store=None, tool_observations=None,
        turn_diagnostics=None,
    )
    return SimpleNamespace(
        stack=stack, subprocess_manager=None,
        request_boundary=lambda *_args, **_kwargs: nullcontext(),
    )


def _send(brain: Any, **extra_params: Any) -> dict[str, Any]:
    outcome = request_dispatch.process_message(
        {
            "jsonrpc": "2.0", "id": 41, "method": CHAT_SEND_METHOD,
            "params": {
                "accept_version": API_VERSION, "request_id": "req-non-interactive",
                "session_id": "session-non-interactive", "mode": "assist",
                "messages": [{"role": "user", "content": "go"}],
                **extra_params,
            },
        },
        True,
        brain_container=brain,
        logger=LOGGER,
        write_message=lambda _message: None,
        read_message=lambda: pytest.fail("non-interactive chat.send must not read a reply"),
    )
    assert outcome.response is not None
    return outcome.response


def _router(config: RuntimeConfig, call: ToolCallRequest, descriptor: MCPToolDescriptor):
    engine = _ScriptedEngine([
        _Plan(GenerationResult(content="", finish_reason="tool_calls", tool_calls=(call,))),
    ])
    mcp_client = _RecordingMCPClient(descriptor)
    router = ChatRouter(
        config=config, engine=engine, mcp_client=mcp_client,
        context_builder=ContextBuilder(None),
    )
    router.set_harness_snapshot_provider(lambda **_kwargs: {"tools": {"items": [
        {"name": descriptor.name, "display_name": descriptor.name, "enabled": True},
    ]}})
    return router, mcp_client


def test_non_interactive_chat_send_does_not_run_python_without_approval(tmp_path) -> None:
    config = RuntimeConfig(
        engine_type="ollama", model="qwen", mode="assist",
        feature_flags={"auto_checkpoint": False},
        tools_workspace_root=str(tmp_path), tools_python_runtime_enabled=True,
    )
    router, mcp_client = _router(
        config,
        ToolCallRequest(tool_id="python_execute", arguments={"code": "print(1)"},
                        call_id="call-python"),
        _descriptor("python_execute", "code", "python"),
    )

    response = _send(_brain(router, mcp_client))

    assert mcp_client.executions == []
    assert response["result"]["status"] == TURN_STATE_DENIED
    assert response["result"]["terminal_subcode"] == TERMINAL_SUBCODE_DENIED_POLICY_DANGEROUS_TOOL


def test_non_interactive_chat_send_honours_paranoid_mode_for_shell(tmp_path) -> None:
    config = RuntimeConfig(
        engine_type="ollama", model="qwen", mode="assist",
        feature_flags={"auto_checkpoint": False},
        tools_workspace_root=str(tmp_path), tools_shell_enabled=True,
    )
    router, mcp_client = _router(
        config,
        ToolCallRequest(tool_id="run_command", arguments={"command": "del x"},
                        call_id="call-shell"),
        _descriptor("run_command", "command", "shell"),
    )

    response = _send(_brain(router, mcp_client), safety_mode="paranoid")

    assert mcp_client.executions == []
    assert response["result"]["status"] == TURN_STATE_DENIED
    assert response["result"]["terminal_subcode"] == TERMINAL_SUBCODE_DENIED_POLICY_DANGEROUS_TOOL


def test_non_interactive_chat_send_still_runs_read_only_tools(tmp_path) -> None:
    config = RuntimeConfig(
        engine_type="ollama", model="qwen", mode="assist",
        feature_flags={"auto_checkpoint": False},
        tools_workspace_root=str(tmp_path),
    )
    router, mcp_client = _router(
        config,
        ToolCallRequest(tool_id="read_file", arguments={"path": "notes.txt"},
                        call_id="call-read"),
        _descriptor("read_file", "path", "filesystem", side_effecting=False),
    )

    response = _send(_brain(router, mcp_client))

    assert [name for name, _arguments in mcp_client.executions] == ["read_file"]
    assert response["result"]["status"] == "completed"
