"""Recoverable pre-dispatch failure recording for the tool loop.

Turn-survival contract: a tool call the harness refuses to run (mode/config
gates, security-classifier command blocks, out-of-workspace paths, shell
disabled) is a *tool failure the model must see*, not a turn-killing error.

Helpers here operate on the ``_ToolLoopRun`` instance (``loop``) like the
mixin families carved from ``run_tool_loop``; they mutate the loop's
``outcomes`` / ``working_messages`` / event bookkeeping through the same seams
the in-loop recorders use, so a recovered block is indistinguishable from any
other failed tool result downstream (renderer, cycle detection, failed-tool
context nudge).

The tools-stripped wind-down endings live in ``tool_loop_wind_down`` and are
re-exported here.
"""

from __future__ import annotations

import logging
from dataclasses import replace
from typing import Any

from sidecar.ai.routing.tool_loop_wind_down import (  # noqa: F401
    WindDownSpec,
    _tool_cap_spent,
    budget_exhausted_wind_down,
    empty_final_wind_down,
    max_iterations_summary,
    maybe_wind_down_tool_cap_final,
    wind_down_response,
)

logger = logging.getLogger("sidecar.ai.routing.tool_loop")


_TOOL_BUDGET_EXHAUSTED_MESSAGE = (
    "The cumulative tool-call budget for this turn is fully reserved. Execute only "
    "the admitted calls already present, then answer from their results without "
    "requesting more tools."
)


def admit_tool_calls_for_turn(
    loop: Any,
    result: Any,
    *,
    last_error_output: str | None,
) -> tuple[Any, bool]:
    """Reserve the request-owned tool budget before approval or dispatch.

    Rejected calls are materialized as normal failed tool results so the model,
    renderer, and diagnostics all observe the configured bound.  Reservations
    survive approval because the remaining count is frozen into the plan.
    """

    import sidecar.ai.routing.tool_loop as _tl_hub
    from sidecar.ai.error_codes import CMP_TOOL_CAP_EXCEEDED

    requested_calls = tuple(result.tool_calls)
    admitted_count = loop.runtime.reserve_tool_calls(len(requested_calls))
    admitted_calls = requested_calls[:admitted_count]
    rejected_calls = requested_calls[admitted_count:]
    if rejected_calls:
        limit = int(loop.runtime.tool_call_limit or 0)
        record_failed_tool_calls(
            loop,
            result,
            rejected_calls,
            error_code=CMP_TOOL_CAP_EXCEEDED,
            output_for_call=lambda call: (
                f"Tool '{call.tool_id}' was not executed: cumulative tool invocation "
                f"limit ({limit}) reached for this turn. Continue from the available "
                "results without more tools."
            ),
            metadata={
                "limit": limit,
                "scope": "turn",
                "failure_class": "denied",
                "remediation": (
                    "No more tool calls are allowed this turn. Answer from the results "
                    "you already have."
                ),
            },
        )
        emit_degradation_status(
            loop,
            text=(
                f"The model requested {len(requested_calls)} tool calls, but only "
                f"{admitted_count} fit the remaining turn budget ({limit} total)."
            ),
            event="ai.router.tool_cap_exceeded",
            data={
                "requested": len(requested_calls),
                "admitted": admitted_count,
                "limit": limit,
                "consumed": loop.runtime.tool_calls_consumed,
                "remaining": loop.runtime.remaining_tool_calls,
                "rejected_count": len(rejected_calls),
                "rejected_tools": [call.tool_id for call in rejected_calls],
            },
        )
    if loop.runtime.remaining_tool_calls == 0:
        # F15: keep the tools at the cap (prefix cache); drop them only after a post-cap call.
        if getattr(loop, "tool_cap_tools_stripped", False) and not admitted_calls:
            loop.tool_payload = []
        loop.tool_cap_tools_stripped = True
        if not loop.tool_budget_exhausted_notified:
            loop.working_messages.append(
                {"role": "system", "content": _TOOL_BUDGET_EXHAUSTED_MESSAGE}
            )
            loop.tool_budget_exhausted_notified = True
            _tl_hub.heuristic_fires.emit_heuristic_fire(
                loop.runtime, "tool_budget_exhausted_row",
            )
    if admitted_calls != requested_calls:
        result = replace(result, tool_calls=admitted_calls)
    if admitted_calls:
        return result, False
    finish_all_blocked_iteration(loop, requested_calls, last_error_output)
    return result, True


