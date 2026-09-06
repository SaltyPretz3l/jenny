"""Dedicated tests for sidecar/ai/routing/tool_resolution.py.

Covers dark branches including:
  - _config_bool truthy/falsy/missing on both namespace and dict configs (lines 52-56)
  - engine_supports_tool_calling / engine_supports_inband_tool_calling true & false (lines 116-127)
  - tool_has_workspace from tools_workspace_root, agent_workspace_root, and neither (lines 129-132)
  - get_tool_schemas / build_full_tool_schema_map shape (lines 244-260)
  - build_tool_payload plan_mode branch + tool_preferences branch (lines 271-287)
  - tool_status_entries: plan_mode auto-creates request_context, tool_preferences branch (332-359)
  - available_tool_names filters correctly (362-363)
  - assemble_tool_contract with a recording stub (224-260)
  - remaining_unexposed_tool_names delegates correctly (135-136)
"""

from __future__ import annotations

from types import SimpleNamespace

import sidecar.ai.routing.tool_resolution as tr  # (static import for the existence gate)
from sidecar.ai.config import RuntimeConfig
from sidecar.ai.context.builder import RuntimeToolStatus
from sidecar.ai.tools.tool_search import ToolResolutionContext
from sidecar.runtime.chat_models import ChatRequestContext

# ── Helpers ────────────────────────────────────────────────────────────────────


def _fake_descriptor(
    name: str = "web_search",
    *,
    side_effecting: bool = False,
    source_kind: str = "builtin",
    tool_family: str = "web",
    server_name: str = "jenny_local_tools",
) -> SimpleNamespace:
    return SimpleNamespace(
        name=name,
        description=f"Fake {name}",
        input_schema={"type": "object", "properties": {}},
        side_effecting=side_effecting,
        source_kind=source_kind,
        tool_family=tool_family,
        server_name=server_name,
        search_hint="",
    )


class _FakeMCP:
    """MCP client stub that records calls to available_tools."""

    def __init__(self, available_tools: list[object] | None = None) -> None:
        self.available_tools: list[object] = available_tools or []


def _kernel(
    config: RuntimeConfig,
    *,
    available_tools: list[object] | None = None,
    supports_tool_calling: bool = True,
    supports_inband_tool_calling: bool = False,
) -> SimpleNamespace:
    return SimpleNamespace(
        _config=config,
        _mcp_client=_FakeMCP(available_tools),
        _engine=SimpleNamespace(
            supports_tool_calling=supports_tool_calling,
            supports_inband_tool_calling=supports_inband_tool_calling,
        ),
    )


def _runtime_status(name: str, *, available: bool, reason: str | None = None) -> RuntimeToolStatus:
    return RuntimeToolStatus(
        name=name,
        display_name=name.title(),
        available=available,
        reason=reason,
        description="",
        source_kind="builtin",
        tool_family="other",
        server_name=None,
        input_schema={},
    )


# ── _config_bool ───────────────────────────────────────────────────────────────


def test_config_bool_namespace_true() -> None:
    cfg = SimpleNamespace(flag=True)
    assert tr._config_bool(cfg, "flag") is True


def test_config_bool_namespace_false() -> None:
    cfg = SimpleNamespace(flag=False)
    assert tr._config_bool(cfg, "flag") is False


def test_config_bool_namespace_missing_returns_false() -> None:
    cfg = SimpleNamespace()
    assert tr._config_bool(cfg, "flag") is False


def test_config_bool_namespace_non_bool_returns_false() -> None:
    # Namespace attribute is non-bool: should fall through to return False (line 56)
    cfg = SimpleNamespace(flag="yes")
    assert tr._config_bool(cfg, "flag") is False


def test_config_bool_dict_true() -> None:
    # Dict path (lines 52-55): dict with bool True
    cfg: dict = {"flag": True}
    assert tr._config_bool(cfg, "flag") is True


def test_config_bool_dict_false() -> None:
    # Dict path (lines 52-55): dict with bool False
    cfg: dict = {"flag": False}
    assert tr._config_bool(cfg, "flag") is False


def test_config_bool_dict_non_bool_returns_false() -> None:
    # Dict with non-bool value → line 56 return False
    cfg: dict = {"flag": 1}
    assert tr._config_bool(cfg, "flag") is False


def test_config_bool_dict_missing_key_returns_false() -> None:
    cfg: dict = {}
    assert tr._config_bool(cfg, "flag") is False


# ── engine_supports_tool_calling ───────────────────────────────────────────────


