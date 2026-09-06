from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from sidecar.ai.config import RuntimeConfig
from sidecar.ai.mcp import client_support
from sidecar.ai.routing.tool_execution import execute_tool
from sidecar.ai.routing.tool_resolution import assemble_tool_contract
from sidecar.ai.tools.catalog import infer_tool_family, infer_tool_source_kind
from sidecar.ai.tools.models import ToolCallRequest
from sidecar.ai.tools.registry import build_default_registry, build_tool_bindings
from sidecar.ai.tools.tool_families import (
    requested_tool_families,
    tool_family_for_status,
)
from sidecar.runtime.chat_models import ChatRequestContext


def test_build_default_registry_excludes_shell_by_default(
    monkeypatch: pytest.MonkeyPatch,
) -> None:

    registry = build_default_registry(config=None)

    assert "run_command" not in registry
    assert "glob_files" in registry
    assert "grep_search" in registry
    assert "edit_file" in registry
    assert "git_diff" in registry
    assert "git_show" in registry
    assert "workspace_change_baseline" in registry
    assert "workspace_change_delta" in registry


def test_request_lockdown_drops_web_mcp_and_plugin_tools_without_cross_session_leak(
    tmp_path: Path,
) -> None:
    def descriptor(name: str, server_name: str, source_kind: str) -> SimpleNamespace:
        return SimpleNamespace(
            name=name,
            description=name,
            input_schema={"type": "object", "properties": {}},
            side_effecting=False,
            source_kind=source_kind,
            tool_family="web" if name == "web_search" else "other",
            server_name=server_name,
            search_hint="",
        )

    web = descriptor("web_search", "jenny_local_tools", "builtin")
    mcp = descriptor("mcp_external_lookup", "external_server", "mcp")
    plugin = descriptor("plugin_native_lookup", "plugin_host", "plugin_native_mcp")
    kernel = SimpleNamespace(
        _config=RuntimeConfig(
            mode="assist",
            tools_workspace_root=str(tmp_path),
            tools_web_enabled=True,
        ),
        _mcp_client=SimpleNamespace(available_tools=[web, mcp]),
        _plugin_runtime_tool_provider=lambda: (plugin,),
        _engine=SimpleNamespace(
            supports_tool_calling=True,
            supports_inband_tool_calling=False,
        ),
    )
    locked_context = ChatRequestContext(
        request_id="locked",
        trace_id=None,
        session_id="session-locked",
        mode="assist",
        approvals_pre_granted=True,
        session_offline_lockdown=True,
        workspace_root_present=True,
        tool_preferences={
            "enabled_tools": ("read_file",),
            "disabled_tools": ("web_search",),
        },
    )
    unlocked_context = ChatRequestContext(
        request_id="unlocked",
        trace_id=None,
        session_id="session-unlocked",
        mode="assist",
        approvals_pre_granted=True,
        workspace_root_present=True,
    )

    locked = assemble_tool_contract(kernel, request_context=locked_context)
    unlocked = assemble_tool_contract(kernel, request_context=unlocked_context)

    assert "web_search" not in locked.available_names
    assert locked.entry("mcp_external_lookup").available is False
    assert locked.entry("mcp_external_lookup").reason == "request preference disabled"
    assert locked.entry("plugin_native_lookup").available is False
    assert locked.entry("plugin_native_lookup").reason == "request preference disabled"
    assert {"web_search", "mcp_external_lookup", "plugin_native_lookup"}.issubset(
        set(unlocked.available_names)
    )


