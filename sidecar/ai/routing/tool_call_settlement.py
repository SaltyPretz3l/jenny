"""Terminal outcomes for admitted tool calls that will not run.

Split from ``tool_call_execution.py``, which re-exports
``settle_dropped_tool_calls`` and ``settle_after_turn_boundary``. Every call the
turn reserved but does not execute (outside an approved window, or after an
end-of-turn boundary) still gets a paired ``tool.executing``/``tool.result``
row and a failed outcome, so budget accounting and the timeline stay whole.
"""

from __future__ import annotations

import logging
from collections.abc import Sequence
from typing import Any

from sidecar.ai.error_codes import CMP_APPROVAL_REJECTED, CMP_TOOL_APPROVAL_WINDOW_DROPPED
from sidecar.ai.routing import router as _router
from sidecar.ai.routing.tool_call_prefilter import _blocked_outcome, _record_filtered_outcome
from sidecar.runtime.diagnostics import log_event

# Logs under the dispatcher logger it was split from.
logger = logging.getLogger("sidecar.ai.routing.tool_call_execution")



APPROVAL_WINDOW_DROPPED_OUTPUT_TEMPLATE = (
    "Tool '{tool_id}' was not executed: it was not part of the approved "
    "execution window for this turn. Re-request it if it is still needed."
)
# Names the call the batch paused on, so a model that sees only this row does
# not read the drop as a refusal of the tool itself (dogfood TR-009).
APPROVAL_WINDOW_DROPPED_AFTER_OUTPUT_TEMPLATE = (
    "Tool '{tool_id}' was not executed: this batch paused for approval of "
    "'{approved_tool}', and the approved execution window held only that call "
    "plus read-only calls that need no approval. Nothing from this call "
    "happened. Re-issue it now if it is still needed."
)
# One line on the last dropped row, so the model re-issues the whole remainder
# in one go instead of rediscovering it a call at a time (Pocket Wild dogfood).
APPROVAL_WINDOW_BATCH_SUMMARY_TEMPLATE = (
    "\nBatch status: approved window {ran} (see their results); "
    "not run, re-issue these: {dropped}."
)
# Same count as the loop-stop guard's three identical calls.
_APP_REFUSAL_REPEAT_LIMIT = 3


def settle_dropped_tool_calls(  # noqa: PLR0913 -- mirrors the filtered-outcome recorder.
    *,
    kernel: Any,
    runtime: Any,
    result: Any,
    request_id: str,
    session_id: str | None,
    dropped_calls: Sequence[Any],
    outcomes: list[Any],
    working_messages: list[dict[str, Any]],
    iteration_calls: list[Any],
    streamed_event_types: set[str],
    approved_tool_id: str = "",
    window_calls: Sequence[Any] = (),
) -> int:
    """Give every admitted-but-unexecuted tool call an explicit terminal outcome.

    Approval resume executes only the approved window; the remaining calls in
    the frozen plan were still reserved against the turn tool budget. Settling
    them here keeps budget accounting consistent (every reserved call has a
    terminal row) instead of silently discarding them. With ``window_calls``
    the last row also lists what ran and everything to re-issue.
    """

    if not dropped_calls:
        return 0

    template = (
        APPROVAL_WINDOW_DROPPED_AFTER_OUTPUT_TEMPLATE
        if approved_tool_id
        else APPROVAL_WINDOW_DROPPED_OUTPUT_TEMPLATE
    )
    def _names(calls: Sequence[Any]) -> str:
        return ", ".join(str(getattr(call, "tool_id", "") or "") for call in calls) or "nothing"

    summary = (
        APPROVAL_WINDOW_BATCH_SUMMARY_TEMPLATE.format(
            ran=_names(window_calls), dropped=_names(dropped_calls)
        )
        if window_calls
        else ""
    )
    outcome_index = len(outcomes)
    for position, call in enumerate(dropped_calls, start=1):
        outcome_index += 1
        _record_filtered_outcome(
            kernel=kernel,
            runtime=runtime,
            result=result,
            request_id=request_id,
            call=call,
            outcome_index=outcome_index,
            tool_result=_blocked_outcome(
                call,
                output=template.format(
                    tool_id=str(getattr(call, "tool_id", "") or ""),
                    approved_tool=approved_tool_id,
                ) + (summary if position == len(dropped_calls) else ""),
                error_code=CMP_TOOL_APPROVAL_WINDOW_DROPPED,
                metadata={
                    "approval_window_dropped": True,
                    "failure_class": "transient",
                    "remediation": "Not run. Call it again now, on its own.",
                },
            ),
            outcomes=outcomes,
            working_messages=working_messages,
            iteration_calls=iteration_calls,
            streamed_event_types=streamed_event_types,
        )
    log_event(
        logger,
        logging.WARNING,
        component="ai.router",
        event="ai.router.approval_window_calls_dropped",
        message="Settled reserved tool calls that fell outside the approved window.",
        status="blocked",
        data={
            "dropped_count": len(dropped_calls),
            "code": CMP_TOOL_APPROVAL_WINDOW_DROPPED,
            "tools": [str(getattr(call, "tool_id", "") or "") for call in dropped_calls],
        },
        request_id=request_id,
        session_id=session_id,
    )
    return len(dropped_calls)


