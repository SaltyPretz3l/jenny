"""Per-action tool safety metadata."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

_MAX_TOOL_ACTION_NAME_CHARS = 64


@dataclass(frozen=True)
class ToolActionSpec:
    side_effecting: bool


def parse_tool_actions(raw: Any) -> dict[str, ToolActionSpec] | None:
    if not isinstance(raw, dict):
        return None
    actions: dict[str, ToolActionSpec] = {}
    for raw_name, raw_spec in raw.items():
        if not isinstance(raw_name, str):
            continue
        name = raw_name.strip()
        # Composite permission keys tool:action are only injective while both
        # segments are colon-free.
        if (
            not name
            or len(name) > _MAX_TOOL_ACTION_NAME_CHARS
            or ":" in name
            or any(char.isspace() or not char.isprintable() for char in name)
        ):
            continue
        side_effecting = raw_spec.get("side_effecting") if isinstance(raw_spec, dict) else None
        actions[name] = ToolActionSpec(
            side_effecting=side_effecting if isinstance(side_effecting, bool) else True
        )
    return actions or None


def coerce_scalar_side_effecting(
    side_effecting: bool,
    actions: dict[str, ToolActionSpec] | None,
) -> bool:
    """A descriptor carrying any write action must never present a read scalar —
    downstream enforcement (mode gates, coerced-argument validation, the operation
    ledger, envelope effects) still keys on the scalar.
    """

    if actions and any(
        # Duck descriptors can carry unparsed action specs; a malformed spec
        # counts as a write so the coercion stays fail-closed.
        getattr(spec, "side_effecting", True)
        for spec in actions.values()
    ):
        return True
    return side_effecting


def has_any_non_side_effecting_action(descriptor: Any) -> bool:
    actions = getattr(descriptor, "actions", None)
    return isinstance(actions, dict) and bool(actions) and any(
        getattr(spec, "side_effecting", True) is False for spec in actions.values()
    )


def declared_action(descriptor: Any, arguments: dict[str, Any]) -> str:
    actions = getattr(descriptor, "actions", None)
    action = arguments.get("action") if isinstance(arguments, dict) else None
    if isinstance(actions, dict) and isinstance(action, str) and action in actions:
        return action
    return ""


def effective_side_effecting(descriptor: Any, arguments: dict[str, Any]) -> bool | None:
    actions = getattr(descriptor, "actions", None)
    if not actions:
        return getattr(descriptor, "side_effecting", None)
    action = declared_action(descriptor, arguments)
    if not action:
        return True
    spec = actions.get(action)
    return spec.side_effecting if isinstance(spec, ToolActionSpec) else True
