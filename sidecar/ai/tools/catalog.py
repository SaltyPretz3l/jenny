"""Canonical tool descriptor catalog for Jenny-owned and external tools."""

from __future__ import annotations

import json
import sys
from copy import deepcopy
from dataclasses import dataclass, field, replace
from functools import lru_cache
from pathlib import Path
from typing import Any, Iterable

from sidecar.ai.tools.config_utils import ConfigField, config_value, normalize_config_field
from sidecar.ai.tools.manifest_validation import (  # noqa: F401
    BUILTIN_MCP_SURFACE,
    MANAGED_SIDECAR_SURFACE,
    validate_manifest_aliases,
    validate_manifest_availability,
    validate_manifest_surfaces,
    validate_manifest_tool_family,
)

# Re-exported deliberately: the catalog owns descriptor parsing, preconditions
# included, so consumers of CanonicalToolDescriptor.preconditions take the probe
# runtime (ProbeContext, run_probe) from here rather than importing the
# preconditions module a second time.
from sidecar.ai.tools.preconditions import (  # noqa: F401
    PreconditionSpec,
    ProbeContext,
    parse_tool_preconditions,
    run_probe,
)
from sidecar.ai.tools.tool_actions import (  # noqa: F401
    ToolActionSpec,
    coerce_scalar_side_effecting,
    effective_side_effecting,
    has_any_non_side_effecting_action,
    parse_tool_actions,
)

BUILTIN_MCP_SERVER_NAME = "jenny_local_tools"
_ALLOWED_SOURCE_KINDS = frozenset({"builtin", "synthetic"})
_SYNTHETIC_HANDLER_NAMES = frozenset(
    {
        # Reserved legacy id: never resolve an external tool by this retired name.
        "inspect_harness",
        "monitor",
        "check_monitor",
        "delegate",
        "tool_search",
    }
)
_REQUIRED_MANIFEST_FIELDS = frozenset(
    {"name", "description", "parameters", "category", "source_kind"}
)
_DISPLAY_NAME_OVERRIDES = {
    "check_background_job": "Background Job Status",
    "check_monitor": "Check Monitor",
    "create_artifact": "Create Artifact",
    "edit_file": "Edit File",
    "exit_plan_mode": "Exit Plan Mode",
    "fetch_url": "Fetch URL",
    "glob_files": "Glob Files",
    "grep_search": "Grep Search",
    "list_dir": "List Directory",
    "jenny_status": "Jenny Status",
    "mermaid_generate": "Mermaid Generate",
    "monitor": "Monitor",
    "python_execute": "Python Runtime",
    "read_file": "Read File",
    "run_command": "Run Command",
    "run_temp_script": "Run Temporary Script",
    "stop_background_job": "Stop Background Job",
    "delegate": "Delegate",
    "todo_read": "Todo Read",
    "todo_write": "Todo Write",
    "tool_search": "Tool Search",
    "web_search": "Web Search",
    "workspace_manifest_read": "Workspace Manifest",
    "write_file": "Write File",
}


@dataclass(frozen=True)
class CanonicalToolAvailability:
    config_flag: str | None = None
    workspace_required: bool = False
    platforms: tuple[str, ...] = ()
    defer_eligible: bool = False
    always_available: bool = False
    plan_mode_only: bool = False
    plan_mode_artifact_write: bool = False


@dataclass(frozen=True)
class CanonicalToolDescriptor:
    name: str
    description: str
    input_schema: dict[str, Any]
    side_effecting: bool
    read_only: bool
    workflow_eligible: bool = False
    category: str = "builtin"
    source_kind: str = "builtin"
    tool_family: str = "other"
    aliases: tuple[str, ...] = ()
    surfaces: tuple[str, ...] = (MANAGED_SIDECAR_SURFACE,)
    availability: CanonicalToolAvailability = field(default_factory=CanonicalToolAvailability)
    server_name: str | None = None
    runtime_registered: bool = False
    search_hint: str = ""
    config_schema: tuple[ConfigField, ...] = ()
    preconditions: tuple[PreconditionSpec, ...] = ()
    actions: dict[str, ToolActionSpec] | None = None


