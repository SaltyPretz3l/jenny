"""Focused hosted execution-policy tests.

These probes cover the config/argv/assembly seams and the real builtin MCP
offer/dispatch boundary without launching a sidecar or network process.
"""

from __future__ import annotations

from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

import pytest

from sidecar.ai.config import parse_runtime_config
from sidecar.ai.config_models import MCPServerConfig
from sidecar.ai.container_mcp_servers import _default_mcp_servers
from sidecar.ai.context.builder import WorkspaceStatus
from sidecar.ai.host_policy import (
    HOST_ALLOWED_TOOL_NAMES,
    HOST_EXECUTION_POLICY_VERSION,
    HostPolicyError,
    host_tool_requires_one_off_approval,
)
from sidecar.ai.mcp import builtin_server
from sidecar.ai.routing.route_policy_runtime import hosted_approval_request
from sidecar.ai.routing.router import ApprovalRequest
from sidecar.ai.routing.tool_resolution import _electron_bridge_runtime_descriptors
from sidecar.ai.tools.assembly import ToolAssemblyContext, assemble_tool_contract
from sidecar.ai.tools.contracts import ToolExecutionFailure, validate_tool_arguments
from sidecar.ai.tools.registry import build_default_registry
from sidecar.ai.tools.workspace import WorkspaceGuard
from sidecar.runtime.capabilities import initialize_response
from sidecar.runtime.tool_execution_support import ToolCallRequest


def _host_config(
    *,
    version: int = 1,
    worker: bool = False,
    shell: bool = False,
    workspace: str | None = None,
) -> dict[str, object]:
    return {
        "host_mode": "server",
        "host_execution_policy_version": version,
        "host_execution_worker_enabled": worker,
        "electron_tool_bridge_enabled": True,
        "tools_shell_enabled": shell,
        "tools_workspace_root": workspace,
    }


def test_desktop_config_remains_the_default() -> None:
    config = parse_runtime_config({})

    assert config.host_mode == "desktop"
    assert config.host_execution_policy_version is None
    assert "read_file" in build_default_registry(config=config)


@pytest.mark.parametrize(
    "raw",
    [
        {"host_mode": "server"},
        {"host_mode": "server", "host_execution_policy_version": 3},
        {"host_mode": "desktop", "host_execution_policy_version": 3},
        {"host_mode": "unknown", "host_execution_policy_version": 1},
        {"host_mode": 1, "host_execution_policy_version": 1},
        {"host_mode": "server", "host_execution_policy_version": True},
    ],
)
def test_unknown_or_incomplete_host_declarations_are_rejected(raw: dict[str, object]) -> None:
    with pytest.raises(HostPolicyError):
        parse_runtime_config(raw)


def test_server_config_forces_one_call_approval_and_keeps_allowlist_closed() -> None:
    config = parse_runtime_config(
        {
            **_host_config(version=1),
            "tools_confirm_side_effects": False,
            "tools_shell_enabled": True,
            "tools_web_enabled": True,
            "tools_lsp_enabled": True,
            "tools_python_runtime_enabled": True,
            "tools_delete_file_enabled": True,
            "tools_move_file_enabled": True,
        }
    )

    registry = build_default_registry(config=config)
    assert set(registry) <= HOST_ALLOWED_TOOL_NAMES
    assert {"run_command", "run_temp_script", "delete_file", "move_file"}.isdisjoint(registry)
    assert config.tools_confirm_side_effects is True
    assert host_tool_requires_one_off_approval("write_file") is True