def reject_malformed_argument_calls(
    loop: Any,
    result: Any,
    malformed_calls: tuple[Any, ...],
) -> None:
    """Record calls whose provider ``arguments`` never parsed as a JSON object.

    Same per-call rejection seam the provider-input-limit family uses, and the
    same ``CMP-LOOP-0002`` the streaming path's replay fixture pins -- so the
    model sees "that one call was invalid, retry it" instead of the call being
    silently dispatched with empty arguments (the old non-streaming behaviour)
    or the whole turn dying (which streaming does at the engine seam).
    """
    import sidecar.ai.routing.tool_loop as _tl_hub
    from sidecar.ai.error_codes import CMP_LOOP_INVALID_TOOL_CALL

    _tl_hub.log_event(
        logger,
        logging.WARNING,
        component="ai.router",
        event="ai.router.tool_call_arguments_unparseable",
        message="Rejected tool calls whose arguments were not valid JSON.",
        status="blocked",
        data={
            "blocked_count": len(malformed_calls),
            "tools": [call.tool_id for call in malformed_calls],
        },
        request_id=loop.request_id,
        session_id=loop.session_id,
    )
    for call in malformed_calls:
        record_failed_tool_calls(
            loop,
            result,
            (call,),
            error_code=CMP_LOOP_INVALID_TOOL_CALL,
            output_for_call=lambda blocked_call: (
                f"Tool '{blocked_call.tool_id}' was not executed: its arguments "
                "were not valid JSON. Re-send the call with a complete, valid "
                "JSON arguments object."
            ),
            metadata={"malformed_arguments": True},
        )


def canonicalize_tool_call_batch(
    loop: Any,
    result: Any,
    *,
    last_error_output: str | None,
) -> tuple[Any, bool]:
    """Normalize one model batch and record alias conflicts per call."""

    import sidecar.ai.routing.tool_loop as _tl_hub

    # Package form, like tool_call_execution below: the policy module imports
    # record_failed_tool_calls from this file, so a top-level import would cycle.
    from sidecar.ai.routing import tool_call_repair_policy as _repair_policy

    # The turn-scoped id namespace lives on the runtime, so EVERY batch that
    # crosses this chokepoint -- Ollama's id-less native calls, the per-stream
    # normalizer's ``call_N`` ids, any future id-less provider -- is de-collided
    # against the ids earlier iterations already used. This runs before the
    # first ``KIND_MODEL_TOOL_REQUESTED`` audit and before any
    # ``pre_dispatch_emit_executing``, so downstream identity is already stable.
    canonical_calls, coerced_aliases, coalesced_count = _tl_hub.canonicalize_tool_calls(
        result.tool_calls,
        used_call_ids=getattr(loop.runtime, "turn_call_ids", None),
    )
    # Arguments the provider sent as a string that never parsed as a JSON
    # object are rejected PER CALL, the same verdict the streaming path
    # reaches -- but without killing the turn. The non-streaming parser used to
    # swallow the parse failure into ``{}`` and dispatch the call anyway, so a
    # truncated payload became a silent no-arg invocation.
    malformed_calls = tuple(
        call for call in canonical_calls if getattr(call, "malformed_arguments", False)
    )
    if malformed_calls:
        canonical_calls = tuple(
            call
            for call in canonical_calls
            if not getattr(call, "malformed_arguments", False)
        )
    # Wave 8 policy: a structurally healed payload (the healer closed a string
    # or an object the model never finished) is dispatched only when the tool
    # is provably read-only; see tool_call_repair_policy.
    canonical_calls, repair_rejected = _repair_policy.partition_structurally_repaired_calls(
        loop, canonical_calls
    )
    canonical_calls, provider_limit_rejections = (
        _tl_hub.validate_provider_tool_call_limits(canonical_calls)
    )
    canonical_calls, argument_aliases, argument_conflicts = (
        _tl_hub.canonicalize_tool_call_arguments(canonical_calls)
    )
    canonical_calls, query_repairs = _tl_hub.repair_web_search_query_arguments(
        canonical_calls,
        latest_user_content=loop.latest_user_content,
    )
    if canonical_calls != result.tool_calls:
        result = replace(result, tool_calls=canonical_calls)
    if (
        coerced_aliases
        or argument_aliases
        or coalesced_count
        or query_repairs
        or provider_limit_rejections
    ):
        _tl_hub.log_event(
            logger,
            logging.INFO,
            component="ai.router",
            event="ai.router.tool_calls_canonicalized",
            message="Canonicalized model tool calls before dispatch.",
            status="recovered",
            data={
                "aliases": coerced_aliases,
                "argument_aliases": argument_aliases,
                "coalesced_count": coalesced_count,
                "provider_limit_rejected_count": len(provider_limit_rejections),
                "web_search_query_repairs": query_repairs,
                "remaining_count": len(result.tool_calls),
            },
            request_id=loop.request_id,
            session_id=loop.session_id,
        )
    if malformed_calls:
        reject_malformed_argument_calls(loop, result, malformed_calls)
    _repair_policy.reject_structurally_repaired_calls(loop, result, repair_rejected)
    if provider_limit_rejections:
        _tl_hub.log_event(
            logger,
            logging.WARNING,
            component="ai.router",
            event="ai.router.provider_tool_input_rejected",
            message="Rejected provider tool calls that exceeded bounded input limits.",
            status="blocked",
            data={"blocked_count": len(provider_limit_rejections)},
            request_id=loop.request_id,
            session_id=loop.session_id,
        )
        for call, error in provider_limit_rejections:
            record_failed_tool_calls(
                loop,
                result,
                (call,),
                error_code=error.code,
                output_for_call=lambda blocked_call, reason=error.message: (
                    f"Tool '{blocked_call.tool_id}' was not executed: {reason}."
                ),
                metadata={"provider_input_limit": True},
            )
    # Every pre-dispatch rejection family shares the all-blocked tail, so when
    # nothing survives the model still sees each failure and gets one more
    # generation to correct itself.
    all_blocked = (
        tuple(call for call, _error in (*provider_limit_rejections, *argument_conflicts))
        + malformed_calls + repair_rejected
    )
    if not argument_conflicts:
        if result.tool_calls:
            return result, False
        if all_blocked:
            finish_all_blocked_iteration(loop, all_blocked, last_error_output)
            return result, True
        return result, False

    _tl_hub.log_event(
        logger,
        logging.WARNING,
        component="ai.router",
        event="ai.router.tool_argument_alias_conflict",
        message="Rejected conflicting tool argument aliases before policy evaluation.",
        status="blocked",
        data={
            "blocked_count": len(argument_conflicts),
            "tools": [call.tool_id for call, _error in argument_conflicts],
        },
        request_id=loop.request_id,
        session_id=loop.session_id,
    )
    for call, error in argument_conflicts:
        record_failed_tool_calls(
            loop,
            result,
            (call,),
            error_code=error.code,
            output_for_call=lambda blocked_call, reason=error.message: (
                f"Tool '{blocked_call.tool_id}' was not executed: {reason}. "
                "Use one canonical argument value and retry."
            ),
            metadata={"argument_alias_conflict": True},
        )
    if result.tool_calls:
        return result, False
    finish_all_blocked_iteration(loop, all_blocked, last_error_output)
    return result, True


