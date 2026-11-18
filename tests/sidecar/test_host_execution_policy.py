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
    HOST_ALLOWED_RPC_METHODS,
    HOST_ALLOWED_TOOL_NAMES,
    HOST_EXECUTION_POLICY_VERSION,
    HostPolicyError,
    host_tool_decision,
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
    allowed_tools = builtin_server._default_tools(
        {
            "host_mode": "server",
            "host_execution_policy_version": HOST_EXECUTION_POLICY_VERSION,
        },
        workspace_root_present=True,
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
    list_response = builtin_server._dispatch_message(
        {"id": 1, "method": "tools/list"},
        allowed_tools,
        WorkspaceGuard(str(tmp_path)),
        host_config,
    )
    listed = {item["name"] for item in list_response["result"]["tools"]}
    assert "run_command" not in listed
    assert {"read_file", "list_dir", "write_file", "edit_file"} <= listed

    call_response = builtin_server._dispatch_message(
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


def test_next_step_card_tool_is_denied_in_hosted_mode() -> None:
    raw = {**_host_config(version=1), "tools_next_step_enabled": True}
    config = parse_runtime_config(raw)

    assert "suggest_next_step" not in HOST_ALLOWED_TOOL_NAMES
    assert host_tool_decision("suggest_next_step", config)[0] is False
    assert all(
        item.name != "suggest_next_step"
        for item in _electron_bridge_runtime_descriptors(config)
        if host_tool_decision(item, config)[0]
    )


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
    response = builtin_server._dispatch_message(
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


def test_hosted_memory_rpc_allowlist_is_read_only() -> None:
    """Hosted memory stays fail-closed: reads only, no v2 write or lifecycle method."""
    memory_methods = {m for m in HOST_ALLOWED_RPC_METHODS if m.startswith("memory.")}
    assert memory_methods == {"memory.status", "memory.list", "memory.recall"}


def test_app_guide_tool_is_allowed_and_offered_in_full_in_hosted_mode() -> None:
    # A host offers no tool_search, so an always-deferred tool could never be loaded
    # there: the one allowed Electron tool that is deferred on desktop comes in full.
    from sidecar.ai.mode_policy import MODE_ASSIST
    from sidecar.ai.tools.catalog import MANAGED_SIDECAR_SURFACE, build_tool_catalog
    from sidecar.ai.tools.tool_search import ToolResolutionContext, build_search_index

    config = parse_runtime_config(_host_config(version=1))
    bridge = [
        item for item in _electron_bridge_runtime_descriptors(config)
        if host_tool_decision(item, config)[0]
    ]
    assert sorted(item.name for item in bridge) == ["ask_user", "exit_plan_mode", "jenny_help"]
    assert host_tool_decision("jenny_status", config)[0] is False

    catalog = build_tool_catalog(config=config, runtime_descriptors=bridge)
    help_tool = next(item for item in catalog if item.name == "jenny_help")
    assert help_tool.availability.defer_eligible is True
    deferred = frozenset({"jenny_help"})

    def assemble(raw_config: object):
        return assemble_tool_contract(
            catalog,
            ToolAssemblyContext(
                surface=MANAGED_SIDECAR_SURFACE,
                config=raw_config,
                engine_supports_tool_calling=True,
                mode=MODE_ASSIST,
                plan_mode=False,
                resolution_context=ToolResolutionContext(
                    deferred_names=deferred,
                    un_deferred_names=set(),
                    search_index=build_search_index(deferred, (help_tool,)),
                ),
                workspace_root_present=False,
                include_deferred_tools=True,
            ),
        ).entry("jenny_help")

    hosted = assemble(config)
    assert hosted.available is True
    assert hosted.deferred is False
    assert assemble({}).deferred is True

    # Context pressure still hides a tool on a host: the budget filter is not deferral.
    filtered = ToolResolutionContext(
        deferred_names=deferred,
        un_deferred_names=set(),
        search_index=build_search_index(deferred, (help_tool,)),
    )
    filtered.budget_filtered_names = deferred
    pressed = assemble_tool_contract(
        catalog,
        ToolAssemblyContext(
            surface=MANAGED_SIDECAR_SURFACE, config=config, engine_supports_tool_calling=True,
            mode=MODE_ASSIST, plan_mode=False, resolution_context=filtered,
            workspace_root_present=False, include_deferred_tools=True,
        ),
    ).entry("jenny_help")
    assert pressed.deferred is True


# --- A team host's root boundary (row 123, team host file tools) ---

_BOUNDARY = str(Path(__file__).resolve().parent / "projects-boundary")
_TEAM_HOST_TOOLS = frozenset({"read_file", "list_dir", "glob_files", "grep_search", "write_file",
                              "edit_file", "jenny_help", "ask_user", "exit_plan_mode"})


def _team_config(**extra: object) -> dict[str, object]:
    return {**_host_config(), "electron_state_root": str(Path(_BOUNDARY).parent / "profile"),
            "hosted_root_boundary": _BOUNDARY, **extra}


def test_a_team_host_config_carries_the_boundary_and_the_windows_switch() -> None:
    config = parse_runtime_config(_team_config(hosted_win32_files=True))
    assert config.hosted_root_boundary == _BOUNDARY
    assert config.hosted_win32_files is True
    plain = parse_runtime_config(_host_config())
    assert plain.hosted_root_boundary is None and plain.hosted_win32_files is False


@pytest.mark.parametrize("raw", [
    {"hosted_root_boundary": _BOUNDARY},
    {"hosted_win32_files": True},
    {"host_mode": "desktop", "hosted_root_boundary": _BOUNDARY},
    {**_host_config(), "hosted_win32_files": True},
    {**_host_config(), "hosted_root_boundary": "relative/projects"},
    {**_host_config(), "hosted_root_boundary": ""},
    {**_host_config(), "hosted_root_boundary": 7},
    {**_host_config(workspace=_BOUNDARY), "hosted_root_boundary": _BOUNDARY},
    {**_team_config(), "hosted_win32_files": "yes"},
], ids=["desktop-boundary", "desktop-switch", "explicit-desktop", "switch-without-boundary",
        "relative", "empty", "not-a-string", "with-a-workspace-root", "switch-not-a-bool"])
def test_the_boundary_and_switch_are_refused_outside_a_rootless_server_host(
    raw: dict[str, object],
) -> None:
    with pytest.raises(HostPolicyError):
        parse_runtime_config(raw)


def _arg(args: tuple[str, ...], flag: str) -> str:
    return args[args.index(flag) + 1]


def test_a_team_host_worker_gets_the_boundary_and_no_store_outside_the_folder() -> None:
    config = parse_runtime_config(_team_config(hosted_win32_files=True))
    [server] = _default_mcp_servers(config, None)
    args = tuple(server.args)
    assert _arg(args, "--workspace-root") == ""
    assert _arg(args, "--hosted-root-boundary") == _BOUNDARY
    assert "--hosted-win32-files" in args
    assert _arg(args, "--pre-change-snapshot-root") == ""
    assert _arg(args, "--workspace-recovery-root") == ""


def test_a_boundary_forces_redacted_diagnostics_for_the_worker_and_the_sidecar() -> None:
    config = parse_runtime_config(_team_config(diagnostics_capture_mode="sanitized_snippets"))
    assert config.diagnostics_capture_mode == "redacted"
    [server] = _default_mcp_servers(config, None)
    assert _arg(tuple(server.args), "--diagnostics-capture-mode") == "redacted"
    plain = parse_runtime_config({**_host_config(), "diagnostics_capture_mode": "sanitized_snippets"})
    assert plain.diagnostics_capture_mode == "sanitized_snippets", "single owner unchanged"


def test_the_windows_switch_is_sent_only_when_on() -> None:
    [server] = _default_mcp_servers(parse_runtime_config(_team_config()), None)
    assert "--hosted-win32-files" not in server.args
    assert _arg(tuple(server.args), "--hosted-root-boundary") == _BOUNDARY


def test_without_a_boundary_the_worker_arguments_are_unchanged() -> None:
    config = parse_runtime_config({**_host_config(), "electron_state_root": "/profile"})
    [server] = _default_mcp_servers(config, Path("workspace"))
    args = tuple(server.args)
    assert "--hosted-root-boundary" not in args and "--hosted-win32-files" not in args
    assert _arg(args, "--pre-change-snapshot-root").endswith("workspace-snapshots")
    assert _arg(args, "--workspace-recovery-root") != ""


def test_a_boundary_narrows_the_hosted_tool_set_to_the_named_nine() -> None:
    team = {**_host_config(), "hosted_root_boundary": _BOUNDARY}
    for name in sorted(HOST_ALLOWED_TOOL_NAMES | {"run_command", "delegate"}):
        allowed = host_tool_decision(name, team)[0]
        assert allowed is (name in _TEAM_HOST_TOOLS), name
    assert host_tool_decision("create_artifact", _host_config())[0] is True, "single owner"
    v2_team = {**_host_config(version=2, worker=True, shell=True, workspace=None),
               "hosted_root_boundary": _BOUNDARY}
    assert host_tool_decision("run_command", v2_team)[0] is False


def _initialize_with_hosted_files(config, answer):
    container = _InitializeContainer(config)
    real_configure = container.configure

    def configure(raw_config, **kwargs):
        stack = real_configure(raw_config, **kwargs)
        stack.mcp_client.server_hosted_files = lambda name: (
            answer if name == builtin_server_name() else None)
        return stack

    container.configure = configure
    return initialize_response(1, {"config": {}}, api_version="2026-03-06",
                               brain_container=container)["result"]


def builtin_server_name() -> str:
    from sidecar.ai.tools.catalog import BUILTIN_MCP_SERVER_NAME

    return BUILTIN_MCP_SERVER_NAME


def test_initialize_reports_the_workers_hosted_files_state_on_a_team_host() -> None:
    team = parse_runtime_config(_team_config())
    assert _initialize_with_hosted_files(team, {"available": True, "reason": None})[
        "hosted_files"] == {"available": True, "reason": None}
    assert _initialize_with_hosted_files(
        team, {"available": False, "reason": "file_access_switch_off"})["hosted_files"] == {
        "available": False, "reason": "file_access_switch_off"}
    assert _initialize_with_hosted_files(team, None)["hosted_files"] == {
        "available": False, "reason": None}, "no answer from the worker is not available"
    assert "hosted_files" not in _initialize_with_hosted_files(
        parse_runtime_config(_host_config()), {"available": True, "reason": None})
