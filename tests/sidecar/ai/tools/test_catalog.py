from __future__ import annotations

import json
from types import SimpleNamespace

import pytest

from sidecar.ai.mcp.models import MCPToolDescriptor
from sidecar.ai.tools import catalog as catalog_module
from sidecar.ai.tools.catalog import build_tool_catalog, tool_manifest_path
from sidecar.ai.tools.tool_families import KNOWN_TOOL_FAMILIES


def test_tool_manifest_v2_excludes_removed_runtime_and_includes_synthetic_entries() -> None:
    manifest = json.loads(tool_manifest_path().read_text(encoding="utf-8"))
    tools = {tool["name"]: tool for tool in manifest["tools"]}

    assert manifest["manifest_version"] == 2
    assert "inspect_harness" not in tools
    assert "jenny_status" in tools
    assert "tool_search" in tools
    assert "monitor" in tools
    assert "delegate" in tools
    assert "subagent_batch" not in tools
    assert "subagent_run" not in tools
    assert all(
        set(tool.get("surfaces") or ()) <= {"managed_sidecar", "builtin_mcp"}
        for tool in tools.values()
    )

    create_artifact_properties = tools["create_artifact"]["parameters"]["properties"]
    assert "artifact_kind" in create_artifact_properties
    assert "file_name" in create_artifact_properties
    assert "filename" not in create_artifact_properties


def test_tool_manifest_uses_known_canonical_tool_families() -> None:
    manifest = json.loads(tool_manifest_path().read_text(encoding="utf-8"))
    families = {tool.get("tool_family") for tool in manifest["tools"]}

    assert families <= KNOWN_TOOL_FAMILIES
    assert "mermaid" not in families

    tools = {tool["name"]: tool for tool in manifest["tools"]}
    assert tools["mermaid_generate"]["tool_family"] == "diagram"


def test_build_tool_catalog_uses_manifest_metadata_for_jenny_owned_runtime_tools() -> None:
    catalog = build_tool_catalog(
        config={"tools_image_read_enabled": False},
        runtime_descriptors=(
            MCPToolDescriptor(
                name="read_file",
                description="Runtime read descriptor",
                input_schema={"type": "object", "properties": {"path": {"type": "string"}}},
                side_effecting=False,
                server_name="tools",
            ),
        ),
    )

    read_file = next(descriptor for descriptor in catalog if descriptor.name == "read_file")

    assert read_file.runtime_registered is True
    assert read_file.source_kind == "builtin"
    assert read_file.tool_family == "filesystem"
    assert read_file.server_name == "tools"
    assert "offset" in read_file.input_schema["properties"]
    assert "limit" in read_file.input_schema["properties"]
    assert "pages" not in read_file.input_schema["properties"]


def test_tool_catalog_exposes_external_page_fetch_guidance() -> None:
    fetch_url = next(
        descriptor for descriptor in build_tool_catalog() if descriptor.name == "fetch_url"
    )

    assert "correct tool for reading any external web page" in fetch_url.description
    assert "web_search" in fetch_url.description


def test_tool_catalog_exposes_manifest_config_schema_fields() -> None:
    catalog = build_tool_catalog()
    web_search = next(descriptor for descriptor in catalog if descriptor.name == "web_search")

    assert len(web_search.config_schema) == 1
    field = web_search.config_schema[0]
    assert field.key == "web"
    assert field.field_type == "toggle"
    assert field.storage == "config"
    assert field.default is False
    assert field.config_flag == "tools_web_enabled"
    assert field.tool_ids == ("web_search", "fetch_url")
    read_file = next(descriptor for descriptor in catalog if descriptor.name == "read_file")
    file_tools = next(item for item in read_file.config_schema if item.key == "fileTools")
    assert file_tools.field_type == "toggle"
    assert "edit_file" in file_tools.tool_ids


def test_tool_catalog_registers_delegate_as_the_only_subagent_runtime_tool() -> None:
    descriptor = next(
        item for item in build_tool_catalog() if item.name == "delegate"
    )
    names = {item.name for item in build_tool_catalog()}

    assert descriptor.runtime_registered is True
    assert descriptor.source_kind == "synthetic"
    assert descriptor.tool_family == "runtime"
    assert descriptor.availability.config_flag == "tools_subagents_enabled"
    assert descriptor.read_only is True
    assert "subagent_batch" not in names
    assert "subagent_run" not in names