def record_failed_tool_calls(  # noqa: PLR0913 — recording seam mirrors the in-loop recorders.
    loop: Any,
    result: Any,
    calls: tuple[Any, ...],
    *,
    error_code: str,
    output_for_call: Any,
    metadata: dict[str, Any] | None = None,
) -> None:
    """Record ``calls`` as failed outcomes with full event/message bookkeeping.

    Mirrors the in-loop recorders (`_record_policy_denied_tool_calls` et al):
    outcome appended, ``tool.executing``/``tool.result`` emitted, streamed
    event types tracked, and the assistant/tool messages appended so the next
    generation sees the failure.
    """
    import sidecar.ai.routing.tool_loop as _tl_hub
    from sidecar.ai.routing.router import ToolExecutionOutcome

    for call in calls:
        loop.outcome_index += 1
        tool_result = ToolExecutionOutcome(
            tool_name=call.tool_id,
            output=str(output_for_call(call)),
            success=False,
            tool_input=_tl_hub._visible_tool_input(call),
            error_code=error_code,
            metadata=dict(metadata or {}),
            call_id=call.call_id,
        )
        loop.outcomes.append(tool_result)
        call_id = _tl_hub.loop_event_emit.emit_tool_executing(
            loop.runtime,
            call,
            loop.request_id,
            loop.outcome_index,
        )
        _tl_hub.loop_event_emit.emit_tool_result(loop.runtime, tool_result, call_id)
        if loop.runtime.streaming:
            loop.streamed_event_types.add("tool.executing")
            loop.streamed_event_types.add("tool.result")
        loop.working_messages.append(loop.kernel._assistant_tool_call_message(result, call))
        loop.working_messages.append(loop.kernel._tool_result_message(call, tool_result))


