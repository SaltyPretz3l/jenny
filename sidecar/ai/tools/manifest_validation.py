"""Field validators for canonical tool-manifest entries."""

from __future__ import annotations

from typing import Any

from sidecar.ai.tools.preconditions import PRECONDITION_PROBES, PRECONDITION_SEVERITIES
from sidecar.ai.tools.tool_actions import valid_tool_action_name
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
        "propose_mode_only",
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


def validate_manifest_safety(entry: dict[str, Any], *, label: str) -> None:
    """Fail closed on the safety-bearing fields a lenient parse would silently default.

    ``side_effecting`` and ``availability.workspace_required`` must be explicit,
    ``actions`` and ``preconditions`` must parse without dropping an item, and the
    scalar must agree with the declared actions, ``read_only`` and
    ``always_available`` (which bypasses every later availability gate).
    """
    side_effecting = entry.get("side_effecting")
    if not isinstance(side_effecting, bool):
        raise ValueError(f"tool manifest entry {label} side_effecting must be a bool")
    read_only = entry.get("read_only")
    if read_only is not None and not isinstance(read_only, bool):
        raise ValueError(f"tool manifest entry {label} read_only must be a bool")
    if read_only is True and side_effecting:
        raise ValueError(f"tool manifest entry {label} cannot be read_only and side_effecting")
    availability = entry.get("availability")
    if not isinstance(availability, dict) or "workspace_required" not in availability:
        raise ValueError(
            f"tool manifest entry {label} availability.workspace_required must be declared"
        )
    actions = entry.get("actions")
    if actions is not None:
        _validate_manifest_actions(actions, label=label)
        if not side_effecting and any(spec["side_effecting"] for spec in actions.values()):
            raise ValueError(
                f"tool manifest entry {label} side_effecting false contradicts a write action"
            )
    if availability.get("always_available") is True and (side_effecting or actions is not None):
        raise ValueError(
            f"tool manifest entry {label} always_available requires a read-only, action-free tool"
        )
    preconditions = entry.get("preconditions")
    if preconditions is not None:
        _validate_manifest_preconditions(preconditions, label=label)


def _validate_manifest_actions(actions: Any, *, label: str) -> None:
    if not isinstance(actions, dict) or not actions:
        raise ValueError(f"tool manifest entry {label} actions must be a non-empty object")
    for name, spec in actions.items():
        if not isinstance(name, str) or not valid_tool_action_name(name) or name != name.strip():
            raise ValueError(f"tool manifest entry {label} action name is invalid: {name!r}")
        if (
            not isinstance(spec, dict)
            or set(spec) != {"side_effecting"}
            or not isinstance(spec["side_effecting"], bool)
        ):
            raise ValueError(
                f"tool manifest entry {label} action {name} must be {{\"side_effecting\": bool}}"
            )


def _validate_manifest_preconditions(preconditions: Any, *, label: str) -> None:
    if not isinstance(preconditions, list):
        raise ValueError(f"tool manifest entry {label} preconditions must be a list")
    seen: set[str] = set()
    for item in preconditions:
        if not isinstance(item, dict) or set(item) - {"id", "probe", "severity"}:
            raise ValueError(f"tool manifest entry {label} precondition is invalid: {item!r}")
        precondition_id = item.get("id")
        if (
            not isinstance(precondition_id, str)
            or not precondition_id.strip()
            or precondition_id != precondition_id.strip()
            or precondition_id in seen
        ):
            raise ValueError(
                f"tool manifest entry {label} precondition id is invalid: {precondition_id!r}"
            )
        seen.add(precondition_id)
        probe = item.get("probe")
        if not isinstance(probe, str) or probe not in PRECONDITION_PROBES:
            raise ValueError(
                f"tool manifest entry {label} precondition {precondition_id} probe is unknown: "
                f"{probe!r}"
            )
        if item.get("severity", "blocking") not in PRECONDITION_SEVERITIES:
            raise ValueError(
                f"tool manifest entry {label} precondition {precondition_id} severity is invalid"
            )