def test_server_builtin_tools_list_is_closed_and_dispatch_rejects_forged_tool(
    tmp_path: Path,
) -> None:
    allowed_tools = builtin_server._default_tools(  # noqa: SLF001
        host_mode="server",
        host_execution_policy_version=HOST_EXECUTION_POLICY_VERSION,
        workspace_root_present=True,
        mermaid_enabled=True,
    )
    forged_calls: list[str] = []

    def forged_handler(_arguments, _workspace):
        forged_calls.append("executed")
        raise AssertionError("host policy must reject before handler dispatch")

    allowed_tools["run_command"] = builtin_server.BuiltinTool(
        name="run_command",
        description="forged",
        side_effecting=False,
        input_schema={"type": "object", "properties": {}},
        handler=forged_handler,
    )
    host_config = _host_config()
    list_response = builtin_server._dispatch_message(  # noqa: SLF001
        {"id": 1, "method": "tools/list"},
        allowed_tools,
        WorkspaceGuard(str(tmp_path)),
        host_config,
    )
    listed = {item["name"] for item in list_response["result"]["tools"]}
    assert "run_command" not in listed
    assert {"read_file", "list_dir", "write_file", "edit_file"} <= listed

    call_response = builtin_server._dispatch_message(  # noqa: SLF001
        {
            "id": 2,
            "method": "tools/call",
            "params": {"name": "run_command", "arguments": {}},
        },
        allowed_tools,
        WorkspaceGuard(str(tmp_path)),
        host_config,
    )
    assert call_response["error"]["data"]["code"] == "CMP-MCP-0003"
    assert forged_calls == []


def test_host_policy_is_carried_through_builtin_argv_and_drops_custom_mcp() -> None:
    config = replace(
        parse_runtime_config(_host_config()),
        mcp_servers=(
            MCPServerConfig(
                name="untrusted",
                transport="sse",
                url="https://mcp.example.test",
            ),
        ),
    )

    servers = _default_mcp_servers(config, Path("workspace"))
    assert len(servers) == 1
    args = servers[0].args
    assert args[args.index("--host-mode") : args.index("--host-mode") + 4] == (
        "--host-mode",
        "server",
        "--host-execution-policy-version",
        "1",
    )
    assert "untrusted" not in args


class _InitializeContainer:
    def __init__(self, config):
        self.config = config

    def configure(self, _raw_config, *, secrets=None, progress_callback=None):
        del secrets, progress_callback
        return SimpleNamespace(
            config=self.config,
            engine=SimpleNamespace(
                capabilities={"text": True},
                get_model_context_length=lambda: None,
            ),
            router=SimpleNamespace(available_tools=[], tools_status={}),
            mcp_client=SimpleNamespace(
                diagnostics=lambda: SimpleNamespace(connected=(), failures=())
            ),
            context_builder=SimpleNamespace(
                workspace_status=lambda: WorkspaceStatus(
                    root=None,
                    exists=False,
                    skills_loaded=0,
                    bootstrap_loaded=0,
                    instruction_file_name=None,
                    instruction_file_present=False,
                )
            ),
            memory_store=SimpleNamespace(db_path=":memory:", journal_mode="wal"),
            engine_fallback_from=None,
            engine_fallback_reason=None,
            secrets={},
        )


def test_initialize_ack_contains_policy_version_only_when_server_is_enforced() -> None:
    server_config = parse_runtime_config(_host_config(version=1))
    server_response = initialize_response(
        1,
        {"config": _host_config(version=1)},
        api_version="2026-03-06",
        brain_container=_InitializeContainer(server_config),
    )
    assert server_response["result"]["host_execution_policy_version"] == 1

    desktop_config = parse_runtime_config({})
    desktop_response = initialize_response(
        2,
        {"config": {}},
        api_version="2026-03-06",
        brain_container=_InitializeContainer(desktop_config),
    )
    assert "host_execution_policy_version" not in desktop_response["result"]


def test_policy_v2_ack_and_bridge_descriptor_require_ready_worker() -> None:
    raw = _host_config(version=2, worker=True, shell=True, workspace="/workspace")
    config = parse_runtime_config(raw)
    server_response = initialize_response(
        3,
        {"config": raw},
        api_version="2026-03-06",
        brain_container=_InitializeContainer(config),
    )
    assert server_response["result"]["host_execution_policy_version"] == 2
    assert server_response["result"]["host_execution_worker_enabled"] is True

    descriptors = _electron_bridge_runtime_descriptors(config)
    run_command = next(item for item in descriptors if item.name == "run_command")
    assert run_command.server_name == "electron_tool_bridge"

    catalog = builtin_server.build_tool_catalog(
        config=config,
        runtime_descriptors=descriptors,
    )
    descriptor = next(item for item in catalog if item.name == "run_command")
    assert descriptor.server_name == "electron_tool_bridge"
    assert "run_in_background" not in descriptor.input_schema["properties"]
    assert descriptor.input_schema["properties"]["timeout_seconds"]["maximum"] == 120


