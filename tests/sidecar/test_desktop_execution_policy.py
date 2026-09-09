"""Focused desktop command-sandbox policy regressions."""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest

from sidecar.ai.config import parse_runtime_config
from sidecar.ai.container import BrainContainer
from sidecar.ai.container_mcp_servers import _default_mcp_servers
from sidecar.ai.execution_policy import (
    DESKTOP_EXECUTION_POLICY_VERSION,
    DESKTOP_SANDBOX_ALLOWED_TOOL_NAMES,
    DesktopExecutionPolicyError,
    container_desktop_execution_policy_is_enforced,
    desktop_tool_decision,
)
from sidecar.ai.mcp import builtin_server
from sidecar.ai.routing import tool_execution
from sidecar.ai.routing.tool_resolution import _electron_bridge_runtime_descriptors
from sidecar.ai.tools.catalog import build_tool_catalog
from sidecar.ai.tools.models import ToolCallRequest
from sidecar.ai.tools.registry import build_default_registry
from sidecar.ai.tools.workspace import WorkspaceGuard
from sidecar.runtime.capabilities import initialize_response


def _sandbox_config() -> dict[str, object]:
    return {
        "desktop_execution_policy_version": DESKTOP_EXECUTION_POLICY_VERSION,
        "engine_type": "mock",
    }


def test_desktop_policy_is_optional_and_strict_when_declared() -> None:
    config = parse_runtime_config({})
    assert config.host_mode == "desktop"
    assert config.desktop_execution_policy_version is None
    assert (
        parse_runtime_config({"desktop_execution_policy_version": None})
        .desktop_execution_policy_version
        is None
    )

    sandbox = parse_runtime_config(_sandbox_config())
    assert sandbox.host_mode == "desktop"
    assert sandbox.desktop_execution_policy_version == 1
    assert sandbox.tools_shell_enabled is True
    assert sandbox.tools_python_runtime_enabled is False
    assert sandbox.tools_lsp_enabled is False
    assert sandbox.tools_verify_enabled is False
    assert sandbox.tools_worktree_enabled is False
    assert sandbox.feature_flags == {
        "auto_checkpoint": False,
        "verification_gate": False,
        "git_tracking": False,
    }

    for invalid in (True, "1", 2, 0):
        with pytest.raises(DesktopExecutionPolicyError):
            parse_runtime_config({"desktop_execution_policy_version": invalid})


def test_sandbox_rejects_provider_engine_before_fallback(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "sidecar.ai.container.create_engine",
        lambda *_args, **_kwargs: pytest.fail("sandbox selected a provider fallback"),
    )
    with pytest.raises(DesktopExecutionPolicyError, match="engine is not supported"):
        BrainContainer().configure(_sandbox_config() | {"engine_type": "codex-cli"})


def test_sandbox_tool_allowlist_matches_typed_files_and_bridge() -> None:
    config = parse_runtime_config(_sandbox_config())
    allowed = {
        "read_file",
        "write_file",
        "edit_file",
        "glob_files",
        "grep_search",
        "list_dir",
        "create_artifact",
        "mermaid_generate",
        "ask_user",
        "exit_plan_mode",
        "run_command",
    }
    assert DESKTOP_SANDBOX_ALLOWED_TOOL_NAMES == frozenset(allowed)

    for name in allowed - {"ask_user", "exit_plan_mode", "run_command"}:
        assert desktop_tool_decision(name, config)[0] is True
    for name in ("python_execute", "run_temp_script", "monitor", "git_status", "lsp"):
        assert desktop_tool_decision(name, config)[0] is False
    assert desktop_tool_decision(
        SimpleNamespace(
            name="run_command",
            source_kind="builtin",
            server_name="jenny_local_tools",
        ),
        config,
    )[0] is False
    assert desktop_tool_decision(
        SimpleNamespace(
            name="run_command",
            source_kind="builtin",
            server_name="electron_tool_bridge",
        ),
        config,
    )[0] is True

    catalog = build_tool_catalog(
        config=config,
        runtime_descriptors=(
            SimpleNamespace(
                name="third_party_exec",
                source_kind="mcp",
                server_name="untrusted_mcp",
            ),
            SimpleNamespace(
                name="run_command",
                source_kind="builtin",
                server_name="electron_tool_bridge",
            ),
        ),
    )
    catalog_names = {descriptor.name for descriptor in catalog}
    assert "third_party_exec" not in catalog_names
    assert "run_command" in catalog_names


