"""Rebuild the live system prefix a paused turn's approval is compared against.

Split out of ``chat_resume`` (file-size ceiling). The approval plan freezes the
system prompt and the leading system rows the turn rendered; the resume
rebuilds both from LIVE config and refuses on any difference.

The rebuild takes the request's tool statuses, and those are not fixed for the
life of a turn: a ``tool_search`` call un-defers the tools it discovers on the
request's ``ToolResolutionContext``, which is what makes them callable on the
next iteration. The prompt is not re-rendered when that happens, so a turn that
searched and then paused on an approval froze a prompt listing the discovered
tool as deferred, while a rebuild from the live statuses lists it as available.
That self-inflicted difference preempted the approved call (HB-018).

So the frozen text is compared against every tool-availability state the turn
itself passed through: the live state (unchanged behaviour, tried first), the
turn-start state (the un-deferrals the turn derived from history, exactly as
``chat_decision`` derives them), and that state plus each of the turn's own
discoveries in order (a plan-exit resume re-renders the prompt mid-turn). The
states differ only in which of the turn's OWN discoveries are exposed. Every
rebuild still takes the live base prompt, workspace instructions, catalog,
modes and preferences, so an external change still refuses; external tool-set
drift is also caught by the separate ``tool_contract`` comparison.
"""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass, replace
from typing import Any

from sidecar.ai.tools.tool_search import TOOL_SEARCH_RESULT_KIND, scan_history_for_undeferrals
from sidecar.runtime.approval_plan import ApprovalPlan, build_message_history_hash, stable_hash
from sidecar.runtime.chat_resume_prefix import (
    _build_live_approval_working_messages,
    personality_row_is_replaceable,
)
from sidecar.runtime.chat_resume_prompt_normalization import (
    normalize_volatile_system_prompt_text,
)


@dataclass(frozen=True)
class LivePromptPrefix:
    """Outcome of comparing the frozen prompt prefix with its live rebuild."""

    system_prompt_mismatch: bool
    # Raw hash of the rebuilt prompt the summary reports when it mismatched.
    system_prompt_hash: str
    message_history_mismatch: bool
    message_history_hash: str


@dataclass(frozen=True)
class _Rebuild:
    system_prompt: Any
    normalized_prompt_text: str
    dynamic_system_messages: list[dict[str, Any]]


def _turn_discoveries(outcomes: Any) -> Iterator[frozenset[str]]:
    for outcome in outcomes or ():
        metadata = getattr(outcome, "metadata", None)
        if not isinstance(metadata, dict) or metadata.get("kind") != TOOL_SEARCH_RESULT_KIND:
            continue
        names = metadata.get("discovered_tools")
        if isinstance(names, list):
            yield frozenset(
                name.strip() for name in names if isinstance(name, str) and name.strip()
            )


def turn_tool_status_states(
    plan: ApprovalPlan,
    *,
    kernel: Any,
    request_messages: Any,
    canonical_session_messages: Any,
) -> Iterator[tuple[Any, ...]]:
    """Yield status entries for each earlier un-deferral state of this turn.

    Turn start first, then after each of the turn's own ``tool_search``
    discoveries. The live state is the caller's and is skipped here.
    """
    resolution = plan.tool_resolution_context
    if resolution is None:
        return
    # Same source chat_decision seeds ``un_deferred_names`` from.
    history = (
        canonical_session_messages
        if isinstance(canonical_session_messages, list) and canonical_session_messages
        else request_messages
    )
    state = frozenset(scan_history_for_undeferrals(history if isinstance(history, list) else []))
    seen = {frozenset(resolution.un_deferred_names)}
    for discovered in (frozenset(), *_turn_discoveries(plan.outcomes)):
        state |= discovered
        if state in seen:
            continue
        seen.add(state)
        contract = kernel._assemble_tool_contract(
            request_context=plan.request_context,
            resolution_context=replace(resolution, un_deferred_names=set(state)),
        )
        yield tuple(contract.status_entries)


def rebuild_live_prompt_prefix(
    plan: ApprovalPlan,
    *,
    brain_container: Any,
    live_params: dict[str, Any] | None,
    canonical_session_messages: Any,
    tool_contract: Any,
) -> LivePromptPrefix:
    """Compare the frozen system prompt and leading rows with a live rebuild."""
    from . import chat as _chat_hub

    stack = brain_container.stack

    def _rebuild(tool_statuses: Any) -> _Rebuild:
        system_prompt = _chat_hub._build_live_approval_system_prompt(
            plan,
            brain_container=brain_container,
            live_params=live_params,
            tool_statuses=tool_statuses,
        )
        return _Rebuild(
            system_prompt=system_prompt,
            normalized_prompt_text=normalize_volatile_system_prompt_text(str(system_prompt)),
            dynamic_system_messages=_chat_hub._build_live_dynamic_system_messages(
                brain_container=brain_container,
                tool_statuses=tool_statuses,
                plan=plan,
            ),
        )

    # Volatile lines (workspace-manifest block) are neutralized on BOTH sides;
    # ``plan.system_prompt_hash`` stays raw for audit metadata.
    frozen_prompt_text = normalize_volatile_system_prompt_text(str(plan.system_prompt))
    # The working-message comparison embeds the prompt as slot 0.
    expected_working_messages = [dict(item) for item in plan.working_messages]
    if (
        expected_working_messages
        and str(expected_working_messages[0].get("role") or "") == "system"
    ):
        expected_working_messages[0]["content"] = frozen_prompt_text
    expected_history_hash = build_message_history_hash(expected_working_messages)
    replaceable = personality_row_is_replaceable(plan, stack.config)

    def _history_hash(prompt_text: str, rebuild: _Rebuild) -> str:
        return build_message_history_hash(
            _build_live_approval_working_messages(
                plan,
                live_system_prompt=prompt_text,
                dynamic_system_messages=rebuild.dynamic_system_messages,
                personality_row_replaceable=replaceable,
            )
        )

    live = _rebuild(tool_contract.status_entries)
    rebuilds = [live]
    if (
        live.normalized_prompt_text != frozen_prompt_text
        or _history_hash(live.normalized_prompt_text, live) != expected_history_hash
    ):
        rebuilds.extend(
            _rebuild(statuses)
            for statuses in turn_tool_status_states(
                plan,
                kernel=stack.router,
                request_messages=live_params.get("messages") if live_params else None,
                canonical_session_messages=canonical_session_messages,
            )
        )
    prompt_match = next(
        (item for item in rebuilds if item.normalized_prompt_text == frozen_prompt_text),
        None,
    )
    slot_zero_text = (
        frozen_prompt_text if prompt_match is not None else live.normalized_prompt_text
    )
    history_hashes = [_history_hash(slot_zero_text, item) for item in rebuilds]
    history_match = expected_history_hash in history_hashes
    return LivePromptPrefix(
        system_prompt_mismatch=prompt_match is None,
        system_prompt_hash=stable_hash(str((prompt_match or live).system_prompt)),
        message_history_mismatch=not history_match,
        message_history_hash=expected_history_hash if history_match else history_hashes[0],
    )


__all__ = ["LivePromptPrefix", "rebuild_live_prompt_prefix", "turn_tool_status_states"]