def record_policy_denied_tool_calls(
    loop: Any,
    denied_calls: tuple[Any, ...],
    result: Any,
) -> None:
    """Record policy-filter denials (user denies and hard blocks) as outcomes.

    User policy denies keep the classic "tool policy denied it" phrasing; hard
    blocks (``PolicyDeniedToolCall.error_code`` != policy-denied) state the
    real reason and invite the model to adjust and continue.
    """
    from sidecar.ai.error_codes import CMP_TOOL_POLICY_DENIED

    for denied in denied_calls:
        denied_code = str(getattr(denied, "error_code", "") or "") or CMP_TOOL_POLICY_DENIED
        if denied_code == CMP_TOOL_POLICY_DENIED:
            denied_output = (
                f"Tool '{denied.call.tool_id}' was not executed: tool policy denied "
                f"it. {denied.decision.reason}"
            )
        else:
            denied_output = (
                f"Tool '{denied.call.tool_id}' was not executed: {denied.decision.reason} "
                "Adjust the arguments or choose a different approach, then continue."
            )
        metadata = dict(denied.metadata)
        metadata["policy_denied"] = True
        record_failed_tool_calls(
            loop,
            result,
            (denied.call,),
            error_code=denied_code,
            output_for_call=lambda _call, _output=denied_output: _output,
            metadata=metadata,
        )


def finish_all_blocked_iteration(
    loop: Any,
    blocked_calls: tuple[Any, ...],
    last_error_output: str | None,
) -> None:
    """Iteration-tail bookkeeping when every call this iteration was blocked.

    Same shape as the unknown-tool / quota / policy-deny all-blocked tails:
    remember the previous error context, advance cycle detection, and append
    the failed-tool context nudge so the next generation reacts to the block.
    """
    iteration_error_output = None
    if loop.outcomes and not loop.outcomes[-1].success:
        iteration_error_output = str(loop.outcomes[-1].output)
    loop.previous_error_output = last_error_output
    loop.previous_tool_calls = loop.last_tool_calls
    loop.last_tool_calls = tuple(blocked_calls)
    loop._append_failed_tool_context_if_needed()
    loop.tool_call_history, loop.error_output_history = loop._advance_cycle_history(
        loop.tool_call_history,
        loop.error_output_history,
        loop.last_tool_calls,
        iteration_error_output,
    )


def record_batch_gate_block(
    loop: Any,
    result: Any,
    *,
    error_code: str,
    reason: str,
    last_error_output: str | None,
) -> None:
    """Convert a whole-batch mode/config gate into recoverable failed outcomes.

    The model called tools while the harness disallows them (chat mode, or
    ``tools_enabled`` off). Every requested call becomes a failed outcome so
    the loop can proceed to a graceful final response instead of raising.
    """
    import sidecar.ai.routing.tool_loop as _tl_hub

    _tl_hub.log_event(
        logger,
        logging.WARNING,
        component="ai.router",
        event="ai.router.tool_batch_gate_blocked",
        message="Model tool calls blocked by a mode/config gate; recovering in-turn.",
        status="blocked",
        data={
            "code": error_code,
            "reason": reason,
            "call_count": len(result.tool_calls),
        },
        request_id=loop.request_id,
        session_id=loop.session_id,
    )
    record_failed_tool_calls(
        loop,
        result,
        tuple(result.tool_calls),
        error_code=error_code,
        output_for_call=lambda call: (
            f"Tool '{call.tool_id}' was not executed: {reason} "
            "Answer the user directly without tools."
        ),
        metadata={"batch_gate_blocked": True},
    )
    finish_all_blocked_iteration(loop, tuple(result.tool_calls), last_error_output)


def emit_degradation_status(
    loop: Any,
    *,
    text: str,
    event: str,
    data: dict[str, Any] | None = None,
    log_level: int = logging.WARNING,
) -> None:
    """Surface a tool-availability degradation to the user, never silently.

    Emits a one-line ``chat.thinking`` status (the same channel the loop uses
    for progress lines) plus a structured WARNING event. Every drop that used
    to be log-only — cycle-hint tool disable, unknown-tool cap skips, per-turn
    cap truncation, per-request native-tool fallback — goes through here so
    the user can see why Jenny stopped (or never started) using a tool.
    Defensive: a diagnostic-side failure never fails the turn.
    """
    import sidecar.ai.routing.tool_loop as _tl_hub
    from sidecar.ai.routing.loop_events import ThinkingEvent
    from sidecar.protocol import CHAT_THINKING_KIND_STATUS

    try:
        loop.runtime.emit(
            ThinkingEvent(
                thinking_id=f"status_degraded_{loop.request_id}",
                delta=text,
                kind=CHAT_THINKING_KIND_STATUS,
                persist=False,
            )
        )
        if loop.runtime.streaming:
            loop.streamed_event_types.add("chat.thinking")
        _tl_hub.log_event(
            logger,
            log_level,
            component="ai.router",
            event=event,
            message=text,
            status="degraded",
            data=dict(data or {}),
            request_id=loop.request_id,
            session_id=loop.session_id,
        )
    except Exception:  # noqa: BLE001 — diagnostic-only; never fail a turn.
        pass


