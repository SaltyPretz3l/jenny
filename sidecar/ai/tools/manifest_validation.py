"""Field validators for canonical tool-manifest entries."""

from __future__ import annotations

from typing import Any

from sidecar.ai.tools.tool_families import KNOWN_TOOL_FAMILIES

MANAGED_SIDECAR_SURFACE = "managed_sidecar"
BUILTIN_MCP_SURFACE = "builtin_mcp"
_ALLOWED_SURFACES = frozenset({MANAGED_SIDECAR_SURFACE, BUILTIN_MCP_SURFACE})
_ALLOWED_TOOL_FAMILIES = KNOWN_TOOL_FAMILIES
_AVAILABILITY_BOOL_FIELDS = frozenset(
    {
        "workspace_required",
        "defer_eligible",
        "always_available",
        "plan_mode_only",
        "plan_mode_artifact_write",
    }
)


def validate_manifest_tool_family(value: Any, *, label: str) -> None:
    if value is None:
        return
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"tool manifest entry {label} tool_family must be a string")
    tool_family = value.strip()
    if tool_family not in _ALLOWED_TOOL_FAMILIES:
        raise ValueError(
            f"tool manifest entry {label} tool_family contains invalid token: {tool_family}"
        )


def validate_manifest_surfaces(value: Any, *, label: str) -> None:
    if value is None:
        return
    if not isinstance(value, list):
        raise ValueError(f"tool manifest entry {label} surfaces must be a list")
    for raw_surface in value:
        surface = str(raw_surface or "").strip() if isinstance(raw_surface, str) else ""
        if surface not in _ALLOWED_SURFACES:
            raise ValueError(
                f"tool manifest entry {label} surfaces contains invalid token: {raw_surface}"
            )


def validate_manifest_availability(value: Any, *, label: str) -> None:
    if value is None:
        return
    if not isinstance(value, dict):
        raise ValueError(f"tool manifest entry {label} availability must be an object")
    config_flag = value.get("config_flag")
    if config_flag is not None and not isinstance(config_flag, str):
        raise ValueError(f"tool manifest entry {label} availability config_flag must be a string")
    platforms = value.get("platforms")
    if platforms is not None:
        if not isinstance(platforms, list) or not all(isinstance(item, str) for item in platforms):
            raise ValueError(
                f"tool manifest entry {label} availability platforms must be a string list"
            )
    for field_name in _AVAILABILITY_BOOL_FIELDS:
        field_value = value.get(field_name)
        if field_value is not None and not isinstance(field_value, bool):
            raise ValueError(
                f"tool manifest entry {label} availability {field_name} must be a bool"
            )


def validate_manifest_aliases(value: Any, *, label: str) -> None:
    if value is None:
        return
    if not isinstance(value, list):
        raise ValueError(f"tool manifest entry {label} aliases must be a list")
    for alias in value:
        if not isinstance(alias, str) or not alias.strip():
            raise ValueError(f"tool manifest entry {label} aliases must contain non-empty strings")