def test_engine_supports_tool_calling_true() -> None:
    kernel = SimpleNamespace(_engine=SimpleNamespace(supports_tool_calling=True))
    assert tr.engine_supports_tool_calling(kernel) is True


def test_engine_supports_tool_calling_false() -> None:
    # Dark branch: engine explicitly reports False (line 118)
    kernel = SimpleNamespace(_engine=SimpleNamespace(supports_tool_calling=False))
    assert tr.engine_supports_tool_calling(kernel) is False


def test_engine_supports_tool_calling_default_true_when_attr_missing() -> None:
    # Missing attribute → default True (line 119)
    kernel = SimpleNamespace(_engine=SimpleNamespace())
    assert tr.engine_supports_tool_calling(kernel) is True


def test_engine_supports_inband_tool_calling_true() -> None:
    # Dark branch: engine explicitly reports inband True (line 125)
    kernel = SimpleNamespace(_engine=SimpleNamespace(supports_inband_tool_calling=True))
    assert tr.engine_supports_inband_tool_calling(kernel) is True


def test_engine_supports_inband_tool_calling_false() -> None:
    kernel = SimpleNamespace(_engine=SimpleNamespace(supports_inband_tool_calling=False))
    assert tr.engine_supports_inband_tool_calling(kernel) is False


def test_engine_supports_inband_tool_calling_default_false_when_attr_missing() -> None:
    # Missing attribute → default False (line 126)
    kernel = SimpleNamespace(_engine=SimpleNamespace())
    assert tr.engine_supports_inband_tool_calling(kernel) is False


# ── tool_has_workspace ─────────────────────────────────────────────────────────


def test_tool_has_workspace_from_tools_workspace_root(tmp_path) -> None:
    kernel = SimpleNamespace(
        _config=SimpleNamespace(
            tools_workspace_root=str(tmp_path),
            agent_workspace_root=None,
        )
    )
    assert tr.tool_has_workspace(kernel) is True


def test_tool_has_workspace_from_agent_workspace_root(tmp_path) -> None:
    # Dark branch: falls through to agent_workspace_root (line 131)
    kernel = SimpleNamespace(
        _config=SimpleNamespace(
            tools_workspace_root=None,
            agent_workspace_root=str(tmp_path),
        )
    )
    assert tr.tool_has_workspace(kernel) is True


def test_tool_has_workspace_returns_false_when_both_none() -> None:
    kernel = SimpleNamespace(
        _config=SimpleNamespace(tools_workspace_root=None, agent_workspace_root=None)
    )
    assert tr.tool_has_workspace(kernel) is False


def test_tool_has_workspace_returns_false_for_whitespace_only() -> None:
    kernel = SimpleNamespace(
        _config=SimpleNamespace(tools_workspace_root="   ", agent_workspace_root="  ")
    )
    assert tr.tool_has_workspace(kernel) is False


# ── remaining_unexposed_tool_names ─────────────────────────────────────────────


def test_remaining_unexposed_tool_names_none_context_returns_empty() -> None:
    result = tr.remaining_unexposed_tool_names(None)
    assert result == frozenset()


def test_remaining_unexposed_tool_names_subtracts_un_deferred() -> None:
    ctx = ToolResolutionContext(
        deferred_names=frozenset({"tool_a", "tool_b"}),
        un_deferred_names={"tool_a"},
    )
    result = tr.remaining_unexposed_tool_names(ctx)
    # tool_a was un-deferred; only tool_b remains unexposed
    assert result == frozenset({"tool_b"})


# ── get_tool_schemas / build_full_tool_schema_map ──────────────────────────────


def test_get_tool_schemas_returns_sorted_list_of_dicts(tmp_path) -> None:
    kernel = _kernel(
        RuntimeConfig(mode="assist", tools_workspace_root=str(tmp_path)),
        available_tools=[_fake_descriptor("web_search", source_kind="builtin", tool_family="web")],
    )
    schemas = tr.get_tool_schemas(kernel)
    # Must be a list of dicts
    assert isinstance(schemas, list)
    assert len(schemas) >= 1
    assert all(isinstance(s, dict) for s in schemas)
    # Each schema must have the four canonical keys
    for s in schemas:
        assert set(s.keys()) >= {"name", "description", "parameters", "side_effecting"}
    # Must be sorted by name (get_tool_schemas sorts by key order in full_schema_map)
    names = [s["name"] for s in schemas]
    assert names == sorted(names)