def tool_manifest_path() -> Path:
    bundled_root = getattr(sys, "_MEIPASS", None)
    if bundled_root:
        return Path(bundled_root) / "services" / "tools" / "tool-manifest.json"
    return Path(__file__).resolve().parents[3] / "services" / "tools" / "tool-manifest.json"


@lru_cache(maxsize=1)
def _manifest_payload() -> dict[str, Any]:
    payload = json.loads(tool_manifest_path().read_text(encoding="utf-8"))
    _validate_manifest_payload(payload)
    return payload


def _validate_manifest_payload(payload: Any) -> None:
    if not isinstance(payload, dict):
        raise ValueError("services/tools/tool-manifest.json must be a JSON object")
    manifest_version = payload.get("manifest_version")
    if (
        isinstance(manifest_version, bool)
        or not isinstance(manifest_version, int)
        or manifest_version != 2
    ):
        raise ValueError("services/tools/tool-manifest.json must be manifest_version 2")
    tools = payload.get("tools")
    if not isinstance(tools, list):
        raise ValueError("services/tools/tool-manifest.json tools must be a list")

    seen_names: set[str] = set()
    seen_aliases: dict[str, str] = {}
    seen_config_fields: dict[str, ConfigField] = {}
    for index, raw_entry in enumerate(tools):
        if not isinstance(raw_entry, dict):
            raise ValueError(f"tool manifest entry {index} must be an object")
        config_fields = _validate_manifest_entry(raw_entry, index=index)
        name = str(raw_entry.get("name") or "").strip()
        if name in seen_names:
            raise ValueError(f"tool manifest entry {name} duplicates a tool name")
        if name in seen_aliases:
            owner = seen_aliases[name]
            raise ValueError(f"tool manifest entry {name} collides with alias from {owner}")
        seen_names.add(name)
        for alias in _normalize_aliases(raw_entry.get("aliases")):
            if alias in seen_names:
                raise ValueError(
                    f"tool manifest entry {name} alias {alias} collides with tool name"
                )
            if alias in seen_aliases:
                owner = seen_aliases[alias]
                raise ValueError(f"tool manifest entry {name} alias {alias} collides with {owner}")
            seen_aliases[alias] = name
        _validate_manifest_config_field_collisions(seen_config_fields, config_fields)


def _validate_manifest_entry(entry: dict[str, Any], *, index: int) -> tuple[ConfigField, ...]:
    name = str(entry.get("name") or "").strip()
    label = name or f"entry {index}"
    missing = sorted(field for field in _REQUIRED_MANIFEST_FIELDS if field not in entry)
    if missing:
        raise ValueError(f"tool manifest entry {label} missing required fields: {missing}")
    if not name:
        raise ValueError(f"tool manifest entry {index} has empty name")
    for field_name in ("description", "category", "source_kind"):
        value = entry.get(field_name)
        if not isinstance(value, str) or not value.strip():
            raise ValueError(f"tool manifest entry {label} field {field_name} must be a string")
    if not isinstance(entry.get("parameters"), dict):
        raise ValueError(f"tool manifest entry {label} parameters must be an object")
    workflow_eligible = entry.get("workflow_eligible", False)
    if not isinstance(workflow_eligible, bool):
        raise ValueError(
            f"tool manifest entry {label} workflow_eligible must be a bool"
        )
    if workflow_eligible and (
        entry.get("read_only") is not True or entry.get("side_effecting") is not False
    ):
        raise ValueError(
            f"tool manifest entry {label} workflow eligibility requires a read-only descriptor"
        )

    source_kind = str(entry.get("source_kind") or "").strip()
    if source_kind not in _ALLOWED_SOURCE_KINDS:
        raise ValueError(f"tool manifest entry {label} source_kind is invalid: {source_kind}")
    if source_kind == "synthetic" and name not in _SYNTHETIC_HANDLER_NAMES:
        raise ValueError(f"tool manifest entry {label} has no registered synthetic handler")

    validate_manifest_tool_family(entry.get("tool_family"), label=label)
    validate_manifest_surfaces(entry.get("surfaces"), label=label)
    validate_manifest_availability(entry.get("availability"), label=label)
    availability = entry.get("availability")
    if (
        isinstance(availability, dict)
        and availability.get("plan_mode_artifact_write") is True
        and name not in {"create_artifact", "mermaid_generate"}
    ):
        raise ValueError(
            f"tool manifest entry {label} cannot declare plan_mode_artifact_write"
        )
    validate_manifest_aliases(entry.get("aliases"), label=label)
    return _normalize_manifest_config_schema(
        entry.get("config_schema"),
        label=label,
        strict_list=True,
    )


