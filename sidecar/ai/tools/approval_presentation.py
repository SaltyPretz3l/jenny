"""Bounded, non-assuring approval-card copy derived from stable descriptor metadata."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from sidecar.ai.tools.tool_actions import effective_side_effecting

MAX_APPROVAL_POLICY_TEXT_CHARS = 120
NEUTRAL_APPROVAL_POLICY_TEXT = "Review requested input"
_APPROVAL_WORKSPACE_FAMILIES = frozenset({"filesystem", "git", "workspace", "code_intelligence"})
_APPROVAL_WEB_FAMILIES = frozenset({"browser", "web"})
_APPROVAL_CONTENT_FAMILIES = frozenset({"artifact", "diagram", "knowledge", "rich_files"})


@dataclass(frozen=True)
class ApprovalPresentation:
    policy_scope: str
    policy_consequence: str


def approval_presentation_for_call(
    descriptor: Any,
    arguments: dict[str, Any],
) -> ApprovalPresentation:
    """Map stable descriptor metadata to bounded, non-assuring approval copy."""

    name = str(getattr(descriptor, "name", "") or "").strip().lower()
    family = str(getattr(descriptor, "tool_family", "") or "").strip().lower()
    side_effecting = effective_side_effecting(descriptor, arguments)
    if name in {"run_command", "run_temp_script"}:
        scope = "Local command execution"
        consequence = "May run a local command and change local state."
    else:
        if family in _APPROVAL_WORKSPACE_FAMILIES:
            scope = "Workspace files"
        elif family in _APPROVAL_WEB_FAMILIES:
            scope = "Web and browser session"
        elif family == "todo":
            scope = "Jenny work items"
        elif family == "memory":
            scope = "Jenny's memory"
        elif family in _APPROVAL_CONTENT_FAMILIES:
            scope = "Jenny content"
        elif family in {"python", "runtime", "shell"}:
            scope = "Local computer"
        else:
            scope = "Requested tool"
        if side_effecting is True:
            consequence = "May change data in this scope."
        elif side_effecting is False:
            consequence = "May read data in this scope."
        else:
            consequence = NEUTRAL_APPROVAL_POLICY_TEXT
    return ApprovalPresentation(
        policy_scope=scope[:MAX_APPROVAL_POLICY_TEXT_CHARS],
        policy_consequence=consequence[:MAX_APPROVAL_POLICY_TEXT_CHARS],
    )