def test_policy_v2_run_command_is_available_on_main_but_read_only_is_closed() -> None:
    config = parse_runtime_config(
        _host_config(version=2, worker=True, shell=True, workspace="/workspace")
    )
    descriptors = builtin_server.build_tool_catalog(
        config=config,
        runtime_descriptors=_electron_bridge_runtime_descriptors(config),
    )
    descriptor = next(item for item in descriptors if item.name == "run_command")
    main = assemble_tool_contract(
        descriptors,
        ToolAssemblyContext(
            surface="managed_sidecar",
            config=config,
            mode="assist",
            read_only=False,
            workspace_root_present=True,
            enforce_mode_policy=False,
            enforce_request_preferences=False,
        ),
    )
    readonly = assemble_tool_contract(
        descriptors,
        ToolAssemblyContext(
            surface="managed_sidecar",
            config=config,
            mode="assist",
            read_only=True,
            workspace_root_present=True,
            enforce_mode_policy=False,
            enforce_request_preferences=False,
        ),
    )
    assert next(item for item in main.entries if item.descriptor.name == descriptor.name).available
    assert (
        next(item for item in readonly.entries if item.descriptor.name == descriptor.name).available
        is False
    )


def test_policy_v2_requires_one_off_approval_even_when_pregranted() -> None:
    config = _host_config(version=2, worker=True, shell=True, workspace="/workspace")
    descriptor = SimpleNamespace(name="run_command", side_effecting=True)
    call = ToolCallRequest(
        tool_id="run_command",
        arguments={"command": "printf ok"},
        call_id="call-worker",
    )
    approval = hosted_approval_request(
        config,
        True,
        ApprovalRequest,
        call,
        descriptor,
        "assist",
    )
    assert approval is not None
    assert approval.tool_name == "run_command"
    assert "one-off" in approval.reason


def test_policy_v2_builtin_direct_dispatch_is_rejected_before_handler(tmp_path: Path) -> None:
    called = []

    def forged_handler(_arguments, _workspace):
        called.append(True)
        raise AssertionError("hosted v2 must never invoke the sidecar shell handler")

    tools = {
        "run_command": builtin_server.BuiltinTool(
            name="run_command",
            description="forged",
            side_effecting=True,
            input_schema={"type": "object", "properties": {"command": {"type": "string"}}},
            handler=forged_handler,
        )
    }
    response = builtin_server._dispatch_message(  # noqa: SLF001
        {
            "id": 4,
            "method": "tools/call",
            "params": {"name": "run_command", "arguments": {"command": "printf ok"}},
        },
        tools,
        WorkspaceGuard(str(tmp_path)),
        _host_config(version=2, worker=True, shell=True, workspace=str(tmp_path)),
    )
    assert response["error"]["data"]["code"] == "CMP-TOOL-0002"
    assert called == []


def test_hosted_approval_schema_rejects_malformed_command_before_approval():

    config = parse_runtime_config(
        _host_config(version=2, worker=True, shell=True, workspace="/workspace")
    )
    schema = next(
        item.input_schema
        for item in builtin_server.build_tool_catalog(config=config)
        if item.name == "run_command"
    )
    for arguments in (
        {"command": "echo hi", "expected_exit_codes": [256]},
        {"command": "echo hi", "cwd": "../escape"},
        {"command": "echo hi", "cwd": "x/" * 33 + "z"},
        {"command": "echo hi", "extra": True},
    ):
        with pytest.raises(ToolExecutionFailure):
            validate_tool_arguments(
                tool_name="run_command", arguments=arguments, input_schema=schema
            )
