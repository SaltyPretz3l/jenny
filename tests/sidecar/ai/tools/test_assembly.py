from __future__ import annotations

from types import SimpleNamespace

from sidecar.ai.error_codes import CMP_TSRCH_DEFERRED_TOOL
from sidecar.ai.mode_policy import MODE_ASSIST
from sidecar.ai.tools.assembly import (
    CONFIG_DISABLED_REASON,
    ENGINE_UNSUPPORTED_REASON,
    MODE_DISABLED_REASON,
    READ_ONLY_UNAVAILABLE_REASON,
    PLATFORM_UNSUPPORTED_REASON,
    REQUEST_DISABLED_REASON,
    REQUEST_NOT_ENABLED_REASON,
    RUNTIME_UNAVAILABLE_REASON,
    SAFETY_MODE_STRICT_REASON,
    TOOL_NOT_EXPOSED_REASON,
    WORKSPACE_REQUIRED_REASON,
    ToolAssemblyContext,
    assemble_tool_contract,
    blocked_tool_error_code,
    blocked_tool_message,
    blocked_tool_metadata,
    current_info_remediation,
)
from sidecar.ai.tools.catalog import (
    MANAGED_SIDECAR_SURFACE,
    CanonicalToolAvailability,
    CanonicalToolDescriptor,
    build_tool_catalog,
    manifest_descriptors,
)
from sidecar.ai.tools.tool_search import ToolResolutionContext, build_search_index


def _descriptor(
    name: str,
    *,
    side_effecting: bool = False,
    source_kind: str = "builtin",
    tool_family: str = "other",
    runtime_registered: bool = True,
    surfaces: tuple[str, ...] = (MANAGED_SIDECAR_SURFACE,),
    availability: CanonicalToolAvailability | None = None,
) -> CanonicalToolDescriptor:
    return CanonicalToolDescriptor(
        name=name,
        description=f"{name} description",
        input_schema={"type": "object", "properties": {}},
        side_effecting=side_effecting,
        read_only=not side_effecting,
        source_kind=source_kind,
        tool_family=tool_family,
        surfaces=surfaces,
        availability=availability or CanonicalToolAvailability(),
        runtime_registered=runtime_registered,
        server_name="runtime",
    )


def test_assemble_tool_contract_respects_mode_policy_and_always_available_tools() -> None:
    inspect_harness = _descriptor(
        "inspect_harness",
        source_kind="synthetic",
        tool_family="runtime",
        availability=CanonicalToolAvailability(always_available=True),
    )
    read_file = _descriptor(
        "read_file",
        tool_family="filesystem",
        availability=CanonicalToolAvailability(workspace_required=True),
    )

    contract = assemble_tool_contract(
        (inspect_harness, read_file),
        ToolAssemblyContext(
            surface=MANAGED_SIDECAR_SURFACE,
            config={},
            engine_supports_tool_calling=True,
            mode="chat",
            plan_mode=False,
            workspace_root_present=True,
        ),
    )

    assert contract.entry("inspect_harness").available is True
    assert contract.entry("read_file").available is False
    assert contract.entry("read_file").reason == MODE_DISABLED_REASON


def test_delegate_uses_read_only_subagent_preference_and_ignores_legacy_batch_flag() -> None:
    catalog = build_tool_catalog()

    def contract(batch_enabled: bool | None, *, subagents_enabled: bool = True):
        config = {
            "tools_enabled": True,
            "tools_subagents_enabled": subagents_enabled,
        }
        if batch_enabled is not None:
            config["tools_subagent_batch_enabled"] = batch_enabled
        return assemble_tool_contract(
            catalog,
            ToolAssemblyContext(
                surface=MANAGED_SIDECAR_SURFACE,
                config=config,
                engine_supports_tool_calling=True,
                mode=MODE_ASSIST,
                plan_mode=True,
                workspace_root_present=True,
            ),
        )

    disabled = contract(False)
    enabled = contract(True)
    missing = contract(None)
    permission_off = contract(True, subagents_enabled=False)

    assert disabled.entry("delegate").available is True
    assert enabled.entry("delegate").available is True
    assert missing.entry("delegate").available is True
    assert permission_off.entry("delegate").reason == CONFIG_DISABLED_REASON
    assert all(entry.descriptor.name not in {"subagent_run", "subagent_batch"} for entry in enabled.entries)