def test_connections_dispatch_injects_request_local_lockdown_metadata(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    descriptor = SimpleNamespace(
        name="connections_list",
        input_schema={"type": "object", "properties": {}},
        side_effecting=False,
        server_name="jenny_local_tools",
        source_kind="builtin",
        tool_family="runtime",
    )
    captured: list[dict[str, object]] = []

    class Client:
        def tool_descriptor(self, _name: str) -> SimpleNamespace:
            return descriptor

        def execute_tool(self, _name: str, arguments: dict[str, object], **_kwargs: object):
            captured.append(dict(arguments))
            return SimpleNamespace(
                tool_name="connections_list", output="connections", success=True,
                content_type="text", ui_payload=None, generated_artifacts=(),
                error_code=None, metadata={},
            )

    contract = SimpleNamespace(entry=lambda _name: SimpleNamespace(
        descriptor=descriptor, available=True, reason=None,
    ))
    kernel = SimpleNamespace(_config=RuntimeConfig(), _mcp_client=Client())
    monkeypatch.setattr(
        "sidecar.ai.routing.tool_execution.apply_tool_pressure_backoff",
        lambda **_kwargs: None,
    )

    for locked in (True, False):
        runtime = SimpleNamespace(
            cancel_handle=None,
            trace_id="trace-connections",
            request_context=SimpleNamespace(
                plan_mode=False, read_only=False, approved_plan=None,
                session_offline_lockdown=locked,
            ),
            raise_if_interrupted=lambda: None,
            audit=lambda *_args, **_kwargs: None,
            remaining_wall_clock_seconds=lambda: None,
            tool_timeout_seconds=lambda configured: configured,
        )
        outcome = execute_tool(
            kernel,
            ToolCallRequest(tool_id="connections_list", arguments={}, call_id="call-1"),
            request_id="request-1",
            session_id="session-1",
            read_snapshot_cache={},
            tool_contract=contract,
            runtime=runtime,
        )
        assert outcome.success is True

    assert captured[0]["_jenny_session_offline_lockdown"] is True
    assert captured[1]["_jenny_session_offline_lockdown"] is False


def test_build_default_registry_excludes_mermaid_when_disabled(
    monkeypatch: pytest.MonkeyPatch,
) -> None:

    registry = build_default_registry(config={"tools_mermaid_enabled": False})

    assert "mermaid_generate" not in registry


def test_build_default_registry_includes_mermaid_when_enabled(
    monkeypatch: pytest.MonkeyPatch,
) -> None:

    registry = build_default_registry(config={"tools_mermaid_enabled": True})

    assert "mermaid_generate" in registry
    assert "prompt" in registry["mermaid_generate"].input_schema["properties"]


def test_build_default_registry_excludes_workspace_manifest_when_disabled() -> None:
    registry = build_default_registry(config={"tools_workspace_manifest_enabled": False})

    assert "workspace_manifest_read" not in registry


def test_build_default_registry_includes_workspace_manifest_when_enabled() -> None:
    registry = build_default_registry(config={"tools_workspace_manifest_enabled": True})

    assert "workspace_manifest_read" in registry
    assert registry["workspace_manifest_read"].input_schema["properties"] == {}


def test_build_default_registry_includes_shell_when_enabled_in_dict_config(
    monkeypatch: pytest.MonkeyPatch,
) -> None:

    registry = build_default_registry(config={"tools_shell_enabled": True})

    assert "run_command" in registry


def test_build_default_registry_includes_shell_when_enabled_in_object_config(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class _Config:
        tools_shell_enabled = True


    registry = build_default_registry(config=_Config())

    assert "run_command" in registry


def test_build_default_registry_include_shell_override_takes_precedence(
    monkeypatch: pytest.MonkeyPatch,
) -> None:

    registry = build_default_registry(
        config={"tools_shell_enabled": False},
        include_shell=True,
    )

    assert "run_command" in registry


def test_build_default_registry_includes_python_runtime_when_enabled_on_windows(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("sidecar.ai.tools.registry.sys.platform", "win32")

    registry = build_default_registry(config={"tools_python_runtime_enabled": True})

    assert "python_execute" in registry


def test_build_default_registry_excludes_python_runtime_when_not_supported(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("sidecar.ai.tools.registry.sys.platform", "linux")

    registry = build_default_registry(config={"tools_python_runtime_enabled": True})

    assert "python_execute" not in registry


def test_build_default_registry_can_disable_glob_and_grep(
    monkeypatch: pytest.MonkeyPatch,
) -> None:

    registry = build_default_registry(
        config={"tools_glob_enabled": False, "tools_grep_enabled": False}
    )

    assert "glob_files" not in registry
    assert "grep_search" not in registry


def test_build_default_registry_can_disable_edit_file(
    monkeypatch: pytest.MonkeyPatch,
) -> None:

    registry = build_default_registry(config={"tools_edit_file_enabled": False})

    assert "edit_file" not in registry


def test_build_default_registry_gates_lsp_tools() -> None:
    disabled = build_default_registry(config={"tools_lsp_enabled": False})
    enabled = build_default_registry(config={"tools_lsp_enabled": True})

    assert "lsp" not in disabled
    assert "lsp" in enabled
    assert enabled["lsp"].input_schema["required"] == ["action", "path"]
    assert "line" in enabled["lsp"].input_schema["properties"]
    assert "include_declaration" in enabled["lsp"].input_schema["properties"]
    assert enabled["lsp"].side_effecting is False


def test_build_default_registry_gates_knowledge_tools() -> None:
    knowledge_tools = ("knowledge_search", "knowledge_view", "knowledge_exec")
    default = build_default_registry(config={})
    disabled = build_default_registry(config={"tools_knowledge_enabled": False})
    enabled = build_default_registry(
        config={"tools_knowledge_enabled": True, "knowledge_roots": ()}
    )

    for tool_name in knowledge_tools:
        # Default-off: absent from the catalog the model sees.
        assert tool_name not in default
        assert tool_name not in disabled
        assert tool_name in enabled
        assert enabled[tool_name].side_effecting is False
    assert enabled["knowledge_search"].input_schema["required"] == ["pattern"]
    assert enabled["knowledge_view"].input_schema["required"] == ["path"]
    assert enabled["knowledge_exec"].input_schema["required"] == ["op"]


def test_knowledge_bindings_configure_roots_and_rich_adapters(tmp_path) -> None:
    from sidecar.ai.tools.builtins.knowledge import roots as knowledge_roots_module

    corpus = tmp_path / "corpus"
    corpus.mkdir()
    try:
        bindings = build_tool_bindings(
            config={
                "tools_knowledge_enabled": True,
                "knowledge_roots": (str(corpus),),
            }
        )

        assert "knowledge_search" in bindings
        assert "knowledge_view" in bindings
        assert "knowledge_exec" in bindings
        labels = [root.label for root in knowledge_roots_module.available_roots()]
        assert labels == ["corpus"]
        adapters = knowledge_roots_module.rich_adapters()
        assert set(adapters) == {
            "pdf",
            "document",
            "spreadsheet",
            "presentation",
            "notebook",
        }
    finally:
        knowledge_roots_module.configure_knowledge_tools(None)


def test_knowledge_bindings_absent_when_flag_off() -> None:
    from sidecar.ai.tools.builtins.knowledge import roots as knowledge_roots_module

    try:
        for config in ({}, {"tools_knowledge_enabled": False}):
            bindings = build_tool_bindings(config=config)
            assert "knowledge_search" not in bindings
            assert "knowledge_view" not in bindings
            assert "knowledge_exec" not in bindings
    finally:
        knowledge_roots_module.configure_knowledge_tools(None)


def test_build_default_registry_does_not_probe_lsp_servers_when_disabled(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def _fail_detect_language_servers(**_kwargs: object) -> object:
        raise AssertionError("disabled LSP tools should not probe language servers")

    monkeypatch.setattr(
        "sidecar.ai.tools.builtins.lsp.tools.detect_language_servers",
        _fail_detect_language_servers,
    )

    registry = build_default_registry(config={"tools_lsp_enabled": False})

    assert "lsp_definition" not in registry


def test_build_default_registry_does_not_expose_static_mcp_resource_tools() -> None:
    registry = build_default_registry(config={"tools_mcp_resources_enabled": True})

    assert "list_resources" not in registry
    assert "read_resource" not in registry
    assert "list_resource_templates" not in registry
    assert all(not name.startswith("mcp__") for name in registry)


def test_tool_manifest_matches_batch4_git_and_read_file_contract() -> None:
    manifest_path = (
        Path(__file__).resolve().parents[4] / "services" / "tools" / "tool-manifest.json"
    )
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    tools = {tool["name"]: tool for tool in manifest["tools"]}

    read_file_properties = tools["read_file"]["parameters"]["properties"]
    assert "offset" in read_file_properties
    assert "limit" in read_file_properties
    assert "pages" in read_file_properties
    assert tools["git_diff"]["parameters"]["properties"]["staged"]["type"] == "boolean"
    assert "path" in tools["git_diff"]["parameters"]["properties"]
    assert "ref" in tools["git_show"]["parameters"]["properties"]
    assert "path" in tools["git_show"]["parameters"]["properties"]
    assert "headings" in tools["read_file"]["parameters"]["properties"]
    assert "fetch_url" in tools
    assert "web_fetch" not in tools
    assert "allowed_domains" in tools["web_search"]["parameters"]["properties"]
    assert "blocked_domains" in tools["web_search"]["parameters"]["properties"]
    assert "expected_read_snapshot" in tools["write_file"]["parameters"]["properties"]
    assert "expected_read_snapshot" in tools["edit_file"]["parameters"]["properties"]
    assert "bash" not in tools
    assert "glob" not in tools
    assert "grep" not in tools
    assert "glob_files" in tools
    assert "grep_search" in tools
    assert "mermaid_generate" in tools
    assert "diagram_type" in tools["mermaid_generate"]["parameters"]["properties"]
    assert "workspace_manifest_read" in tools
    assert (
        tools["workspace_manifest_read"]["availability"]["config_flag"]
        == "tools_workspace_manifest_enabled"
    )
    assert tools["lsp"]["tool_family"] == "code_intelligence"
    assert tools["lsp"]["availability"]["config_flag"] == "tools_lsp_enabled"
    assert tools["lsp"]["availability"]["workspace_required"] is True
    assert set(tools["lsp"]["actions"]) == {
        "diagnostics",
        "symbols",
        "definition",
        "references",
    }
    assert tools["worktree_list"]["tool_family"] == "git"
    assert tools["worktree_create"]["tool_family"] == "git"
    assert tools["worktree_list"]["availability"]["config_flag"] == "tools_worktree_enabled"
    assert tools["worktree_create"]["availability"]["config_flag"] == "tools_worktree_enabled"
    assert tools["worktree_list"]["surfaces"] == ["managed_sidecar"]
    assert tools["worktree_create"]["surfaces"] == ["managed_sidecar"]
    assert tools["automation_list"]["tool_family"] == "runtime"
    assert tools["automation_read"]["tool_family"] == "runtime"
    assert tools["automation_list"]["availability"]["config_flag"] == "tools_automations_enabled"
    assert tools["automation_read"]["availability"]["config_flag"] == "tools_automations_enabled"
    assert tools["automation_list"]["read_only"] is True
    assert tools["automation_read"]["read_only"] is True


def test_build_default_registry_exposes_read_snapshot_contract_for_file_mutations(
    monkeypatch: pytest.MonkeyPatch,
) -> None:

    registry = build_default_registry(config={"tools_image_read_enabled": True})

    assert "expected_read_snapshot" in registry["write_file"].input_schema["properties"]
    assert "expected_read_snapshot" in registry["edit_file"].input_schema["properties"]
    assert "pages" in registry["read_file"].input_schema["properties"]


def test_build_default_registry_excludes_synthetic_manifest_only_tools(
    monkeypatch: pytest.MonkeyPatch,
) -> None:

    registry = build_default_registry(config={"tools_shell_enabled": True})

    assert "inspect_harness" not in registry
    assert "tool_search" not in registry


def test_infer_tool_classification_helpers_cover_builtin_and_external_tools() -> None:
    assert infer_tool_source_kind("read_file", server_name="jenny_local_tools") == "builtin"
    assert infer_tool_source_kind("external_lookup", server_name="remote_server") == "mcp"
    assert infer_tool_source_kind("read_file", server_name="remote_server") == "mcp"
    assert infer_tool_family("read_file") == "filesystem"
    assert infer_tool_family("workspace_manifest_read") == "filesystem"
    assert infer_tool_family("git_status") == "git"
    assert infer_tool_family("worktree_list") == "git"
    assert infer_tool_family("worktree_create") == "git"
    assert infer_tool_family("automation_list") == "runtime"
    assert infer_tool_family("automation_read") == "runtime"
    assert infer_tool_family("mermaid_generate") == "diagram"
    assert infer_tool_family("lsp") == "code_intelligence"


def test_tool_family_helpers_treat_mermaid_as_diagram_alias() -> None:
    assert (
        tool_family_for_status(name="mermaid_generate", tool_family="diagram")
        == "diagram"
    )
    assert requested_tool_families("Please create a Mermaid diagram") == ("diagram",)


def test_tool_family_for_status_keeps_retired_lsp_transcript_names_classified() -> None:
    assert (
        tool_family_for_status(name="lsp_definition", tool_family=None)
        == "code_intelligence"
    )


def test_descriptor_from_payload_classifies_builtin_and_external_tools() -> None:
    builtin = client_support.descriptor_from_payload(
        "jenny_local_tools",
        {
            "name": "read_file",
            "description": "Read a file",
            "input_schema": {"type": "object", "properties": {}},
            "side_effecting": False,
        },
    )
    external = client_support.descriptor_from_payload(
        "external_docs",
        {
            "name": "lookup_docs",
            "description": "Lookup docs",
            "input_schema": {"type": "object", "properties": {}},
            "side_effecting": False,
        },
    )

    assert builtin is not None
    assert builtin.source_kind == "builtin"
    assert builtin.tool_family == "filesystem"
    assert external is not None
    assert external.source_kind == "mcp"
    assert external.tool_family == "other"


# Handler imports for flag-gated tools are deferred into their gate blocks so the
# builtin-tools subprocess does not pay for modules it will never bind. A wrong
# module path or symbol name in one of those deferred imports would otherwise
# surface only at tools/call time, as a runtime failure of that single tool.
def test_every_flag_gated_binding_resolves_to_a_callable_handler() -> None:
    config = {
        "tools_shell_enabled": True,
        "tools_web_enabled": True,
        "tools_todo_enabled": True,
        "tools_mermaid_enabled": True,
        "tools_workspace_manifest_enabled": True,
        "tools_rich_files_enabled": True,
        "tools_knowledge_enabled": True,
        "tools_lsp_enabled": True,
        "tools_python_runtime_enabled": True,
        "tools_distill_enabled": True,
        "feature_flags": {"shell_security": True, "git_tracking": True},
        "knowledge_roots": [],
    }

    bindings = build_tool_bindings(config=config)

    deferred_bindings = {
        "web_search",
        "fetch_url",
        "todo_read",
        "todo_write",
        "mermaid_generate",
        "workspace_manifest_read",
        "knowledge_search",
        "knowledge_view",
        "knowledge_exec",
    }
    assert deferred_bindings <= set(bindings), (
        f"deferred bindings missing: {sorted(deferred_bindings - set(bindings))}"
    )
    non_callable = sorted(name for name, handler in bindings.items() if not callable(handler))
    assert not non_callable, f"non-callable handlers: {non_callable}"


def test_builtins_package_reexports_python_runtime_lazily() -> None:
    import sidecar.ai.tools.builtins as builtins_package

    # The names stay importable for existing consumers...
    assert callable(builtins_package.configure_python_runtime)
    assert callable(builtins_package.python_execute_tool)
    # ...but an unknown attribute must still raise rather than import anything.
    with pytest.raises(AttributeError):
        _ = builtins_package.definitely_not_a_real_symbol