def test_build_full_tool_schema_map_returns_dict_keyed_by_name(tmp_path) -> None:
    kernel = _kernel(
        RuntimeConfig(mode="assist", tools_workspace_root=str(tmp_path)),
        available_tools=[
            _fake_descriptor("web_search", source_kind="builtin", tool_family="web"),
        ],
    )
    schema_map = tr.build_full_tool_schema_map(kernel)
    assert isinstance(schema_map, dict)
    assert "inspect_harness" not in schema_map
    # web_search provided by the fake MCP must appear
    assert "web_search" in schema_map
    # Values must be dicts with the canonical schema keys
    for name, schema in schema_map.items():
        assert schema["name"] == name
        assert "description" in schema
        assert "parameters" in schema
        assert "side_effecting" in schema


# ── build_tool_payload ─────────────────────────────────────────────────────────


def test_build_tool_payload_without_request_context_uses_no_filters(tmp_path) -> None:
    kernel = _kernel(
        RuntimeConfig(
            mode="assist",
            tools_workspace_root=str(tmp_path),
            tools_web_enabled=True,
        ),
        available_tools=[_fake_descriptor("web_search", source_kind="builtin", tool_family="web")],
    )
    payload = tr.build_tool_payload(kernel, None)
    # Must be a list of dicts; web_search should appear
    assert isinstance(payload, list)
    names = {p["name"] for p in payload}
    assert "web_search" in names


def test_build_tool_payload_plan_mode_excludes_side_effecting(tmp_path) -> None:
    # Dark branch: plan_mode=True → auto-creates ChatRequestContext (lines 271-281)
    kernel = _kernel(
        RuntimeConfig(
            mode="assist",
            tools_workspace_root=str(tmp_path),
            tools_web_enabled=True,
            tools_shell_enabled=True,
        ),
        available_tools=[
            _fake_descriptor("web_search", side_effecting=False, tool_family="web"),
            _fake_descriptor("run_command", side_effecting=True, tool_family="shell"),
        ],
    )
    payload = tr.build_tool_payload(kernel, None, plan_mode=True)
    names = {p["name"] for p in payload}
    # web_search is read-only → survives plan mode
    assert "web_search" in names
    # run_command is side-effecting → blocked in plan mode
    assert "run_command" not in names


def test_build_tool_payload_tool_preferences_restricts_to_enabled(tmp_path) -> None:
    # Dark branch: tool_preferences is not None → auto-creates ChatRequestContext (lines 271-281)
    kernel = _kernel(
        RuntimeConfig(
            mode="assist",
            tools_workspace_root=str(tmp_path),
            tools_web_enabled=True,
        ),
        available_tools=[
            _fake_descriptor("web_search", tool_family="web"),
            _fake_descriptor("mermaid_generate", tool_family="other"),
        ],
    )
    payload = tr.build_tool_payload(
        kernel,
        None,
        tool_preferences={"enabled_tools": ("web_search",)},
    )
    names = {p["name"] for p in payload}
    assert "web_search" in names
    assert "mermaid_generate" not in names


# ── tool_status_entries ────────────────────────────────────────────────────────


def test_tool_status_entries_plan_mode_blocks_side_effecting(tmp_path) -> None:
    # Lines 339-349: plan_mode=True → auto-creates ChatRequestContext
    kernel = _kernel(
        RuntimeConfig(
            mode="assist",
            tools_workspace_root=str(tmp_path),
            tools_shell_enabled=True,
            tools_web_enabled=True,
        ),
        available_tools=[
            _fake_descriptor("run_command", side_effecting=True, tool_family="shell"),
            _fake_descriptor("web_search", side_effecting=False, tool_family="web"),
        ],
    )
    entries = tr.tool_status_entries(kernel, plan_mode=True)
    by_name = {e.name: e for e in entries}
    # run_command is side-effecting → blocked in plan mode
    assert by_name["run_command"].available is False
    # web_search is read-only → survives plan mode
    assert by_name["web_search"].available is True


def test_tool_status_entries_tool_preferences_disable_tool(tmp_path) -> None:
    # Lines 339-349: tool_preferences is not None → auto-creates ChatRequestContext
    kernel = _kernel(
        RuntimeConfig(
            mode="assist",
            tools_workspace_root=str(tmp_path),
            tools_web_enabled=True,
        ),
        available_tools=[_fake_descriptor("web_search", tool_family="web")],
    )
    entries = tr.tool_status_entries(
        kernel,
        tool_preferences={"disabled_tools": ("web_search",)},
    )
    by_name = {e.name: e for e in entries}
    assert by_name["web_search"].available is False
    assert by_name["web_search"].reason == "request preference disabled"