def test_assemble_tool_contract_keeps_always_available_tools_visible_without_tool_calling() -> None:
    inspect_harness = _descriptor(
        "inspect_harness",
        source_kind="synthetic",
        tool_family="runtime",
        availability=CanonicalToolAvailability(always_available=True),
    )

    contract = assemble_tool_contract(
        (inspect_harness,),
        ToolAssemblyContext(
            surface=MANAGED_SIDECAR_SURFACE,
            config={"tools_enabled": False},
            engine_supports_tool_calling=False,
            mode="chat",
            plan_mode=True,
            tool_preferences={"disabled_tools": ("inspect_harness",)},
            workspace_root_present=False,
        ),
    )

    entry = contract.entry("inspect_harness")

    assert entry is not None
    assert entry.available is True
    assert entry.reason is None


def test_assemble_tool_contract_allows_inband_tool_calling_without_native_support() -> None:
    read_file = _descriptor("read_file", tool_family="filesystem")

    contract = assemble_tool_contract(
        (read_file,),
        ToolAssemblyContext(
            surface=MANAGED_SIDECAR_SURFACE,
            config={},
            engine_supports_tool_calling=False,
            engine_supports_inband_tool_calling=True,
            mode=MODE_ASSIST,
            workspace_root_present=True,
        ),
    )

    entry = contract.entry("read_file")
    assert entry is not None
    assert entry.available is True
    assert entry.reason is None


def test_assemble_tool_contract_fails_closed_for_non_bool_global_tools_enabled() -> None:
    read_file = _descriptor("read_file", tool_family="filesystem")

    for malformed_value in (None, "false", 0, [], {}):
        contract = assemble_tool_contract(
            (read_file,),
            ToolAssemblyContext(
                surface=MANAGED_SIDECAR_SURFACE,
                config={"tools_enabled": malformed_value},
                engine_supports_tool_calling=True,
                mode=MODE_ASSIST,
                workspace_root_present=True,
            ),
        )

        entry = contract.entry("read_file")
        assert entry is not None
        assert entry.available is False
        assert entry.reason == RUNTIME_UNAVAILABLE_REASON


def test_assemble_tool_contract_fails_closed_for_non_bool_config_flags() -> None:
    web_search = _descriptor(
        "web_search",
        tool_family="web",
        availability=CanonicalToolAvailability(config_flag="tools_web_enabled"),
    )

    for malformed_value in (None, "false", 0, [], {}):
        contract = assemble_tool_contract(
            (web_search,),
            ToolAssemblyContext(
                surface=MANAGED_SIDECAR_SURFACE,
                config={"tools_web_enabled": malformed_value},
                engine_supports_tool_calling=True,
                mode=MODE_ASSIST,
                workspace_root_present=True,
            ),
        )

        entry = contract.entry("web_search")
        assert entry is not None
        assert entry.available is False
        assert entry.reason == CONFIG_DISABLED_REASON