def approval_with_recovery(
    loop: Any,
    result: Any,
    *,
    policy_decisions_by_call: dict[str, Any] | None,
) -> tuple[Any | None, Any]:
    """Run the approval gate, converting per-call blocks into failed outcomes.

    ``approval_if_needed``'s scan is per-call independent (documented on the
    function), so this wrapper evaluates one call at a time. A per-call
    ``ToolExecutionFailure`` (``CMP_TOOL_COMMAND_BLOCKED`` from the security
    classifier, shell disabled, unknown-descriptor desync, mode-blocked side
    effects) becomes a failed outcome for exactly that call and the scan
    continues — before 2026-07 any of these raised through the loop and killed
    the turn. The first call that needs approval suspends the iteration, as
    before; surviving calls stay in the returned result for the resume path.

    Returns ``(approval_request_or_none, result_with_surviving_calls)``;
    ``result.tool_calls`` is empty when every call was blocked.
    """
    import sidecar.ai.routing.tool_loop as _tl_hub

    kernel = loop.kernel
    prevalidated: list[Any] = []
    approval: Any | None = None
    from sidecar.ai.error_codes import CMP_LOOP_TOOL_INPUT_VALIDATION
    from sidecar.ai.routing import tool_call_execution as _tce

    for call in result.tool_calls:
        # Validate arguments before the gate, not after it. Dispatch validates
        # too, but by then the user has already answered the prompt — which is
        # how an over-long exit_plan_mode payload got itself approved and then
        # discarded, stranding the turn. A malformed call now becomes a
        # recoverable outcome the model can repair silently.
        prevalidation = _tce.prevalidate_call_arguments(
            kernel=kernel, call=call, tool_contract=loop.tool_contract,
        )
        if prevalidation is not None:
            record_failed_tool_calls(
                loop,
                result,
                (call,),
                error_code=prevalidation.get("error_code", CMP_LOOP_TOOL_INPUT_VALIDATION),
                output_for_call=lambda _call, _message=prevalidation["message"]: _message,
                metadata=prevalidation["metadata"],
            )
            continue
        prevalidated.append(call)

    surviving: list[Any] = []
    for index, call in enumerate(prevalidated):
        try:
            approval = kernel._approval_if_needed(
                (call,),
                mode=loop.mode_policy.mode,
                mode_allows_side_effecting=loop.mode_policy.allow_side_effecting_tools,
                require_approval=loop.mode_policy.require_approval_for_side_effecting,
                approvals_pre_granted=loop.approvals_pre_granted,
                resolution_context=loop.tool_resolution_context,
                tool_contract=loop.tool_contract,
                plan_mode=loop.plan_mode,
                read_only=loop.read_only,
                request_disabled_tools=loop.request_disabled_tools,
                policy_decisions_by_call=policy_decisions_by_call,
                approval_mode=str(getattr(loop.request_context, "approval_mode", "prompt")),
                execution_context=getattr(loop.request_context, "execution_context", None),
            )
        except _tl_hub.ToolExecutionFailure as exc:
            failure_message = str(exc.message or "the harness refused the call")
            _tl_hub.log_event(
                logger,
                logging.WARNING,
                component="ai.router",
                event="ai.router.tool_call_blocked_recovered",
                message="Converted a pre-dispatch tool block into a recoverable outcome.",
                status="recovered",
                data={
                    "tool": str(getattr(call, "tool_id", "") or ""),
                    "code": exc.code,
                    "reason": failure_message,
                },
                request_id=loop.request_id,
                session_id=loop.session_id,
            )
            record_failed_tool_calls(
                loop,
                result,
                (call,),
                error_code=exc.code,
                output_for_call=lambda blocked_call, _message=failure_message: (
                    f"Tool '{blocked_call.tool_id}' was not executed: {_message}. "
                    "Adjust the arguments or choose a different approach, then continue."
                ),
                metadata={"pre_dispatch_blocked": True},
            )
            continue
        surviving.append(call)
        if approval is not None:
            # First approval-needing call suspends the whole iteration; the
            # prevalidated tail rides along for the post-approval resume.
            surviving.extend(prevalidated[index + 1 :])
            break
    if tuple(surviving) != tuple(result.tool_calls):
        result = replace(result, tool_calls=tuple(surviving))
    return approval, result