def _normalize_manifest_config_schema(
    value: Any,
    *,
    label: str,
    strict_list: bool,
) -> tuple[ConfigField, ...]:
    if value is None:
        return ()
    if not isinstance(value, list):
        if strict_list:
            raise ValueError(f"tool manifest entry {label} config_schema must be a list")
        return ()
    return tuple(normalize_config_field(raw_field, tool_name=label) for raw_field in value)


def _config_field_signature(field: ConfigField) -> tuple[Any, ...]:
    return (
        field.label,
        field.field_type,
        field.storage,
        field.default,
        field.help_text,
        field.config_flag,
    )


def _validate_manifest_config_field_collisions(
    seen_config_fields: dict[str, ConfigField],
    config_fields: tuple[ConfigField, ...],
) -> None:
    for config_field in config_fields:
        existing_field = seen_config_fields.get(config_field.key)
        if existing_field is not None and _config_field_signature(
            existing_field
        ) != _config_field_signature(config_field):
            raise ValueError(
                "tool manifest config_schema field "
                f"{config_field.key} has conflicting definitions"
            )
        seen_config_fields.setdefault(config_field.key, config_field)


@lru_cache(maxsize=1)
def _manifest_entries_by_name() -> dict[str, dict[str, Any]]:
    tools = _manifest_payload().get("tools")
    entries: dict[str, dict[str, Any]] = {}
    if not isinstance(tools, list):
        return entries
    for raw_entry in tools:
        if not isinstance(raw_entry, dict):
            continue
        name = str(raw_entry.get("name") or "").strip()
        if not name:
            continue
        entries[name] = raw_entry
    return entries


def manifest_tool_entry(name: str) -> dict[str, Any] | None:
    return _manifest_entries_by_name().get(str(name or "").strip())


def electron_owned_manifest_entries() -> tuple[dict[str, Any], ...]:
    """Manifest entries whose runtime the Electron host owns.

    ``owner: "electron"`` is the canonical marker for a tool that Electron
    registers and executes. The sidecar can only advertise such a tool to a
    provider by registering an Electron-bridge runtime descriptor for it, so
    this accessor is the single source the resolver and its parity test share.
    """
    return tuple(
        entry
        for entry in _manifest_entries_by_name().values()
        if str(entry.get("owner") or "").strip() == "electron"
    )


def tool_display_name(name: str) -> str:
    token = str(name or "").strip()
    if token in _DISPLAY_NAME_OVERRIDES:
        return _DISPLAY_NAME_OVERRIDES[token]
    return token.replace("_", " ").title() or "Tool"


def infer_tool_source_kind(
    tool_name: str,
    *,
    server_name: str | None = None,
) -> str:
    normalized_tool_name = str(tool_name or "").strip()
    normalized_server_name = str(server_name or "").strip()
    if normalized_server_name:
        return "builtin" if normalized_server_name == BUILTIN_MCP_SERVER_NAME else "mcp"
    manifest_entry = manifest_tool_entry(normalized_tool_name)
    if manifest_entry is not None:
        return str(manifest_entry.get("source_kind") or "builtin").strip() or "builtin"
    return "mcp"


def infer_tool_family(tool_name: str) -> str:
    normalized = str(tool_name or "").strip()
    manifest_entry = manifest_tool_entry(normalized)
    if manifest_entry is not None:
        return str(manifest_entry.get("tool_family") or "other").strip() or "other"
    lowered = normalized.lower()
    if lowered.startswith("git_"):
        return "git"
    if lowered.startswith("mcp__"):
        return "other"
    if lowered in {
        "read_file",
        "write_file",
        "edit_file",
        "list_dir",
        "glob_files",
        "grep_search",
        "workspace_manifest_read",
    }:
        return "filesystem"
    if lowered in {
        "run_command",
        "run_temp_script",
        "check_background_job",
        "stop_background_job",
        "monitor",
    }:
        return "shell"
    if lowered in {"web_search", "fetch_url"}:
        return "web"
    if lowered in {"todo_read", "todo_write"}:
        return "todo"
    return "other"


