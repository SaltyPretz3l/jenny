"""Budget-filter guarantees that pair or prefer tools under context pressure.

A kept side-effecting tool brings its safer partner, so the model never holds only
the risky half: ``delete_file`` brings ``move_file``, and ``session_stop`` brings
``session_status`` (row 69 gate run: with only ``session_stop`` left, the model
called it to answer "what is that chat doing?"). The primary Jenny chat also
prefers its directory read tools, since reading chats is its main job.
"""

from __future__ import annotations

from dataclasses import replace
from typing import Any

from sidecar.ai.context.primary_chat_overlay import PRIMARY_SESSION_ROLE

# (kept tool, partner it brings) pairs.
_PAIRED_TOOLS = (
    ("delete_file", "move_file"),
    ("session_stop", "session_status"),
)
_PRIMARY_DIRECTORY_TOOLS = ("sessions_list", "session_status", "session_transcript")


def primary_directory_tool_names(request_context: object) -> tuple[str, ...]:
    """The primary chat's directory read tools, preferred under pressure; else none."""
    if getattr(request_context, "session_role", None) != PRIMARY_SESSION_ROLE:
        return ()
    return _PRIMARY_DIRECTORY_TOOLS


def pair_kept_partners(
    plan: Any, candidate_names: tuple[str, ...], preferred_names: tuple[str, ...],
) -> Any:
    """Add each kept tool's partner, evicting the last ordinary kept tool to stay in the cap."""
    for anchor, partner in _PAIRED_TOOLS:
        plan = _pair_one(plan, candidate_names, preferred_names, anchor, partner)
    return plan


def _pair_one(
    plan: Any,
    candidate_names: tuple[str, ...],
    preferred_names: tuple[str, ...],
    anchor: str,
    partner: str,
) -> Any:
    if (
        anchor not in plan.kept_names
        or partner in plan.kept_names
        or partner not in candidate_names
    ):
        return plan
    kept = [*plan.kept_names, partner]
    filtered = plan.filtered_names - {partner}
    if len(kept) > plan.cap:
        protected = {name for pair in _PAIRED_TOOLS for name in pair if name in kept}
        for name in reversed(kept):
            if (
                name not in plan.mandatory_names
                and name not in protected
                and name not in preferred_names
            ):
                kept.remove(name)
                filtered |= {name}
                break
        # Keep the +1 if nothing is evictable: pairing is safety and the anchor was kept.
    return replace(plan, kept_names=tuple(kept), filtered_names=filtered)


__all__ = ["pair_kept_partners", "primary_directory_tool_names"]
