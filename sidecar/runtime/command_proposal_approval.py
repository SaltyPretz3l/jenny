"""Blocking one-off approval round trip for ``command.execute_proposal``.

The Run click is the user's intent, never an approval (owner decision DB1): the
existing command policy decides exactly as for a model-issued ``run_command``.
When that policy asks, this module drives the same blocking
``tool.request_approval`` reverse request, with the same phase and canonical
approval events, that ``process_chat_send_request`` drives for a chat turn. No
approval plan is cached because nothing resumes: an approval is consumed in-line.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from time import monotonic
from typing import Any, Callable

from sidecar.ai.routing.loop_events import (
    ApprovalRequestedEvent,
    ApprovalResolvedEvent,
    PhaseCompletedEvent,
    PhaseStartedEvent,
)
from sidecar.runtime.approval import ApprovalResolution, request_tool_approval
from sidecar.runtime.chat_helpers import notification_context
from sidecar.runtime.turn_state import (
    TERMINAL_SUBCODE_DENIED_USER_EXPLICIT,
    TERMINAL_SUBCODE_TIMEOUT_APPROVAL,
    TURN_STATE_CANCELLED,
    TURN_STATE_DENIED,
    TURN_STATE_PREEMPTED,
    TURN_STATE_RUNTIME_ERROR,
    TURN_STATE_TIMEOUT,
    current_live_run_mode_state,
)

_PAUSE_PREFIX = "runtime_pause"
_APPROVED_STATUSES = frozenset({"approved", "approved_auto", "accepted", "denied", "rejected"})
_NON_PLAN_DECISIONS = frozenset({"approved_auto", "accepted", "rejected"})


@dataclass(frozen=True, slots=True)
class ApprovalVerdict:
    """The terminal reading of one approval round trip."""

    approved: bool
    status: str
    terminal_subcode: str | None


def _denied_verdict(resolution: ApprovalResolution) -> ApprovalVerdict:
    status = resolution.status
    mapping = {
        TURN_STATE_TIMEOUT: (TURN_STATE_TIMEOUT, TERMINAL_SUBCODE_TIMEOUT_APPROVAL),
        TURN_STATE_CANCELLED: (TURN_STATE_CANCELLED, None),
        TURN_STATE_PREEMPTED: (TURN_STATE_PREEMPTED, None),
        TURN_STATE_RUNTIME_ERROR: (TURN_STATE_RUNTIME_ERROR, None),
    }
    terminal, subcode = mapping.get(
        status, (TURN_STATE_DENIED, TERMINAL_SUBCODE_DENIED_USER_EXPLICIT)
    )
    return ApprovalVerdict(False, terminal, subcode)


def request_one_off_approval(  # noqa: PLR0913
    approval: Any,
    *,
    request_id: str,
    trace_id: str | None,
    session_id: str | None,
    tool_call_id: str,
    write_frame: Callable[[dict[str, Any]], None],
    emit_phase: Callable[[Any], None],
    emit_canonical: Callable[[Any], None],
    response_reader_factory: Callable[..., Callable[[float], dict[str, Any]]] | None,
    cancel_handle: Any,
    timeout_seconds: float,
    unattended_timeout_seconds: float,
    logger: logging.Logger,
) -> ApprovalVerdict:
    """Ask the user once; return the terminal reading. Never trusts a bare boolean."""
    summary = str(getattr(approval, "reason", "") or "").strip() or "Waiting for approval"
    tool_name = str(getattr(approval, "tool_name", "") or "") or "run_command"
    phase_id = f"phase_approval_wait_{request_id}_{tool_call_id}"
    live_mode = current_live_run_mode_state()
    wait = (
        unattended_timeout_seconds
        if (live_mode is not None and live_mode.is_paused_unattended())
        else max(0.0, float(timeout_seconds))
    )
    emit_phase(
        PhaseStartedEvent(
            phase_id=phase_id,
            phase_kind="approval_wait",
            iteration=0,
            tool_call_id=tool_call_id,
            tool_name=tool_name,
            summary=summary,
        )
    )
    emit_canonical(
        ApprovalRequestedEvent(
            call_id=tool_call_id,
            tool_name=tool_name,
            summary=summary,
        )
    )
    payload = {
        **notification_context(request_id, trace_id=trace_id, session_id=session_id),
        **approval.to_payload(),
        "tool_call_id": tool_call_id,
    }

    def _extra_wait() -> float:
        mode = current_live_run_mode_state()
        if wait >= unattended_timeout_seconds or mode is None or not mode.is_paused_unattended():
            return 0.0
        return unattended_timeout_seconds - wait

    def _no_fallback_reader(_timeout: float) -> dict[str, Any]:
        raise TimeoutError("command proposal approval has no fallback reader")

    started = monotonic()
    try:
        raw = (
            request_tool_approval(
                payload,
                write_message=write_frame,
                read_message=_no_fallback_reader,
                response_reader_factory=response_reader_factory,
                timeout_seconds=wait,
                logger=logger,
                extra_wait_seconds=_extra_wait,
                cancel_handle=cancel_handle,
            )
            if callable(response_reader_factory)
            else ApprovalResolution(
                approved=False,
                status=TURN_STATE_RUNTIME_ERROR,
            )
        )
    finally:
        logger.debug("command proposal approval wait %.3fs", monotonic() - started)
    resolution = (
        raw
        if isinstance(raw, ApprovalResolution)
        else ApprovalResolution(
            approved=bool(raw),
            status="approved" if raw else "denied",
        )
    )
    # No durable decision checkpoint exists for command work: a pause is never a consent.
    if resolution.status.startswith(_PAUSE_PREFIX):
        resolution = ApprovalResolution(approved=False, status=TURN_STATE_RUNTIME_ERROR)
    if resolution.status in _APPROVED_STATUSES and live_mode is not None:
        approval_mode, read_only = live_mode.snapshot()
        live_mode.update(approval_mode=approval_mode, read_only=read_only, paused_unattended=False)
        if resolution.approved:
            live_mode.reset_auto_approvals()
    if resolution.decision in _NON_PLAN_DECISIONS:
        resolution = ApprovalResolution(approved=False, status="malformed")
    emit_phase(
        PhaseCompletedEvent(
            phase_id=phase_id,
            phase_kind="approval_wait",
            iteration=0,
            tool_call_id=tool_call_id,
            tool_name=tool_name,
            summary="Approval resolved",
        )
    )
    emit_canonical(
        ApprovalResolvedEvent(
            call_id=tool_call_id,
            approved=resolution.approved,
            status=resolution.status,
            tool_name=tool_name,
        )
    )
    if resolution.approved:
        return ApprovalVerdict(True, resolution.status, None)
    return _denied_verdict(resolution)


__all__ = ["ApprovalVerdict", "request_one_off_approval"]