def _bool_config_value(config: Any | None, key: str, *, default: bool) -> bool:
    value = config_value(config, key, default)
    return value if isinstance(value, bool) else default


def _default_surfaces(source_kind: str) -> tuple[str, ...]:
    if source_kind == "synthetic":
        return (MANAGED_SIDECAR_SURFACE,)
    if source_kind == "builtin":
        return (MANAGED_SIDECAR_SURFACE, BUILTIN_MCP_SURFACE)
    return (MANAGED_SIDECAR_SURFACE,)


def _normalize_aliases(value: Any) -> tuple[str, ...]:
    if not isinstance(value, list):
        return ()
    aliases: list[str] = []
    for raw_alias in value:
        alias = str(raw_alias or "").strip()
        if alias and alias not in aliases:
            aliases.append(alias)
    return tuple(aliases)


def _normalize_surfaces(value: Any, *, source_kind: str) -> tuple[str, ...]:
    if not isinstance(value, list):
        return _default_surfaces(source_kind)
    surfaces: list[str] = []
    for raw_surface in value:
        surface = str(raw_surface or "").strip()
        if surface and surface not in surfaces:
            surfaces.append(surface)
    return tuple(surfaces) or _default_surfaces(source_kind)


def _normalize_availability(value: Any) -> CanonicalToolAvailability:
    payload = value if isinstance(value, dict) else {}
    config_flag = payload.get("config_flag")
    normalized_config_flag = (
        str(config_flag).strip()
        if isinstance(config_flag, str) and str(config_flag).strip()
        else None
    )
    raw_platforms = payload.get("platforms")
    platforms = (
        tuple(
            str(item).strip()
            for item in raw_platforms
            if isinstance(item, str) and str(item).strip()
        )
        if isinstance(raw_platforms, list)
        else ()
    )
    return CanonicalToolAvailability(
        config_flag=normalized_config_flag,
        workspace_required=payload.get("workspace_required") is True,
        platforms=platforms,
        defer_eligible=payload.get("defer_eligible") is True,
        always_available=payload.get("always_available") is True,
        plan_mode_only=payload.get("plan_mode_only") is True,
        plan_mode_artifact_write=payload.get("plan_mode_artifact_write") is True,
    )


def _schema_with_runtime_overrides(
    tool_name: str,
    input_schema: dict[str, Any],
    *,
    config: Any | None,
) -> dict[str, Any]:
    schema = deepcopy(input_schema)
    if tool_name == "read_file" and not _bool_config_value(
        config,
        "tools_image_read_enabled",
        default=False,
    ):
        properties = schema.get("properties")
        if isinstance(properties, dict):
            properties.pop("pages", None)
    return schema


def _manifest_descriptor(entry: dict[str, Any], *, config: Any | None) -> CanonicalToolDescriptor:
    name = str(entry.get("name") or "").strip()
    source_kind = str(entry.get("source_kind") or "builtin").strip() or "builtin"
    availability = _normalize_availability(entry.get("availability"))
    input_schema = entry.get("parameters")
    if not isinstance(input_schema, dict):
        input_schema = {"type": "object", "properties": {}}
    actions = parse_tool_actions(entry.get("actions"))
    side_effecting = coerce_scalar_side_effecting(bool(entry.get("side_effecting", False)), actions)
    read_only = bool(entry.get("read_only", not side_effecting)) and not side_effecting
    return CanonicalToolDescriptor(
        name=name,
        description=str(entry.get("description") or "").strip(),
        input_schema=_schema_with_runtime_overrides(name, input_schema, config=config),
        side_effecting=side_effecting,
        read_only=read_only,
        workflow_eligible=entry.get("workflow_eligible") is True,
        category=str(entry.get("category") or "builtin").strip() or "builtin",
        source_kind=source_kind,
        tool_family=str(entry.get("tool_family") or infer_tool_family(name)).strip() or "other",
        aliases=_normalize_aliases(entry.get("aliases")),
        surfaces=_normalize_surfaces(entry.get("surfaces"), source_kind=source_kind),
        availability=availability,
        server_name="__synthetic__" if source_kind == "synthetic" else None,
        runtime_registered=name in _SYNTHETIC_HANDLER_NAMES,
        config_schema=_normalize_manifest_config_schema(
            entry.get("config_schema"),
            label=name,
            strict_list=False,
        ),
        preconditions=parse_tool_preconditions(entry.get("preconditions")),
        actions=actions,
    )