def test_assemble_tool_contract_applies_plan_mode_config_workspace_and_platform_filters() -> None:
    write_file = _descriptor(
        "write_file",
        side_effecting=True,
        tool_family="filesystem",
        availability=CanonicalToolAvailability(workspace_required=True),
    )
    web_search = _descriptor(
        "web_search",
        tool_family="web",
        availability=CanonicalToolAvailability(config_flag="tools_web_enabled"),
    )
    python_execute = _descriptor(
        "python_execute",
        side_effecting=True,
        tool_family="python",
        availability=CanonicalToolAvailability(platforms=("no-such-platform",)),
    )

    contract = assemble_tool_contract(
        (write_file, web_search, python_execute),
        ToolAssemblyContext(
            surface=MANAGED_SIDECAR_SURFACE,
            config={"tools_web_enabled": False},
            engine_supports_tool_calling=True,
            mode=MODE_ASSIST,
            plan_mode=True,
            workspace_root_present=False,
        ),
    )

    assert contract.entry("write_file").reason == WORKSPACE_REQUIRED_REASON
    assert contract.entry("web_search").reason == CONFIG_DISABLED_REASON
    assert contract.entry("python_execute").reason == PLATFORM_UNSUPPORTED_REASON


def test_assemble_tool_contract_blocks_non_enabled_request_tools() -> None:
    read_file = _descriptor("read_file", tool_family="filesystem")
    web_search = _descriptor("web_search", tool_family="web")

    contract = assemble_tool_contract(
        (read_file, web_search),
        ToolAssemblyContext(
            surface=MANAGED_SIDECAR_SURFACE,
            config={"tools_web_enabled": True},
            engine_supports_tool_calling=True,
            mode=MODE_ASSIST,
            plan_mode=False,
            tool_preferences={"enabled_tools": ("read_file",)},
            workspace_root_present=True,
        ),
    )

    assert contract.entry("read_file").available is True
    assert contract.entry("web_search").available is False
    assert contract.entry("web_search").reason == REQUEST_NOT_ENABLED_REASON


def test_request_allowlist_keeps_generation_bound_native_plugin_tools_available() -> None:
    plugin_tool = _descriptor(
        "plugin:jenny-official:stage8-conformance:echo",
        source_kind="plugin_native_mcp",
    )
    contract = assemble_tool_contract(
        (plugin_tool,),
        ToolAssemblyContext(
            surface=MANAGED_SIDECAR_SURFACE,
            config={},
            engine_supports_tool_calling=True,
            mode=MODE_ASSIST,
            plan_mode=False,
            tool_preferences={"enabled_tools": ("read_file",)},
            workspace_root_present=True,
        ),
    )

    assert contract.entry(plugin_tool.name).available is True


def test_strict_safety_mode_blocks_network_tool_family() -> None:
    read_file = _descriptor("read_file", tool_family="filesystem")
    web_search = _descriptor(
        "web_search",
        tool_family="web",
        availability=CanonicalToolAvailability(config_flag="tools_web_enabled"),
    )

    contract = assemble_tool_contract(
        (read_file, web_search),
        ToolAssemblyContext(
            surface=MANAGED_SIDECAR_SURFACE,
            config={"tools_web_enabled": True, "safety_mode": "strict"},
            engine_supports_tool_calling=True,
            mode=MODE_ASSIST,
            workspace_root_present=True,
        ),
    )

    assert contract.entry("read_file").available is True
    assert contract.entry("web_search").available is False
    assert contract.entry("web_search").reason == SAFETY_MODE_STRICT_REASON


def test_disabled_tool_families_preference_blocks_matching_family() -> None:
    read_file = _descriptor("read_file", tool_family="filesystem")
    web_search = _descriptor("web_search", tool_family="web")

    contract = assemble_tool_contract(
        (read_file, web_search),
        ToolAssemblyContext(
            surface=MANAGED_SIDECAR_SURFACE,
            config={"tools_web_enabled": True},
            engine_supports_tool_calling=True,
            mode=MODE_ASSIST,
            plan_mode=False,
            tool_preferences={"disabled_tool_families": ("web",)},
            workspace_root_present=True,
        ),
    )

    assert contract.entry("read_file").available is True
    assert contract.entry("web_search").available is False
    assert contract.entry("web_search").reason == REQUEST_DISABLED_REASON