def test_sandbox_registry_and_builtin_mcp_never_register_local_command(tmp_path: Path) -> None:
    config = parse_runtime_config(_sandbox_config() | {"tools_workspace_root": str(tmp_path)})
    registry = build_default_registry(config=config)
    assert "run_command" not in registry
    assert {"read_file", "write_file", "edit_file"} <= set(registry)

    servers = _default_mcp_servers(config, tmp_path)
    assert len(servers) == 1
    args = servers[0].args
    assert args[args.index("--desktop-execution-policy-version") : args.index(
        "--desktop-execution-policy-version"
    ) + 2] == ("--desktop-execution-policy-version", "1")
    assert args[args.index("--shell-enabled") : args.index("--shell-enabled") + 2] == (
        "--shell-enabled",
        "0",
    )

    tools = builtin_server._default_tools(  # noqa: SLF001
        desktop_execution_policy_version=1,
        workspace_root_present=True,
        shell_enabled=True,
        mermaid_enabled=True,
    )
    assert "run_command" not in tools
    tools["run_command"] = builtin_server.BuiltinTool(
        name="run_command",
        description="forged",
        side_effecting=True,
        input_schema={"type": "object", "properties": {}},
        handler=lambda *_args: pytest.fail("sandbox command escaped builtin MCP"),
    )
    response = builtin_server._dispatch_message(  # noqa: SLF001
        {
            "id": 1,
            "method": "tools/call",
            "params": {"name": "run_command", "arguments": {}},
        },
        tools,
        WorkspaceGuard(str(tmp_path)),
        {
            "host_mode": "desktop",
            "desktop_execution_policy_version": 1,
        },
    )
    assert response["error"]["data"]["code"] == "CMP-MCP-0003"


def test_policy_latch_fails_closed_without_or_across_replaced_stack() -> None:
    assert container_desktop_execution_policy_is_enforced(SimpleNamespace()) is True
    container = BrainContainer()
    assert container_desktop_execution_policy_is_enforced(container) is True
    container.latch_desktop_execution_policy(_sandbox_config())
    assert container.desktop_execution_policy_enforced is True
    assert container_desktop_execution_policy_is_enforced(container) is True
    container.latch_desktop_execution_policy({})
    assert container_desktop_execution_policy_is_enforced(container) is True

    with pytest.raises(DesktopExecutionPolicyError):
        container.latch_desktop_execution_policy({"desktop_execution_policy_version": 2})
    assert container_desktop_execution_policy_is_enforced(container) is True


def test_capabilities_acknowledges_desktop_policy_version() -> None:
    config = parse_runtime_config(_sandbox_config())
    stack = SimpleNamespace(
        config=config,
        engine=SimpleNamespace(capabilities={"text": True}, get_model_context_length=lambda: None),
        router=SimpleNamespace(available_tools=[], tools_status={}),
        mcp_client=SimpleNamespace(diagnostics=lambda: SimpleNamespace(connected=(), failures=())),
        context_builder=SimpleNamespace(
            workspace_status=lambda: SimpleNamespace(
                root=None,
                exists=False,
                skills_loaded=0,
                bootstrap_loaded=False,
                instruction_file_name=None,
                instruction_file_present=False,
            )
        ),
        memory_store=SimpleNamespace(db_path=":memory:"),
        engine_fallback_from=None,
        engine_fallback_reason=None,
        secrets={},
    )
    response = initialize_response(
        1,
        {"config": _sandbox_config()},
        api_version="2026-03-06",
        brain_container=SimpleNamespace(
            stack=stack,
            configure=lambda *_args, **_kwargs: stack,
        ),
    )
    assert response["result"]["desktop_execution_policy_version"] == 1


def test_sandbox_catalog_describes_only_disposable_linux_foreground_commands() -> None:

    config = parse_runtime_config(_sandbox_config())
    descriptors = build_tool_catalog(config=config, runtime_descriptors=_electron_bridge_runtime_descriptors(config))
    command = next(item for item in descriptors if item.name == "run_command")
    assert "POSIX /bin/sh" in command.description
    assert "discarded" in command.description
    assert "run_in_background" not in command.input_schema["properties"]
    assert command.input_schema["additionalProperties"] is False
    assert command.input_schema["properties"]["timeout_seconds"]["maximum"] == 120


def test_sandbox_disables_repository_resume_git_subprocesses() -> None:
    config = parse_runtime_config({**_sandbox_config(), "repo_delta_resume_enabled": True})
    assert config.repo_delta_resume_enabled is False


def test_sandbox_dispatch_keeps_private_attribution_out_of_command_arguments(monkeypatch) -> None:

    captured = []
    monkeypatch.setattr(tool_execution, "execute_electron_tool", captured.append)
    arguments = {"command": "printf test", "cwd": ".", "_jenny_session_id": "private",
                 "_jenny_turn_id": "turn", "_jenny_tool_call_id": "call"}
    tool_execution._dispatch_tool_call(
        kernel=SimpleNamespace(_config=parse_runtime_config(_sandbox_config())),
        call=ToolCallRequest(tool_id="run_command", arguments={}, call_id="call"),
        tool_arguments=arguments, descriptor=SimpleNamespace(server_name="electron_tool_bridge"),
        request_id="request", session_id="canonical-session", runtime=None,
        timeout_seconds=120, cancel_handle=None,
    )
    assert captured[0].arguments == {"command": "printf test", "cwd": "."}
    assert captured[0].session_id == "canonical-session"
    assert captured[0].tool_call_id == "call"
    assert arguments["_jenny_session_id"] == "private"