def settle_app_refused_call(
    plan: Any,
    *,
    kernel: Any,
    outcomes: list[Any],
    working_messages: list[dict[str, Any]],
    iteration_calls: list[Any],
) -> bool:
    """Give the model the app's refusal of the approved call as that call's result.

    Electron already wrote the refused row before answering the approval, so no
    ``tool.executing``/``tool.result`` pair is emitted here (it would be a twin).
    Only the transcript the next generation reads and the turn's budget need it.

    Returns True once the same refusal has been given ``_APP_REFUSAL_REPEAT_LIMIT``
    times this turn. Each refusal is a fresh resume with fresh loop-stop state, so
    the caller withholds tools from the next generation instead.
    """
    from sidecar.runtime.approval_resume_window import approved_call

    refusal = str(getattr(plan, "app_refusal", "") or "")
    call = approved_call(plan, plan.tool_calls)
    if not refusal or call is None:
        return False
    tool_result = _blocked_outcome(
        call, output=refusal, error_code=CMP_APPROVAL_REJECTED, metadata={"app_refused": True}
    )
    outcomes.append(tool_result)
    working_messages.append(kernel._assistant_tool_call_message(plan.generation_result, call))
    working_messages.append(kernel._tool_result_message(call, tool_result))
    iteration_calls.append(call)
    log_event(
        logger,
        logging.INFO,
        component="ai.router",
        event="ai.router.app_refusal_settled",
        message="The app refused a tool call before any card; the turn continues.",
        status="blocked",
        data={"tool": str(getattr(call, "tool_id", "") or ""), "code": CMP_APPROVAL_REJECTED},
        request_id=plan.request_id,
        session_id=plan.session_id,
    )
    repeats = sum(
        1
        for item in outcomes
        if (getattr(item, "metadata", None) or {}).get("app_refused")
        and item.tool_name == tool_result.tool_name
        and item.output == refusal
    )
    return repeats >= _APP_REFUSAL_REPEAT_LIMIT


def settle_after_turn_boundary(  # noqa: PLR0913 -- mirrors the dropped-call settler.
    *,
    kernel: Any,
    runtime: Any,
    result: Any,
    request_id: str,
    session_id: str | None,
    boundary: _router.TurnBoundary,
    unstarted_calls: Sequence[tuple[Any, int]],
    outcomes: list[Any],
    working_messages: list[dict[str, Any]],
    iteration_calls: list[Any],
    streamed_event_types: set[str],
) -> int:
    """Give every call after an end-of-turn boundary an honest not-executed result.

    The batch's remaining calls were admitted but must not run: the turn ends at
    the boundary. Each gets a ``tool.executing`` + ``tool.result`` pair (so no
    row is orphaned) and a failed outcome the model never sees (no generation
    follows). Reuses CMP-TOOL-0042 (never dispatched).
    """
    for call, outcome_index in unstarted_calls:
        _record_filtered_outcome(
            kernel=kernel,
            runtime=runtime,
            result=result,
            request_id=request_id,
            call=call,
            outcome_index=outcome_index,
            tool_result=_blocked_outcome(
                call,
                output=boundary.not_executed_output(str(getattr(call, "tool_id", "") or "")),
                error_code=CMP_TOOL_APPROVAL_WINDOW_DROPPED,
                metadata={
                    "turn_boundary_not_executed": True,
                    "reason": boundary.completion_reason,
                },
            ),
            outcomes=outcomes,
            working_messages=working_messages,
            iteration_calls=iteration_calls,
            streamed_event_types=streamed_event_types,
        )
    if unstarted_calls:
        log_event(
            logger,
            logging.INFO,
            component="ai.router",
            event="ai.router.turn_boundary_calls_settled",
            message="Settled the unstarted calls of a batch that ended the turn.",
            status="blocked",
            data={
                "settled_count": len(unstarted_calls),
                "reason": boundary.completion_reason,
                "code": CMP_TOOL_APPROVAL_WINDOW_DROPPED,
            },
            request_id=request_id,
            session_id=session_id,
        )
    return len(unstarted_calls)