def test_tool_status_entries_with_request_context(tmp_path) -> None:
    kernel = _kernel(
        RuntimeConfig(
            mode="assist",
            tools_workspace_root=str(tmp_path),
            tools_web_enabled=True,
        ),
        available_tools=[_fake_descriptor("web_search", tool_family="web")],
    )
    rc = ChatRequestContext(
        request_id="r1",
        trace_id=None,
        session_id=None,
        mode="assist",
        approvals_pre_granted=True,
        workspace_root_present=True,
    )
    entries = tr.tool_status_entries(kernel, request_context=rc)
    assert isinstance(entries, tuple)
    assert len(entries) >= 1
    # All entries must have a name
    assert all(hasattr(e, "name") and e.name for e in entries)


# ── available_tool_names ───────────────────────────────────────────────────────


def test_available_tool_names_filters_only_available() -> None:
    statuses = (
        _runtime_status("web_search", available=True),
        _runtime_status("run_command", available=False, reason="config disabled"),
        _runtime_status("read_file", available=True),
    )
    names = tr.available_tool_names(statuses)
    assert set(names) == {"web_search", "read_file"}
    # run_command must be absent
    assert "run_command" not in names


def test_available_tool_names_empty_when_all_unavailable() -> None:
    statuses = (
        _runtime_status("web_search", available=False, reason="runtime/backend unavailable"),
    )
    names = tr.available_tool_names(statuses)
    assert names == ()


def test_available_tool_names_empty_for_empty_input() -> None:
    assert tr.available_tool_names(()) == ()


def test_assemble_tool_contract_with_request_context_disables_via_preference(tmp_path) -> None:
    kernel = _kernel(
        RuntimeConfig(
            mode="assist",
            tools_workspace_root=str(tmp_path),
            tools_web_enabled=True,
        ),
        available_tools=[_fake_descriptor("web_search", tool_family="web")],
    )
    rc = ChatRequestContext(
        request_id="r1",
        trace_id=None,
        session_id=None,
        mode="assist",
        approvals_pre_granted=True,
        workspace_root_present=True,
        tool_preferences={"disabled_tools": ("web_search",)},
    )
    contract = tr.assemble_tool_contract(kernel, request_context=rc)
    entry = contract.entry("web_search")
    assert entry is not None
    assert entry.available is False
    assert entry.reason == "request preference disabled"


def test_assemble_tool_contract_without_request_context_uses_defaults(tmp_path) -> None:
    kernel = _kernel(
        RuntimeConfig(
            mode="assist",
            tools_workspace_root=str(tmp_path),
            tools_web_enabled=True,
        ),
        available_tools=[_fake_descriptor("web_search", tool_family="web")],
    )
    contract = tr.assemble_tool_contract(kernel)
    entry = contract.entry("web_search")
    assert entry is not None
    # Without request_context, no preference enforcement → web_search available
    assert entry.available is True


def test_assemble_tool_contract_records_available_names(tmp_path) -> None:
    kernel = _kernel(
        RuntimeConfig(
            mode="assist",
            tools_workspace_root=str(tmp_path),
            tools_web_enabled=True,
        ),
        available_tools=[_fake_descriptor("web_search", tool_family="web")],
    )
    contract = tr.assemble_tool_contract(kernel)
    assert "web_search" in contract.available_names
    assert "inspect_harness" not in contract.available_names


def test_assemble_tool_contract_exposes_electron_jenny_status() -> None:
    kernel = _kernel(
        RuntimeConfig(mode="assist", electron_tool_bridge_enabled=True),
    )

    contract = tr.assemble_tool_contract(kernel)

    entry = contract.entry("jenny_status")
    assert entry is not None
    assert entry.available is True
    assert entry.descriptor.server_name == tr.ELECTRON_TOOL_BRIDGE_SERVER_NAME


def test_assemble_tool_contract_with_no_tool_calling_support(tmp_path) -> None:
    # When engine doesn't support tool calling, all tools (except always_available) blocked
    kernel = _kernel(
        RuntimeConfig(
            mode="assist",
            tools_workspace_root=str(tmp_path),
            tools_web_enabled=True,
        ),
        available_tools=[_fake_descriptor("web_search", tool_family="web")],
        supports_tool_calling=False,
        supports_inband_tool_calling=False,
    )
    contract = tr.assemble_tool_contract(kernel)
    ws_entry = contract.entry("web_search")
    assert ws_entry is not None
    assert ws_entry.available is False
    assert ws_entry.reason == "model/runtime does not support tool calling"
