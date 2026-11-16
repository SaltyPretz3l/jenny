"""Keep the rest of a round's same-tool file edits when an approval resumes.

One approval runs one call, plus the read-only calls around it that need none.
The calls after that window used to be settled as not run, so a model that sent
four edits in one round was asked to send three of them again. A run of calls of
the approved tool straight after the window is now carried instead: the turn
pauses on the next one with a fresh approval plan and no generation in between.

What needs approval does not change. Every carried call is asked for on its own,
through the same gate and the same reverse request as the first one. The carry
starts only when the gate would ask for its first call: a call the gate would
deny, run unprompted or cannot evaluate is settled as not run, as before, and
each later call meets the gate again when its own turn comes.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, replace
from typing import Any

from sidecar.runtime.approval_plan import ApprovalPlan
from sidecar.runtime.approval_resume_window import (
    GATE_ASKS,
    approval_gate_for_call,
    approved_call,
)
from sidecar.runtime.diagnostics import log_event

logger = logging.getLogger(__name__)

# Typed file edits only: each shows its exact input on its own card.
CARRY_TOOLS = frozenset({"edit_file", "write_file"})
MAX_CARRIED_CALLS = 16
# The hint is only what a card can show whole. These mirror the app's own limits
# (services/backend/chat-stream-exact-approval.js and round-approval-gate.js), so
# nothing is sent across that the app would cut anyway.
MAX_HINT_CALL_BYTES = 32 * 1024
MAX_HINT_BYTES = 128 * 1024


@dataclass(frozen=True)
class RoundCarry:
    """The calls kept for the next approval, first one first, and that one's request."""

    calls: tuple[Any, ...] = ()
    approval: Any | None = None


NO_CARRY = RoundCarry()


def _call_id(call: Any) -> str:
    return str(getattr(call, "call_id", "") or "").strip()


def _as_generated(plan: ApprovalPlan, calls: tuple[Any, ...]) -> tuple[Any, ...]:
    """The calls as the model sent them: the plan's own copies carry private attribution."""
    generated = getattr(getattr(plan, "generation_result", None), "tool_calls", None) or ()
    by_id = {_call_id(call): call for call in generated if _call_id(call)}
    return tuple(by_id.get(_call_id(call), call) for call in calls)


def round_call_hints(calls: tuple[Any, ...]) -> tuple[dict[str, object], ...]:
    """What the app may show beside the first card: the later calls of the same round.

    The list stops at the first call too large for a card, and once the whole
    list is. The calls left out are still carried and asked for on their own.
    """
    hints: list[dict[str, object]] = []
    total = 0
    for call in calls:
        arguments = dict(getattr(call, "arguments", {}) or {})
        size = len(json.dumps(arguments, ensure_ascii=False, default=str))
        total += size
        if not _call_id(call) or size > MAX_HINT_CALL_BYTES or total > MAX_HINT_BYTES:
            break
        hints.append(
            {
                "tool_call_id": _call_id(call),
                "tool_name": str(getattr(call, "tool_id", "") or ""),
                "tool_input": arguments,
            }
        )
    return tuple(hints)


def same_tool_run(approved: Any, following: tuple[Any, ...]) -> tuple[Any, ...]:
    """The calls straight after *approved* that use its tool, when it is a carried tool."""
    tool_id = str(getattr(approved, "tool_id", "") or "")
    if tool_id not in CARRY_TOOLS:
        return ()
    run: list[Any] = []
    for call in following[:MAX_CARRIED_CALLS]:
        if str(getattr(call, "tool_id", "") or "") != tool_id or not _call_id(call):
            break
        run.append(call)
    return tuple(run)


def _hinted(approval: Any, later: tuple[Any, ...]) -> Any:
    try:
        return replace(approval, round_calls=round_call_hints(later))
    except TypeError:  # a request type without the hint keeps working, one card per call
        return approval


def with_round_hint(approval: Any, round_calls: tuple[Any, ...]) -> Any:
    """*approval* naming the same-tool edits straight after its own call.

    For the first card of a round. It promises nothing: the resume decides what
    is carried, and the app checks each later request against what it showed.
    """
    call_id = str(getattr(approval, "tool_call_id", "") or "").strip()
    position = next(
        (index for index, call in enumerate(round_calls) if _call_id(call) == call_id), None
    )
    if not call_id or position is None or getattr(approval, "one_off_only", False):
        return approval
    run = same_tool_run(round_calls[position], tuple(round_calls[position + 1 :]))
    return _hinted(approval, run) if run else approval


def split_round_carry(
    plan: ApprovalPlan,
    selected: tuple[Any, ...],
    dropped: tuple[Any, ...],
    *,
    kernel: Any,
    tool_contract: Any | None,
) -> tuple[RoundCarry, tuple[Any, ...]]:
    """Return ``(carry, still_dropped)`` for an approved window.

    Nothing is carried when the approved call did not run (the app refused it),
    when it is not a carried tool, or when the next call would not simply ask.
    """
    approved = approved_call(plan, selected)
    if approved is None or not selected:
        return NO_CARRY, dropped
    # The window's end is found by call id, so a window with a call that has none carries nothing.
    window_ids = {_call_id(call) for call in selected}
    window_end = _call_id(selected[-1])
    position = next(
        (index for index, call in enumerate(plan.tool_calls) if _call_id(call) == window_end), None
    )
    if "" in window_ids or position is None:
        return NO_CARRY, dropped
    run = _as_generated(plan, same_tool_run(approved, tuple(plan.tool_calls[position + 1 :])))
    if not run or any(_call_id(call) in window_ids for call in run):
        return NO_CARRY, dropped
    state, approval = approval_gate_for_call(
        plan, run[0], kernel=kernel, tool_contract=tool_contract
    )
    if (
        state != GATE_ASKS
        or approval is None
        or getattr(approval, "one_off_only", False)
        or str(getattr(approval, "tool_call_id", "") or "").strip() != _call_id(run[0])
    ):
        return NO_CARRY, dropped
    carried_ids = {_call_id(call) for call in run}
    return (
        RoundCarry(calls=run, approval=_hinted(approval, run[1:])),
        tuple(call for call in dropped if _call_id(call) not in carried_ids),
    )