def test_assemble_tool_contract_hides_deferred_tools_and_exposes_tool_search() -> None:
    deferred_tool = _descriptor(
        "mcp__git__commit",
        source_kind="mcp",
        tool_family="git",
        availability=CanonicalToolAvailability(defer_eligible=True),
    )
    tool_search = _descriptor(
        "tool_search",
        source_kind="synthetic",
        tool_family="discovery",
        availability=CanonicalToolAvailability(),
    )
    resolution_context = ToolResolutionContext(
        deferred_names=frozenset({"mcp__git__commit"}),
        un_deferred_names=set(),
        search_index=build_search_index(
            frozenset({"mcp__git__commit"}),
            (deferred_tool,),
        ),
    )

    contract = assemble_tool_contract(
        (deferred_tool, tool_search),
        ToolAssemblyContext(
            surface=MANAGED_SIDECAR_SURFACE,
            config={},
            engine_supports_tool_calling=True,
            mode=MODE_ASSIST,
            plan_mode=False,
            resolution_context=resolution_context,
            workspace_root_present=True,
            include_deferred_tools=True,
        ),
    )

    deferred_entry = contract.entry("mcp__git__commit")
    search_entry = contract.entry("tool_search")

    assert deferred_entry.available is False
    assert deferred_entry.deferred is True
    assert deferred_entry.reason == TOOL_NOT_EXPOSED_REASON
    assert deferred_entry.prompt_schema["defer_loading"] is True
    assert search_entry.available is True


def test_assemble_tool_contract_hides_budget_filtered_tools_and_exposes_tool_search() -> None:
    read_file = _descriptor("read_file", tool_family="filesystem")
    web_search = _descriptor("web_search", tool_family="web")
    tool_search = _descriptor(
        "tool_search",
        source_kind="synthetic",
        tool_family="discovery",
        availability=CanonicalToolAvailability(),
    )
    resolution_context = ToolResolutionContext(
        deferred_names=frozenset(),
        budget_filtered_names=frozenset({"web_search"}),
        budget_filter_metadata={
            "level": "warning",
            "cap": 1,
            "filtered_count": 1,
        },
        search_index=build_search_index(
            frozenset({"web_search"}),
            (read_file, web_search),
        ),
    )

    contract = assemble_tool_contract(
        (read_file, web_search, tool_search),
        ToolAssemblyContext(
            surface=MANAGED_SIDECAR_SURFACE,
            config={},
            engine_supports_tool_calling=True,
            mode=MODE_ASSIST,
            workspace_root_present=True,
            resolution_context=resolution_context,
        ),
    )

    filtered_entry = contract.entry("web_search")
    assert filtered_entry.available is False
    assert filtered_entry.deferred is True
    assert filtered_entry.reason == TOOL_NOT_EXPOSED_REASON
    assert filtered_entry.prompt_schema == {
        "name": "web_search",
        "description": "web_search description",
        "defer_loading": True,
    }
    assert contract.entry("tool_search").available is True
    assert contract.entry("web_search").runtime_status().available is False


def test_budget_filtered_tool_block_message_matches_deferred_path() -> None:
    assert blocked_tool_error_code(TOOL_NOT_EXPOSED_REASON) == CMP_TSRCH_DEFERRED_TOOL
    assert blocked_tool_metadata(TOOL_NOT_EXPOSED_REASON) == {
        "deferred": True,
        "tool_search_required": True,
    }
    assert "Call tool_search first" in blocked_tool_message(
        "web_search",
        TOOL_NOT_EXPOSED_REASON,
    )


def test_runtime_status_includes_input_schema_for_prompt_examples() -> None:
    read_file = _descriptor("read_file", tool_family="filesystem")

    contract = assemble_tool_contract(
        (read_file,),
        ToolAssemblyContext(
            surface=MANAGED_SIDECAR_SURFACE,
            config={},
            engine_supports_tool_calling=True,
            mode=MODE_ASSIST,
            workspace_root_present=True,
        ),
    )

    status = contract.entry("read_file").runtime_status()

    assert status.input_schema == {"type": "object", "properties": {}}