def test_tool_catalog_includes_workspace_manifest_descriptor() -> None:
    catalog = build_tool_catalog()
    descriptor = next(item for item in catalog if item.name == "workspace_manifest_read")

    assert descriptor.read_only is True
    assert descriptor.tool_family == "filesystem"
    assert descriptor.availability.config_flag == "tools_workspace_manifest_enabled"
    assert descriptor.availability.workspace_required is True
    assert descriptor.input_schema == {"type": "object", "properties": {}, "required": []}


def test_tool_catalog_includes_default_off_worktree_bridge_descriptors() -> None:
    catalog = build_tool_catalog()
    by_name = {item.name: item for item in catalog}

    listed = by_name["worktree_list"]
    created = by_name["worktree_create"]

    assert listed.read_only is True
    assert listed.tool_family == "git"
    assert listed.surfaces == ("managed_sidecar",)
    assert listed.availability.config_flag == "tools_worktree_enabled"
    assert listed.availability.workspace_required is True
    assert listed.config_schema[0].key == "worktree"
    assert listed.config_schema[0].tool_ids == (
        "worktree_list",
        "worktree_create",
        "worktree_select",
        "worktree_delete",
    )

    assert created.read_only is False
    assert created.side_effecting is True
    assert created.tool_family == "git"
    assert created.surfaces == ("managed_sidecar",)
    assert created.availability.config_flag == "tools_worktree_enabled"
    assert created.input_schema["required"] == ["name"]


def test_tool_catalog_includes_default_off_automation_bridge_descriptors() -> None:
    catalog = build_tool_catalog()
    by_name = {item.name: item for item in catalog}

    listed = by_name["automation_list"]
    read = by_name["automation_read"]

    assert listed.read_only is True
    assert listed.tool_family == "runtime"
    assert listed.surfaces == ("managed_sidecar",)
    assert listed.availability.config_flag == "tools_automations_enabled"
    assert listed.availability.workspace_required is True
    assert listed.input_schema == {"type": "object", "properties": {}, "required": []}

    assert read.read_only is True
    assert read.side_effecting is False
    assert read.tool_family == "runtime"
    assert read.surfaces == ("managed_sidecar",)
    assert read.availability.config_flag == "tools_automations_enabled"
    assert read.input_schema["required"] == ["automation_id"]


def test_tool_catalog_includes_merged_lsp_descriptor() -> None:
    catalog = build_tool_catalog()
    lsp = next(item for item in catalog if item.name == "lsp")

    assert lsp.read_only is True
    assert lsp.side_effecting is False
    assert lsp.tool_family == "code_intelligence"
    assert lsp.surfaces == ("managed_sidecar", "builtin_mcp")
    assert lsp.availability.config_flag == "tools_lsp_enabled"
    assert lsp.availability.workspace_required is True
    assert lsp.config_schema[0].key == "lsp"
    assert lsp.config_schema[0].tool_ids == ("lsp",)
    assert lsp.input_schema["required"] == ["action", "path"]
    assert set(lsp.actions) == {"diagnostics", "symbols", "definition", "references"}


def test_tool_catalog_attaches_rich_file_config_to_read_file() -> None:
    catalog = build_tool_catalog()
    by_name = {item.name: item for item in catalog}
    read_file = by_name["read_file"]
    rich_files = next(item for item in read_file.config_schema if item.key == "richFiles")

    assert read_file.tool_family == "filesystem"
    assert read_file.surfaces == ("managed_sidecar", "builtin_mcp")
    assert read_file.availability.workspace_required is True
    assert read_file.read_only is True
    assert read_file.side_effecting is False
    assert rich_files.config_flag == "tools_rich_files_enabled"
    assert rich_files.tool_ids == ("read_file",)


