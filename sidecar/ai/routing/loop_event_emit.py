"""Loop-layer event emit helpers.

Owns the ``ToolExecutingEvent`` / ``ToolResultEvent`` / ``StreamResetEvent``
/ ``PhaseStarted/PhaseCompleted`` payload assembly that the routing layer
uses from the ``tool_loop`` orchestrator. Also defines
:func:`pre_dispatch_emit_executing`, the single emission point for the
routing-layer ``tool.executing`` notification that fires after approval
gating but before the parallel dispatcher runs. The ``LoopRuntime.pre_dispatch_emitted_call_ids``
set ensures the in-loop and parallel call sites do not re-emit for the
same call_id.

Every emit is wrapped where a diagnostic-side failure could otherwise
abort a turn: a single bad ``runtime.emit`` must not skip sibling calls
or fail the request.
"""

from __future__ import annotations

import logging
from typing import Any, Callable, Sequence

from sidecar.ai.error_codes import CMP_LOOP_TOOL_INTERRUPTED
from sidecar.ai.routing.loop_events import (
    PhaseCompletedEvent,
    PhaseStartedEvent,
    StreamResetEvent,
    ToolExecutingEvent,
    ToolResultEvent,
)
from sidecar.ai.routing.loop_runtime import LoopRuntime
from sidecar.ai.routing.tool_observation import KIND_TOOL_EXECUTION_FAILED
from sidecar.ai.tools.models import ToolCallRequest

logger = logging.getLogger("sidecar.ai.routing.loop_event_emit")

_INTERRUPTED_TOOL_OUTPUT = "System error: tool execution interrupted. Retry if needed."

def _safe_arguments_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def emit_stream_reset_for_retry(
    runtime: LoopRuntime,
    streamed_event_types: set[str],
    *,
    reason: str = "",
) -> None:
    """Emit a ``StreamResetEvent`` and reset visible-token bookkeeping.

    ``reason`` is forwarded on the event so the Electron canonical-capture path
    can preserve genuine mid-turn commentary on a ``"tool_continuation"`` reset
    while still discarding garbage on every other reason (the default empty
    reason is treated as discard downstream).
    """
    runtime.emit(StreamResetEvent(reason=reason))
    if runtime.streaming:
        streamed_event_types.add("chat.stream_reset")
    streamed_event_types.discard("chat.token")


def reset_streamed_text_bookkeeping(streamed_event_types: set[str]) -> None:
    """Forget prior token delivery without emitting a destructive UI reset."""

    streamed_event_types.discard("chat.token")


def emit_tool_executing(
    runtime: LoopRuntime,
    call: ToolCallRequest,
    request_id: str,
    index: int,
) -> str:
    """Emit a ``ToolExecutingEvent`` (and optional ``PhaseStartedEvent``).

    Returns the normalized ``call_id`` so callers can pair it with a
    later ``emit_tool_result``. Skips emission when *call.call_id* is
    already in ``runtime.pre_dispatch_emitted_call_ids`` — the routing
    layer emitted it before dispatch — but still returns the same
    ``call_id`` string the caller would have seen.
    """
    call_id = str(call.call_id or "").strip()
    if call_id and call_id in runtime.pre_dispatch_emitted_call_ids:
        return call_id
    if getattr(runtime, "phase_events_enabled", False):
        runtime.emit(
            PhaseStartedEvent(
                phase_id=f"phase_tool_use_{request_id}_{call_id or index}",
                phase_kind="tool_use",
                iteration=max(int(getattr(runtime, "current_iteration", 0) or 0), 0),
                tool_call_id=call_id or None,
                tool_name=call.tool_id,
                summary=f"Running {call.tool_id}",
            )
        )
    runtime.emit(
        ToolExecutingEvent(
            call_id=call_id,
            tool_name=call.tool_id,
            arguments=dict(_safe_arguments_dict(call.arguments)),
        )
    )
    runtime.record_tool_executing(
        call_id=call_id,
        tool_name=call.tool_id,
        arguments=dict(_safe_arguments_dict(call.arguments)),
    )
    return call_id


def emit_tool_result(
    runtime: LoopRuntime,
    outcome: Any,
    call_id: str,
) -> None:
    """Emit a ``ToolResultEvent`` (and bracketing ``PhaseCompleted/Started`` events)."""
    # Must run before the event's metadata copy below: this notification is
    # the persistence channel the next turn's history re-frame reads from.
    from sidecar.ai.routing.tool_execution_results import (
        annotate_derived_envelope_fields,
    )

    annotate_derived_envelope_fields(outcome)
    iteration = max(int(getattr(runtime, "current_iteration", 0) or 0), 0)
    if getattr(runtime, "phase_events_enabled", False):
        runtime.emit(
            PhaseCompletedEvent(
                phase_id=f"phase_tool_use_{runtime.request_id}_{call_id or outcome.tool_name}",
                phase_kind="tool_use",
                iteration=iteration,
                tool_call_id=call_id or None,
                tool_name=outcome.tool_name,
                summary=f"Finished {outcome.tool_name}",
            )
        )
        runtime.emit(
            PhaseStartedEvent(
                phase_id=f"phase_tool_result_{runtime.request_id}_{call_id or outcome.tool_name}",
                phase_kind="tool_result",
                iteration=iteration,
                tool_call_id=call_id or None,
                tool_name=outcome.tool_name,
                summary=f"Reading {outcome.tool_name} result",
            )
        )
    runtime.emit(
        ToolResultEvent(
            call_id=call_id,
            tool_name=outcome.tool_name,
            success=outcome.success,
            content=outcome.output,
            tool_input=dict(outcome.tool_input),
            content_type=outcome.content_type,
            ui_payload=dict(outcome.ui_payload) if outcome.ui_payload else None,
            generated_artifacts=outcome.generated_artifacts,
            error_code=outcome.error_code,
            metadata=dict(outcome.metadata) if outcome.metadata else None,
            trusted_attachments=tuple(getattr(outcome, "trusted_attachments", ()) or ()),
        )
    )
    runtime.record_tool_result(call_id)
    if getattr(runtime, "phase_events_enabled", False):
        runtime.emit(
            PhaseCompletedEvent(
                phase_id=f"phase_tool_result_{runtime.request_id}_{call_id or outcome.tool_name}",
                phase_kind="tool_result",
                iteration=iteration,
                tool_call_id=call_id or None,
                tool_name=outcome.tool_name,
                summary=f"Recorded {outcome.tool_name} result",
            )
        )