def manifest_descriptors(*, config: Any | None = None) -> tuple[CanonicalToolDescriptor, ...]:
    descriptors = [
        _manifest_descriptor(entry, config=config) for entry in _manifest_entries_by_name().values()
    ]
    return tuple(sorted(descriptors, key=lambda descriptor: descriptor.name))


def normalize_runtime_descriptor(descriptor: Any) -> CanonicalToolDescriptor:
    name = str(getattr(descriptor, "name", "") or "").strip()
    server_name = str(getattr(descriptor, "server_name", "") or "").strip() or None
    raw_input_schema = getattr(descriptor, "input_schema", {})
    input_schema = (
        deepcopy(raw_input_schema)
        if isinstance(raw_input_schema, dict)
        else {
            "type": "object",
            "properties": {},
        }
    )
    source_kind = str(
        getattr(descriptor, "source_kind", "") or ""
    ).strip() or infer_tool_source_kind(
        name,
        server_name=server_name,
    )
    defer_eligible = source_kind == "mcp"
    actions = getattr(descriptor, "actions", None)
    side_effecting = coerce_scalar_side_effecting(
        bool(getattr(descriptor, "side_effecting", False)), actions
    )
    return CanonicalToolDescriptor(
        name=name,
        description=str(getattr(descriptor, "description", "") or "").strip(),
        input_schema=input_schema,
        side_effecting=side_effecting,
        read_only=not side_effecting,
        category="builtin" if source_kind == "builtin" else "mcp",
        source_kind=source_kind,
        tool_family=str(getattr(descriptor, "tool_family", "") or "").strip()
        or infer_tool_family(name),
        aliases=(),
        surfaces=_default_surfaces(source_kind),
        availability=CanonicalToolAvailability(defer_eligible=defer_eligible),
        server_name=server_name,
        runtime_registered=True,
        search_hint=str(getattr(descriptor, "search_hint", "") or "").strip(),
        actions=actions,
    )


def build_tool_catalog(
    *,
    config: Any | None = None,
    runtime_descriptors: Iterable[Any] = (),
    bound_names: Iterable[str] = (),
    bound_server_name: str = BUILTIN_MCP_SERVER_NAME,
) -> tuple[CanonicalToolDescriptor, ...]:
    catalog: dict[str, CanonicalToolDescriptor] = {
        descriptor.name: descriptor for descriptor in manifest_descriptors(config=config)
    }

    for raw_name in bound_names:
        name = str(raw_name or "").strip()
        if not name or name not in catalog:
            continue
        catalog[name] = replace(
            catalog[name],
            server_name=bound_server_name,
            runtime_registered=True,
        )

    for runtime_descriptor in runtime_descriptors:
        normalized = normalize_runtime_descriptor(runtime_descriptor)
        current = catalog.get(normalized.name)
        if current is None:
            catalog[normalized.name] = normalized
            continue
        catalog[normalized.name] = replace(
            current,
            server_name=normalized.server_name or current.server_name,
            runtime_registered=True,
            search_hint=normalized.search_hint or current.search_hint,
        )

    return tuple(sorted(catalog.values(), key=lambda descriptor: descriptor.name))


@lru_cache(maxsize=1)
def builtin_tool_names() -> frozenset[str]:
    return frozenset(
        descriptor.name
        for descriptor in manifest_descriptors()
        if descriptor.source_kind == "builtin"
    )


@lru_cache(maxsize=1)
def reserved_tool_names() -> frozenset[str]:
    """Return tool ids that external MCP bare-name compat may not claim."""
    return builtin_tool_names() | _SYNTHETIC_HANDLER_NAMES