def test_tool_catalog_includes_knowledge_descriptors() -> None:
    catalog = build_tool_catalog()
    by_name = {item.name: item for item in catalog}
    search = by_name["knowledge_search"]
    view = by_name["knowledge_view"]
    exec_descriptor = by_name["knowledge_exec"]

    for descriptor in (search, view, exec_descriptor):
        assert descriptor.tool_family == "knowledge"
        assert descriptor.surfaces == ("managed_sidecar", "builtin_mcp")
        # The exact RuntimeConfig field name — a mismatch silently no-ops filtering.
        assert descriptor.availability.config_flag == "tools_knowledge_enabled"
        # Knowledge roots are independent of the tools workspace root.
        assert descriptor.availability.workspace_required is False
        assert descriptor.read_only is True
        assert descriptor.side_effecting is False
    assert search.input_schema["required"] == ["pattern"]
    assert view.input_schema["required"] == ["path"]
    assert exec_descriptor.input_schema["required"] == ["op"]
    assert exec_descriptor.input_schema["properties"]["op"]["enum"] == [
        "ls",
        "tree",
        "find",
    ]


def test_tool_catalog_includes_runtime_registered_monitor_descriptor() -> None:
    catalog = build_tool_catalog(config={"tools_shell_enabled": True})
    descriptor = next(item for item in catalog if item.name == "monitor")

    assert descriptor.runtime_registered is True
    assert descriptor.source_kind == "synthetic"
    assert descriptor.tool_family == "shell"
    assert descriptor.side_effecting is True
    assert descriptor.read_only is False
    assert descriptor.surfaces == ("managed_sidecar",)
    assert descriptor.availability.config_flag == "tools_shell_enabled"
    assert descriptor.availability.workspace_required is True
    assert {"command", "description", "timeout_ms", "persistent"} <= set(
        descriptor.input_schema["properties"]
    )


def test_build_tool_catalog_normalizes_external_mcp_descriptors() -> None:
    catalog = build_tool_catalog(
        runtime_descriptors=(
            MCPToolDescriptor(
                name="external_lookup",
                description="Lookup external docs",
                input_schema={"type": "object", "properties": {"query": {"type": "string"}}},
                side_effecting=False,
                server_name="remote_docs",
            ),
        ),
    )

    external_lookup = next(
        descriptor for descriptor in catalog if descriptor.name == "external_lookup"
    )

    assert external_lookup.runtime_registered is True
    assert external_lookup.source_kind == "mcp"
    assert external_lookup.tool_family == "other"
    assert external_lookup.server_name == "remote_docs"


def test_build_tool_catalog_falls_back_to_object_schema_for_malformed_runtime_schemas() -> None:
    catalog = build_tool_catalog(
        runtime_descriptors=(
            SimpleNamespace(
                name="external_lookup",
                description="Lookup external docs",
                input_schema="invalid",
                side_effecting=False,
                server_name="remote_docs",
            ),
        ),
    )

    external_lookup = next(
        descriptor for descriptor in catalog if descriptor.name == "external_lookup"
    )

    assert external_lookup.input_schema == {"type": "object", "properties": {}}


def _minimal_manifest_entry(name: str, **overrides: object) -> dict[str, object]:
    entry: dict[str, object] = {
        "name": name,
        "description": "Test tool",
        "parameters": {"type": "object", "properties": {}},
        "category": "builtin",
        "source_kind": "builtin",
        "side_effecting": False,
        "read_only": True,
        "owner": "sidecar",
        "tool_family": "other",
        "surfaces": ["managed_sidecar"],
        "availability": {
            "config_flag": None,
            "workspace_required": False,
            "platforms": [],
            "defer_eligible": False,
            "always_available": False,
        },
    }
    entry.update(overrides)
    return entry


def _validate_manifest_with_entries(*entries: dict[str, object]) -> None:
    catalog_module._validate_manifest_payload(  # noqa: SLF001
        {"manifest_version": 2, "tools": list(entries)}
    )


@pytest.mark.parametrize("manifest_version", ["two", {"version": 2}, True])
def test_manifest_validation_rejects_malformed_manifest_version(
    manifest_version: object,
) -> None:
    with pytest.raises(ValueError, match="manifest_version 2"):
        catalog_module._validate_manifest_payload(  # noqa: SLF001
            {"manifest_version": manifest_version, "tools": []}
        )