def pre_dispatch_emit_executing(
    runtime: LoopRuntime,
    tool_calls: Sequence[ToolCallRequest],
    request_id: str,
    *,
    start_index: int = 0,
) -> None:
    """Emit one ``ToolExecutingEvent`` per *tool_calls* before dispatch.

    Records each emitted ``call_id`` on
    ``runtime.pre_dispatch_emitted_call_ids`` so the in-loop emission
    sites (``emit_tool_executing`` and
    canonical sequential dispatcher) skip the duplicate.
    """
    if not tool_calls:
        return
    emitted = runtime.pre_dispatch_emitted_call_ids
    for offset, call in enumerate(tool_calls):
        if getattr(runtime, "cancelled", False):
            break
        try:
            call_id = emit_tool_executing(
                runtime, call, request_id, start_index + offset
            )
        except Exception:  # noqa: BLE001 — single-call failure must not skip siblings
            continue
        if call_id:
            emitted.add(call_id)


def build_interrupted_tool_outcome(record: dict[str, Any], output: str) -> Any:
    """Build the canonical orphan-settled outcome for one pending tool call.

    Shared by the live tool loop and the approval-resume dispatch so both paths
    settle an interrupted, already-surfaced ``tool.executing`` row identically.
    """

    # Local import: sidecar.ai.routing.router imports this module transitively
    # (router -> tool_call_execution -> loop_event_emit), so a top-level import
    # here fails with a partially-initialized module whenever router is
    # imported first. Verified, not defensive.
    from sidecar.ai.routing.router import ToolExecutionOutcome  # noqa: PLC0415

    call_id = str(record.get("call_id") or "").strip()
    tool_name = str(record.get("tool_name") or "tool").strip() or "tool"
    raw_arguments = record.get("arguments")
    arguments: dict[Any, Any] = raw_arguments if isinstance(raw_arguments, dict) else {}
    return ToolExecutionOutcome(
        tool_name=tool_name,
        output=output,
        success=False,
        tool_input={str(key): value for key, value in arguments.items()},
        error_code=CMP_LOOP_TOOL_INTERRUPTED,
        metadata={"interrupted": True, "recovery": "orphaned_tool_call"},
        call_id=call_id,
    )


def emit_interrupted_results_for_pending_calls(
    *,
    runtime: LoopRuntime,
    outcomes: list[Any],
    streamed_event_types: set[str],
    outcome_factory: Callable[[dict[str, Any], str], Any],
    output: str = _INTERRUPTED_TOOL_OUTPUT,
) -> int:
    """Pair any emitted ``tool.executing`` rows that have no ``tool.result``.

    This is the loop-level last resort for cancellation, timeout, stop-policy,
    and protocol-edge exits after pre-dispatch has already surfaced a tool row.
    """
    pending = runtime.pending_tool_executions()
    if not pending:
        return 0

    count = 0
    for record in pending:
        call_id = str(record.get("call_id") or "").strip()
        if not call_id:
            continue
        tool_result = outcome_factory(record, output)
        outcomes.append(tool_result)
        emit_tool_result(runtime, tool_result, call_id)
        # Settled-orphan outcomes are surfaced only as
        # ``ToolResultEvent`` notifications, so the canonical
        # ``ToolObservationStore`` audit row that the Electron promotion
        # bridge feeds off must be written here. Mirrors the canonical
        # audit shape at ``tool_execution.py`` (success path audits
        # there; ``emit_tool_result`` itself stays audit-free).
        runtime.audit(
            KIND_TOOL_EXECUTION_FAILED,
            tool_call_id=call_id,
            tool_name=str(tool_result.tool_name or ""),
            error_code=str(tool_result.error_code or "") or None,
            summary=f"tool_execution_failed {tool_result.tool_name}",
        )
        if runtime.streaming:
            streamed_event_types.add("tool.result")
        count += 1
    return count


__all__ = [
    "build_interrupted_tool_outcome",
    "emit_interrupted_results_for_pending_calls",
    "emit_stream_reset_for_retry",
    "emit_tool_executing",
    "emit_tool_result",
    "pre_dispatch_emit_executing",
    "reset_streamed_text_bookkeeping",
]
