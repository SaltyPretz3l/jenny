"""Loop-event serialization helpers.

Extracted from ``chat.py`` to stay under the 1000-line hard max.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from sidecar.ai.routing.loop_events import (
    ApprovalRequestedEvent,
    ApprovalResolvedEvent,
    ContextCompactedEvent,
    ContextUsageEvent,
    HeartbeatEvent,
    IterationStartEvent,
    PhaseCompletedEvent,
    PhaseStartedEvent,
    StopEvent,
    StreamResetEvent,
    ThinkingEvent,
    TokenDeltaEvent,
    ToolCallCompletedEvent,
    ToolCallDeltaEvent,
    ToolExecutingEvent,
    ToolOutputChunkEvent,
    ToolResultEvent,
)
from sidecar.ai.routing.turn_event_contract import build_canonical_turn_event
from sidecar.ai.tools.trusted_attachments import attachment_refs
from sidecar.protocol import (
    CHAT_PHASE_COMPLETED_METHOD,
    CHAT_PHASE_STARTED_METHOD,
    CHAT_STREAM_RESET_METHOD,
    CHAT_THINKING_METHOD,
    CHAT_TOKEN_METHOD,
    CONTEXT_COMPACTED_METHOD,
    CONTEXT_USAGE_METHOD,
    TOOL_EXECUTING_METHOD,
    TOOL_OUTPUT_CHUNK_METHOD,
    TOOL_RESULT_METHOD,
    TURN_EVENT_METHOD,
)
from sidecar.runtime.chat_helpers import (
    notification_context,
)
from sidecar.runtime.ipc_payloads import IpcPayloadExternalizer
from sidecar.runtime.rpc import notification

_PHASE_SUMMARY_MAX_CHARS = 240


@dataclass(frozen=True)
class _TurnEventParts:
    event_type: str
    payload: dict[str, Any]
    tool_call_id: str = ""
    event_id: str = ""


def _normalize_phase_summary(value: Any) -> str:
    summary = " ".join(str(value or "").split())
    if not summary:
        return ""
    if len(summary) <= _PHASE_SUMMARY_MAX_CHARS:
        return summary
    return summary[: _PHASE_SUMMARY_MAX_CHARS - 3].rstrip() + "..."


def _serialize_context_compacted(
    event: ContextCompactedEvent,
    ctx: dict[str, Any],
) -> dict[str, Any]:
    compacted_payload: dict[str, Any] = {
        **ctx,
        "strategy": event.strategy,
        "tokens_before": event.tokens_before,
        "tokens_after": event.tokens_after,
        "phase": event.phase,
        "summary_status": event.summary_status,
        "input_complete": bool(event.input_complete),
        "dropped_messages": max(0, int(event.dropped_messages)),
        "dropped_bytes": max(0, int(event.dropped_bytes)),
    }
    if event.reason_code:
        compacted_payload["reason_code"] = str(event.reason_code)[:80]
    if event.summary_message is not None:
        compacted_payload["summary_message"] = dict(event.summary_message)
    if (
        isinstance(event.covered_through_tool_call_id, str)
        and event.covered_through_tool_call_id
    ):
        compacted_payload["covered_through_tool_call_id"] = str(
            event.covered_through_tool_call_id
        )[:128]
    return notification(CONTEXT_COMPACTED_METHOD, compacted_payload)


def _serialize_loop_event(
    event: Any,
    request_id: str,
    *,
    trace_id: str | None,
    session_id: str | None,
    payload_externalizer: IpcPayloadExternalizer | None = None,
) -> dict[str, Any] | None:
    """Convert a typed domain event to a JSON-RPC notification dict.

    Returns ``None`` for event types that have no transport representation
    (the caller skips them silently).
    """
    ctx = notification_context(request_id, trace_id=trace_id, session_id=session_id)

    def phase_payload(phase_event: Any) -> dict[str, Any]:
        payload: dict[str, Any] = {
            **ctx,
            "phase_id": phase_event.phase_id,
            "phase_kind": phase_event.phase_kind,
            "iteration": int(phase_event.iteration),
        }
        if phase_event.thinking_id:
            payload["thinking_id"] = phase_event.thinking_id
        if phase_event.tool_call_id:
            payload["tool_call_id"] = phase_event.tool_call_id
        if phase_event.tool_name:
            payload["tool_name"] = phase_event.tool_name
        summary = _normalize_phase_summary(phase_event.summary)
        if summary:
            payload["summary"] = summary
        return payload

    if isinstance(event, IterationStartEvent):
        return notification(
            CHAT_THINKING_METHOD,
            {
                **ctx,
                "delta": (f"Starting iteration {event.iteration}/{event.max_iterations}..."),
                "thinking_id": f"think_{request_id}_iter{event.iteration}",
                "kind": "status",
                "persist": False,
            },
        )
    if isinstance(event, ThinkingEvent):
        payload = {
            **ctx,
            "delta": event.delta,
            "thinking_id": event.thinking_id,
            "kind": event.kind,
            "persist": event.persist,
        }
        budget_chars = getattr(event, "thinking_budget_chars", None)
        if isinstance(budget_chars, int) and budget_chars > 0:
            payload["thinking_budget_chars"] = budget_chars
        return notification(CHAT_THINKING_METHOD, payload)
    if isinstance(event, PhaseStartedEvent):
        return notification(CHAT_PHASE_STARTED_METHOD, phase_payload(event))
    if isinstance(event, PhaseCompletedEvent):
        return notification(CHAT_PHASE_COMPLETED_METHOD, phase_payload(event))
    if isinstance(event, TokenDeltaEvent):
        return notification(
            CHAT_TOKEN_METHOD,
            {
                **ctx,
                "delta": event.delta,
                "role": "assistant",
                "sequence": int(event.token_index),
            },
        )
    if isinstance(event, StreamResetEvent):
        return notification(
            CHAT_STREAM_RESET_METHOD,
            {**ctx, "reason": event.reason},
        )
    if isinstance(event, ToolExecutingEvent):
        executing_payload: dict[str, Any] = {
            **ctx,
            "tool_name": event.tool_name,
            "tool_call_id": event.call_id,
            "tool_input": event.arguments,
        }
        if payload_externalizer is not None:
            executing_payload = payload_externalizer.harden_tool_notification(
                method=TOOL_EXECUTING_METHOD,
                params=executing_payload,
                request_id=request_id,
                trace_id=trace_id,
                session_id=session_id,
            )
        return notification(
            TOOL_EXECUTING_METHOD,
            executing_payload,
        )
    if isinstance(event, ToolOutputChunkEvent):
        # W2-1 live tail — ephemeral, no canonical turn event, no journaling.
        return notification(
            TOOL_OUTPUT_CHUNK_METHOD,
            {
                **ctx,
                "tool_call_id": event.call_id,
                "tool_name": event.tool_name,
                "sequence": int(event.sequence),
                "lines": [dict(line) for line in event.lines],
                "partial": str(event.partial or ""),
                "emitted_lines": int(event.emitted_lines),
                "dropped_lines": int(event.dropped_lines),
                "elapsed_ms": int(event.elapsed_ms),
            },
        )
    if isinstance(event, ToolResultEvent):
        result_payload: dict[str, Any] = {
            **ctx,
            "tool_name": event.tool_name,
            "tool_call_id": event.call_id,
            "success": event.success,
            "output": event.content,
            "content_type": event.content_type,
            "tool_input": event.tool_input,
        }
        if event.ui_payload is not None:
            result_payload["ui_payload"] = event.ui_payload
        if event.generated_artifacts:
            result_payload["generated_artifacts"] = [
                dict(item) for item in event.generated_artifacts
            ]
        if event.error_code:
            result_payload["error_code"] = event.error_code
        if event.metadata:
            result_payload["metadata"] = event.metadata
        if event.duration_ms is not None:
            result_payload["duration_ms"] = event.duration_ms
        if event.trusted_attachments:
            # WIDE-019: the live notification is the ONLY surface carrying full
            # attachment payloads (already admission-gated and byte-bounded).
            result_payload["trusted_attachments"] = [
                dict(item) for item in event.trusted_attachments
            ]
        if payload_externalizer is not None:
            result_payload = payload_externalizer.harden_tool_notification(
                method=TOOL_RESULT_METHOD,
                params=result_payload,
                request_id=request_id,
                trace_id=trace_id,
                session_id=session_id,
            )
        return notification(TOOL_RESULT_METHOD, result_payload)
    if isinstance(event, HeartbeatEvent):
        return notification(
            CHAT_THINKING_METHOD,
            {
                **ctx,
                "delta": f"Working... ({event.elapsed_seconds:.0f}s elapsed)",
                "thinking_id": f"think_{request_id}_heartbeat",
                "kind": "status",
                "persist": False,
            },
        )
    if isinstance(event, StopEvent):
        stop_payload: dict[str, Any] = {
            **ctx,
            "delta": event.reason,
            "thinking_id": f"think_{request_id}_stop",
            "kind": "status",
            "persist": False,
        }
        if event.user_hint:
            stop_payload["user_hint"] = event.user_hint
        stop_payload["code"] = event.code
        if event.subcode:
            stop_payload["subcode"] = event.subcode
        return notification(
            CHAT_THINKING_METHOD,
            stop_payload,
        )
    if isinstance(event, ContextCompactedEvent):
        return _serialize_context_compacted(event, ctx)
    if isinstance(event, ContextUsageEvent):
        # Mid-turn meter snapshot — ephemeral, no canonical turn event, no
        # journaling (see the deliberate absence from _turn_event_parts).
        return notification(
            CONTEXT_USAGE_METHOD,
            {
                **ctx,
                "phase": str(event.phase),
                "iteration": int(event.iteration),
                "context_used_tokens": int(event.context_used_tokens),
                "context_used_source": str(event.context_used_source),
                "context_tokens_estimate": int(event.context_tokens_estimate),
                "last_request_input_tokens": int(event.last_request_input_tokens),
                "context_window": int(event.context_window),
                "compact_threshold_tokens": int(event.compact_threshold_tokens),
                "model": str(event.model),
                "provider": str(event.provider),
            },
        )
    return None


def _serialize_turn_event(
    event: Any,
    request_id: str,
    *,
    trace_id: str | None,
    session_id: str | None,
    seq: int,
) -> dict[str, Any] | None:
    """Convert a typed domain event to an additive canonical ``turn.event``.

    This is Packet 1A migration plumbing: callers continue emitting legacy
    notifications and invoke this helper only behind ``canonical_turn_events``.
    """
    parts = _turn_event_parts(event, request_id)
    if parts is None:
        return None

    payload = dict(parts.payload)
    if trace_id:
        payload["trace_id"] = trace_id
    canonical = build_canonical_turn_event(
        event_type=parts.event_type,
        turn_id=request_id,
        stream_id=request_id,
        session_id=session_id or "",
        seq=seq,
        payload=payload,
        event_id=parts.event_id,
        tool_call_id=parts.tool_call_id,
    )
    return notification(TURN_EVENT_METHOD, canonical.to_payload())


def _turn_event_parts(event: Any, request_id: str) -> _TurnEventParts | None:
    for build_parts in (
        _status_or_text_turn_event_parts,
        _approval_turn_event_parts,
        _tool_turn_event_parts,
    ):
        parts = build_parts(event, request_id)
        if parts is not None:
            return parts
    return None


def _status_or_text_turn_event_parts(event: Any, request_id: str) -> _TurnEventParts | None:
    del request_id
    if isinstance(event, IterationStartEvent):
        return _TurnEventParts(
            event_type="status_part",
            payload={
                "status_text": f"Starting iteration {event.iteration}/{event.max_iterations}...",
                "iteration": int(event.iteration),
                "max_iterations": int(event.max_iterations),
            },
        )
    if isinstance(event, ThinkingEvent):
        return _thinking_turn_event_parts(event)
    if isinstance(event, PhaseStartedEvent):
        return _phase_turn_event_parts(event, "phase_started")
    if isinstance(event, PhaseCompletedEvent):
        return _phase_turn_event_parts(event, "phase_completed")
    if isinstance(event, TokenDeltaEvent):
        return _TurnEventParts(
            event_type="text_delta",
            payload={
                "delta": event.delta,
                "role": "assistant",
                "sequence": int(event.token_index),
            },
        )
    return _control_turn_event_parts(event)


def _thinking_turn_event_parts(event: ThinkingEvent) -> _TurnEventParts:
    if event.kind == "reasoning" or event.persist:
        return _TurnEventParts(
            event_type="reasoning_delta",
            payload={
                "delta": event.delta,
                "thinking_id": event.thinking_id,
                "kind": event.kind,
                "persist": event.persist,
            },
        )
    return _TurnEventParts(
        event_type="status_part",
        payload={
            "status_text": event.delta,
            "thinking_id": event.thinking_id,
            "kind": event.kind,
            "persist": event.persist,
        },
    )


def _phase_turn_event_parts(
    event: PhaseStartedEvent | PhaseCompletedEvent,
    status: str,
) -> _TurnEventParts:
    return _TurnEventParts(
        event_type="status_part",
        payload=_phase_turn_payload(event, status),
        tool_call_id=event.tool_call_id or "",
    )


def _phase_turn_payload(
    phase_event: PhaseStartedEvent | PhaseCompletedEvent,
    status: str,
) -> dict[str, Any]:
    result: dict[str, Any] = {
        "status_text": status,
        "phase_id": phase_event.phase_id,
        "phase_kind": phase_event.phase_kind,
        "iteration": int(phase_event.iteration),
    }
    if phase_event.thinking_id:
        result["thinking_id"] = phase_event.thinking_id
    if phase_event.tool_call_id:
        result["tool_call_id"] = phase_event.tool_call_id
    if phase_event.tool_name:
        result["tool_name"] = phase_event.tool_name
    summary = _normalize_phase_summary(phase_event.summary)
    if summary:
        result["summary"] = summary
    return result


def _control_turn_event_parts(event: Any) -> _TurnEventParts | None:
    if isinstance(event, StreamResetEvent):
        return _TurnEventParts(
            event_type="status_part",
            payload={
                "status_text": "stream_reset",
                "event": "stream_reset",
                "reason": event.reason,
            },
        )
    if isinstance(event, HeartbeatEvent):
        return _TurnEventParts(
            event_type="status_part",
            payload={
                "status_text": f"Working... ({event.elapsed_seconds:.0f}s elapsed)",
                "elapsed_seconds": float(event.elapsed_seconds),
            },
        )
    if isinstance(event, StopEvent):
        return _stop_turn_event_parts(event)
    if isinstance(event, ContextCompactedEvent):
        return _TurnEventParts(
            event_type="status_part",
            payload={
                "status_text": "context_compacted",
                "strategy": event.strategy,
                "tokens_before": int(event.tokens_before),
                "tokens_after": int(event.tokens_after),
                "phase": event.phase,
                "summary_status": event.summary_status,
                "input_complete": bool(event.input_complete),
                "reason_code": str(event.reason_code or "")[:80],
                "dropped_messages": max(0, int(event.dropped_messages)),
                "dropped_bytes": max(0, int(event.dropped_bytes)),
            },
        )
    return None


def _stop_turn_event_parts(event: StopEvent) -> _TurnEventParts:
    payload: dict[str, Any] = {
        "message": event.reason,
        "status_text": event.reason,
        "code": event.code,
    }
    if event.user_hint:
        payload["user_hint"] = event.user_hint
    if event.subcode:
        payload["subcode"] = event.subcode
    return _TurnEventParts(event_type="turn_cancelled", payload=payload)


def _approval_turn_event_parts(event: Any, request_id: str) -> _TurnEventParts | None:
    if isinstance(event, ApprovalRequestedEvent):
        payload: dict[str, Any] = {
            "approval_state": "pending",
            "tool_name": event.tool_name or "",
        }
        if event.summary:
            payload["summary"] = event.summary
        if event.approval_plan_hash:
            payload["approval_plan_hash"] = event.approval_plan_hash
        return _TurnEventParts(
            event_type="tool_approval_requested",
            payload=payload,
            tool_call_id=event.call_id,
            event_id=f"{request_id}:approval:requested:{event.call_id}",
        )
    if isinstance(event, ApprovalResolvedEvent):
        payload = {
            "approval_state": event.status,
            "approved": bool(event.approved),
            "tool_name": event.tool_name or "",
        }
        if event.approval_plan_hash:
            payload["approval_plan_hash"] = event.approval_plan_hash
        return _TurnEventParts(
            event_type="tool_approval_resolved",
            payload=payload,
            tool_call_id=event.call_id,
            event_id=f"{request_id}:approval:resolved:{event.call_id}",
        )
    return None


def _tool_turn_event_parts(event: Any, request_id: str) -> _TurnEventParts | None:
    del request_id
    if isinstance(event, ToolCallDeltaEvent):
        return _TurnEventParts(
            event_type="tool_input_delta",
            payload={
                "tool_name": event.tool_name or "",
                "arguments_delta": event.arguments_delta,
                "sequence": int(event.sequence),
            },
            tool_call_id=event.call_id,
        )
    if isinstance(event, ToolCallCompletedEvent):
        return _TurnEventParts(
            event_type="tool_call_requested",
            payload={
                "tool_name": event.tool_name,
                "tool_input": dict(event.arguments),
                "sequence": int(event.sequence),
            },
            tool_call_id=event.call_id,
        )
    if isinstance(event, ToolExecutingEvent):
        return _TurnEventParts(
            event_type="tool_execution_started",
            payload={
                "tool_name": event.tool_name,
                "tool_input": dict(event.arguments),
            },
            tool_call_id=event.call_id,
        )
    if isinstance(event, ToolResultEvent):
        return _tool_result_turn_event_parts(event)
    return None


def _tool_result_turn_event_parts(event: ToolResultEvent) -> _TurnEventParts:
    payload: dict[str, Any] = {
        "tool_name": event.tool_name,
        "success": bool(event.success),
        "tool_output_summary": event.content,
        "content_type": event.content_type,
        "tool_input": dict(event.tool_input),
    }
    if event.ui_payload is not None:
        payload["ui_payload"] = event.ui_payload
    if event.generated_artifacts:
        payload["generated_artifacts"] = [dict(item) for item in event.generated_artifacts]
    if event.error_code:
        payload["error_code"] = event.error_code
    if event.metadata:
        payload["metadata"] = event.metadata
    if event.duration_ms is not None:
        payload["duration_ms"] = event.duration_ms
    if event.trusted_attachments:
        # WIDE-019: canonical turn events persist SAFE REFS ONLY — identity,
        # kind, mime type, byte length, dimensions — never bytes or base64.
        payload["trusted_attachment_refs"] = attachment_refs(event.trusted_attachments)
    return _TurnEventParts(
        event_type="tool_execution_completed" if event.success else "tool_execution_failed",
        payload=payload,
        tool_call_id=event.call_id,
    )