def test_manifest_validation_rejects_invalid_surface_tokens() -> None:
    with pytest.raises(ValueError, match="bad_tool.*surfaces.*managed-sidecar"):
        _validate_manifest_with_entries(
            _minimal_manifest_entry("bad_tool", surfaces=["managed-sidecar"])
        )


@pytest.mark.parametrize(
    ("tool_family", "expected_message"),
    [
        ("mermaid", "tool_family.*mermaid"),
        ("", "tool_family must be a string"),
        (123, "tool_family must be a string"),
    ],
)
def test_manifest_validation_rejects_invalid_tool_family(
    tool_family: object,
    expected_message: str,
) -> None:
    with pytest.raises(ValueError, match=f"bad_tool.*{expected_message}"):
        _validate_manifest_with_entries(
            _minimal_manifest_entry("bad_tool", tool_family=tool_family)
        )


@pytest.mark.parametrize(
    ("availability_patch", "expected_message"),
    [
        ({"workspace_required": "true"}, "workspace_required"),
        ({"platforms": "win32"}, "platforms"),
        ({"config_flag": 123}, "config_flag"),
        ({"defer_eligible": "false"}, "defer_eligible"),
        ({"always_available": 1}, "always_available"),
    ],
)
def test_manifest_validation_rejects_malformed_availability_payload(
    availability_patch: dict[str, object],
    expected_message: str,
) -> None:
    availability = {
        "config_flag": None,
        "workspace_required": False,
        "platforms": [],
        "defer_eligible": False,
        "always_available": False,
        **availability_patch,
    }

    with pytest.raises(ValueError, match=f"bad_tool.*availability.*{expected_message}"):
        _validate_manifest_with_entries(
            _minimal_manifest_entry("bad_tool", availability=availability)
        )


def test_manifest_validation_rejects_malformed_config_schema_payload() -> None:
    with pytest.raises(ValueError, match="bad_tool.*config_schema.*field_type"):
        _validate_manifest_with_entries(
            _minimal_manifest_entry(
                "bad_tool",
                config_schema=[
                    {
                        "key": "bad",
                        "label": "Bad field",
                        "field_type": "button",
                        "storage": "config",
                        "default": False,
                    }
                ],
            )
        )


def test_manifest_validation_rejects_conflicting_config_schema_keys() -> None:
    with pytest.raises(ValueError, match="shared.*conflicting"):
        _validate_manifest_with_entries(
            _minimal_manifest_entry(
                "first_tool",
                config_schema=[
                    {
                        "key": "shared",
                        "label": "Shared",
                        "field_type": "toggle",
                        "storage": "config",
                        "default": False,
                        "tool_ids": ["first_tool"],
                    }
                ],
            ),
            _minimal_manifest_entry(
                "second_tool",
                config_schema=[
                    {
                        "key": "shared",
                        "label": "Different shared",
                        "field_type": "toggle",
                        "storage": "config",
                        "default": False,
                        "tool_ids": ["second_tool"],
                    }
                ],
            ),
        )


def test_manifest_validation_rejects_cross_tool_alias_collisions() -> None:
    with pytest.raises(ValueError, match="second.*alias.*Shared"):
        _validate_manifest_with_entries(
            _minimal_manifest_entry("first", aliases=["Shared"]),
            _minimal_manifest_entry("second", aliases=["Shared"]),
        )


def test_manifest_validation_rejects_unknown_synthetic_handlers() -> None:
    with pytest.raises(ValueError, match="future_synthetic.*synthetic handler"):
        _validate_manifest_with_entries(
            _minimal_manifest_entry("future_synthetic", source_kind="synthetic")
        )


def test_build_tool_catalog_preserves_manifest_server_name_when_runtime_has_none() -> None:
    catalog = build_tool_catalog(
        bound_names=("read_file",),
        bound_server_name="bound_tools",
        runtime_descriptors=(
            SimpleNamespace(
                name="read_file",
                description="Runtime read descriptor",
                input_schema={"type": "object", "properties": {}},
                side_effecting=False,
                server_name="",
            ),
        ),
    )

    read_file = next(descriptor for descriptor in catalog if descriptor.name == "read_file")

    assert read_file.server_name == "bound_tools"