def run_loop_or_pause_round(
    carry: RoundCarry, plan: ApprovalPlan, run_loop: Any, **loop: Any
) -> Any:
    """Run the resumed loop, or pause on the carried calls before any generation.

    *loop* is exactly what the resumed loop would be started with, so the pause
    freezes the same state a loop pausing on its first call would.
    """
    if not carry.calls or carry.approval is None:
        return run_loop(**loop)
    from sidecar.ai.routing import tool_loop as _tl_hub
    from sidecar.ai.routing.quota_runtime import freeze_runtime_quota

    runtime, kernel, context = loop["runtime"], loop["kernel"], loop["request_context"]
    runtime.raise_if_cancelled()
    outcomes = tuple(loop.get("initial_outcomes") or ())
    request_id = str(loop["request_id"])
    call_id = str(carry.approval.tool_call_id or "").strip()
    frozen_inputs = tuple(
        kernel._freeze_effective_execution_inputs(
            call,
            session_id=loop["session_id"],
            read_snapshot_cache=loop["read_snapshot_cache"],
            tool_contract=loop["tool_contract"],
            plan_mode=loop["plan_mode"],
            read_only=loop["read_only"],
            execution_context=getattr(context, "execution_context", None),
            turn_id=getattr(runtime, "logical_turn_id", None) or request_id,
        )
        for call in carry.calls
    )
    # The hub's builder stamps the bound run's change set, as it does for a pausing loop.
    approval_plan = _tl_hub.build_approval_plan(
        quota_state_json=freeze_runtime_quota(
            runtime, kernel._config, outcomes=outcomes, tool_contract=loop["tool_contract"]
        ),
        approved_call_id=call_id,
        request_context=context,
        latest_user_content=loop["latest_user_content"],
        request_messages_hash=(
            str(loop.get("request_messages_hash") or "").strip()
            or _tl_hub.build_message_history_hash(loop["working_messages"])
        ),
        working_messages=loop["working_messages"],
        generation_result=replace(plan.generation_result, tool_calls=carry.calls),
        tool_calls=carry.calls,
        frozen_inputs=frozen_inputs,
        tool_contract=loop["tool_contract"],
        tool_resolution_context=loop["tool_resolution_context"],
        read_snapshot_cache=loop["read_snapshot_cache"],
        outcomes=outcomes,
        usage_totals=loop.get("initial_usage_totals"),
        streamed_event_types=frozenset(loop.get("initial_streamed_event_types") or ()),
        system_prompt=loop["system_prompt"],
        prompt_cache_enabled=loop["prompt_cache_enabled"],
        cache_source_key=loop["cache_source_key"],
        # No generation ran: the carried calls belong to the iteration the plan paused on.
        remaining_iterations=plan.remaining_iterations,
        completed_iterations=plan.completed_iterations,
        wall_clock_deadline=getattr(runtime, "wall_clock_deadline", None),
        tool_call_limit=getattr(runtime, "tool_call_limit", 0) or 0,
        remaining_tool_calls=getattr(runtime, "remaining_tool_calls", 0) or 0,
        tool_payload=list(loop["tool_payload"]),
        tool_statuses=tuple(loop["tool_statuses"] or ()),
        parent_approval_plan_hash=getattr(context, "parent_approval_plan_hash", ""),
        config=kernel._config,
        engine=kernel._engine,
        resolved_max_tokens=_tl_hub.resolve_effective_max_tokens(
            kernel._config.max_tokens,
            kernel._engine.get_model_max_output_tokens(),
            user_override=getattr(kernel._config, "resolved_user_max_output_tokens", None),
        ),
    )
    runtime.audit(
        _tl_hub.KIND_USER_APPROVAL_REQUESTED,
        tool_call_id=call_id,
        summary="user_approval_requested",
    )
    log_event(
        logger,
        logging.INFO,
        component="ai.router",
        event="ai.router.approval_round_carried",
        message="Kept the rest of a round's same-tool calls for their own approval.",
        status="awaiting_approval",
        data={
            "tool": str(getattr(carry.calls[0], "tool_id", "") or ""),
            "carried_count": len(carry.calls),
        },
        request_id=request_id,
        session_id=loop["session_id"],
    )
    return _tl_hub.ToolLoopResult(
        thinking_text=None,
        thinking_kind=_tl_hub.CHAT_THINKING_KIND_STATUS,
        persist_thinking=False,
        response_text="",
        approval_request=carry.approval,
        approval_plan=approval_plan,
        outcomes=list(outcomes),
        usage_totals=loop.get("initial_usage_totals"),
        streamed_event_types=set(loop.get("initial_streamed_event_types") or ()),
    )