def test_assemble_tool_contract_marks_side_effecting_tools_unavailable_in_plan_mode() -> None:
    write_file = _descriptor(
        "write_file",
        side_effecting=True,
        tool_family="filesystem",
        availability=CanonicalToolAvailability(workspace_required=True),
    )

    contract = assemble_tool_contract(
        (write_file,),
        ToolAssemblyContext(
            surface=MANAGED_SIDECAR_SURFACE,
            config={},
            engine_supports_tool_calling=True,
            mode=MODE_ASSIST,
            plan_mode=True,
            read_only=True,
            workspace_root_present=True,
        ),
    )

    assert contract.entry("write_file").available is False
    assert contract.entry("write_file").reason == READ_ONLY_UNAVAILABLE_REASON


def _home_catalog() -> tuple[CanonicalToolDescriptor, ...]:
    # Built the way the Electron bridge builds it, so the manifest's
    # read_only/side_effecting pair is the one under test rather than a literal
    # the test made up.
    bridge = SimpleNamespace(
        name="home",
        description="home description",
        input_schema={"type": "object", "properties": {}},
        side_effecting=False,
        read_only=False,
        server_name="electron_tool_bridge",
        source_kind="builtin",
        tool_family="home",
        server_tool_name="home",
    )
    return build_tool_catalog(runtime_descriptors=(bridge,))


def _home_entry(*, read_only: bool):
    contract = assemble_tool_contract(
        _home_catalog(),
        ToolAssemblyContext(
            surface=MANAGED_SIDECAR_SURFACE,
            config={},
            engine_supports_tool_calling=True,
            mode=MODE_ASSIST,
            plan_mode=read_only,
            read_only=read_only,
            workspace_root_present=True,
        ),
    )
    return contract.entry("home")


def test_home_is_withheld_in_read_only_contexts_despite_not_being_side_effecting() -> None:
    # `home` is the one manifest entry that is read_only=False AND
    # side_effecting=False. Every read-only gate keyed on side_effecting alone,
    # so the sidecar advertised it in Plan Mode / research subagents and
    # Electron then refused it at dispatch — a wasted model turn per call.
    home = next(
        descriptor for descriptor in _home_catalog() if descriptor.name == "home"
    )
    assert home.read_only is False
    assert home.side_effecting is False

    blocked = _home_entry(read_only=True)
    assert blocked.available is False
    assert blocked.reason == READ_ONLY_UNAVAILABLE_REASON


def test_home_is_available_when_the_request_is_not_read_only() -> None:
    assert _home_entry(read_only=False).available is True


def test_home_is_the_only_manifest_entry_that_is_not_read_only_and_not_side_effecting() -> None:
    # Bounds the blast radius of the gate above: if a second entry ever adopts
    # this pair, it silently inherits read-only withholding and should be a
    # deliberate decision, not a surprise.
    offenders = tuple(
        descriptor.name
        for descriptor in manifest_descriptors()
        if descriptor.read_only is False and descriptor.side_effecting is False
    )
    assert offenders == ("home",)


def test_current_info_remediation_engine_unsupported() -> None:
    remedy = current_info_remediation(ENGINE_UNSUPPORTED_REASON)
    assert "tool-capable model" in remedy


def test_current_info_remediation_config_disabled() -> None:
    remedy = current_info_remediation(CONFIG_DISABLED_REASON)
    assert "Settings > Tools" in remedy


def test_current_info_remediation_safety_mode_strict() -> None:
    remedy = current_info_remediation(SAFETY_MODE_STRICT_REASON)
    assert "safety mode" in remedy


def test_current_info_remediation_unknown_reason_is_empty() -> None:
    # Reasons with no user-fixable remedy (and None) return "" so callers append
    # nothing rather than leaking a partial sentence.
    assert current_info_remediation(RUNTIME_UNAVAILABLE_REASON) == ""
    assert current_info_remediation("some unmapped reason") == ""
    assert current_info_remediation(None) == ""
    assert current_info_remediation("") == ""
