"""Approval-resume system-prefix reconstruction.

Extracted from ``chat_resume.py`` (file-size ceiling). The approval path
freezes a plan's ``working_messages`` and, on resume, rebuilds the leading
system run from LIVE config so a renamed assistant or a changed skill set
reaches the model. Only the regenerated overlays may be replaced -- everything
downstream of them, including Electron's typed context blocks, must survive
byte-identical or the drift hash reports a false ``message_history`` mismatch.
"""

from __future__ import annotations

from typing import Any

from sidecar.ai.config_models import uses_minimal_system_prompt
from sidecar.ai.context.builder import ContextBuilder
from sidecar.ai.personality import is_personality_overlay_system_message
from sidecar.runtime.approval_plan import ApprovalPlan


def plan_personality_block_present(plan: Any) -> bool:
    """Did the FROZEN turn render its ``## Personality`` row from the block?

    Reads the decision ``build_approval_plan`` recorded at freeze time; it does
    NOT re-derive it. Recomputing against LIVE config is wrong whenever the
    engine changed between freeze and approval:

    * frozen minimal (block on the wire but zero personality rows emitted),
      resumed non-minimal -> a structural read says True, so the bare overlay
      is suppressed and there is no frozen row to keep: ZERO rows.
    * frozen non-minimal with a block, resumed minimal -> a structural read
      would let the frozen block row survive into a minimal turn.

    Single source for BOTH the overlay-suppression flag used when rebuilding
    the live overlays and the prefix-scan rule below; if those two answers
    disagree the resume drift hash reports a phantom ``message_history``
    mismatch. Production approval plans always record this boolean; a
    missing/None plan is False.
    """
    return plan is not None and bool(plan.personality_rendered)


def personality_row_is_replaceable(plan: Any, config: Any) -> bool:
    """May a ``## Personality`` row in the frozen prefix be dropped or replaced?

    Two independent reasons it may, and the scan needs both folded together:

    * the LIVE profile is minimal -- a rebuilt turn would render no personality
      row at all, so a frozen block row must not survive into it; and
    * the frozen turn rendered no block, which makes its ``## Personality`` row
      the bare overlay this module regenerates.

    Only when neither holds is the row the frozen, Electron-compiled block that
    carries the user's note, and it must survive byte-identical.
    """
    if uses_minimal_system_prompt(config):
        return True
    return not plan_personality_block_present(plan)


def _is_live_dynamic_system_message(
    content: Any,
    *,
    personality_row_replaceable: bool = True,
) -> bool:
    """Does this row belong to the regenerated live prefix?

    ``## Personality`` names two different rows -- the bare overlay this module
    regenerates and the frozen, Electron-compiled context block -- and they are
    told apart by ``personality_row_is_replaceable``: the FROZEN decision plus
    the LIVE profile, never by position or by text.

    A positional rule ("the row right after the base prompt") is NOT sufficient:
    with no skills configured the live overlay list is empty, so a personality
    context block sits at offset 0 and would be swallowed.
    """
    text = str(content or "")
    if is_personality_overlay_system_message(text):
        return personality_row_replaceable
    if ContextBuilder.is_skills_system_message(text):
        return True
    return ContextBuilder.is_runtime_system_message(text)


def _build_live_approval_working_messages(
    plan: ApprovalPlan,
    *,
    live_system_prompt: Any,
    dynamic_system_messages: list[dict[str, Any]] | None = None,
    personality_row_replaceable: bool = True,
) -> list[dict[str, Any]]:
    working_messages = [dict(item) for item in plan.working_messages]
    replacement = [
        {"role": "system", "content": str(live_system_prompt)},
        *(dynamic_system_messages or []),
    ]
    if not working_messages:
        return replacement
    prefix_end = 1
    for item in working_messages[1:]:
        if str(item.get("role") or "") != "system":
            break
        if not _is_live_dynamic_system_message(
            item.get("content"),
            personality_row_replaceable=personality_row_replaceable,
        ):
            break
        prefix_end += 1
    return [*replacement, *working_messages[prefix_end:]]


__all__ = [
    "_build_live_approval_working_messages",
    "_is_live_dynamic_system_message",
    "personality_row_is_replaceable",
    "plan_personality_block_present",
]
