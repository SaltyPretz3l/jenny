"""Terminal builders for ``command.execute_proposal``: the ordinary chat terminals.

A completed, unknown, cancelled or approval-stopped run ends in the same
``chat.done`` / ``chat.error`` / ``turn.event`` shapes a chat turn emits, plus the
closed ``command_outcome`` the application records on the proposal.
"""

from __future__ import annotations

from typing import Any

from sidecar.ai.error_codes import CMP_CHAT_STREAM_FAILED
from sidecar.ai.routing.turn_event_contract import build_canonical_turn_event
from sidecar.protocol import CHAT_DONE_METHOD, CHAT_ERROR_METHOD, TURN_EVENT_METHOD
from sidecar.runtime import command_proposal_outcome as oc
from sidecar.runtime.chat_helpers import emit_approval_rejection, notification_context
from sidecar.runtime.chat_models import TerminalChatStateError
from sidecar.runtime.chat_response_builders import _terminal_chat_response
from sidecar.runtime.chat_tool_observations import chat_result_with_tool_observations
from sidecar.runtime.command_proposal_approval import ApprovalVerdict
from sidecar.runtime.outcomes import ProcessOutcome
from sidecar.runtime.rpc import notification, result_response
from sidecar.runtime.turn_state import (
    TURN_STATE_CANCELLED,
    TURN_STATE_COMPLETED,
    TURN_STATE_DENIED,
    TURN_STATE_RUNTIME_ERROR,
    build_turn_result,
)

COMPLETION_SOURCE = "command_proposal"
_TOOL = "run_command"
_MODEL = "command"


class TerminalBuilders:
    """Mixin: needs ``request``, ``message_id``, ``stack``, ``seq``, ``terminal`` and
    ``canonical_enabled`` from the run that mixes it in."""

    request: Any
    message_id: Any
    stack: Any
    seq: dict[str, int]
    terminal: list[dict[str, Any]]
    canonical_enabled: bool

    def _canonical(self, event_type: str, payload: dict[str, Any]) -> None:
        if not self.canonical_enabled:
            return
        request = self.request
        self.seq["seq"] = int(self.seq["seq"]) + 1
        event = build_canonical_turn_event(
            event_type=event_type,
            turn_id=request.turn_id,
            stream_id=request.request_id,
            session_id=request.session_id,
            seq=self.seq["seq"],
            payload={**payload, **({"trace_id": request.trace_id} if request.trace_id else {})},
            tool_call_id="",
        )
        self.terminal.append(notification(TURN_EVENT_METHOD, event.to_payload()))

    def _context_fields(self) -> dict[str, Any]:
        r = self.request
        return notification_context(r.request_id, trace_id=r.trace_id, session_id=r.session_id)

    def _finish(
        self, response: Any, outcome: oc.CommandOutcome, *, text: bool = False
    ) -> ProcessOutcome:
        result = dict(response.result)
        if text and "response_text" not in result:
            result["response_text"] = oc.fallback_text(outcome)
        result["command_outcome"] = outcome.to_wire()
        return ProcessOutcome(
            True, False, result_response(self.message_id, result), list(response.notifications)
        )

    def completed(self, outcome: oc.CommandOutcome) -> ProcessOutcome:
        text = oc.fallback_text(outcome)
        rid = self.request.request_id
        self._canonical(
            "text_part_completed",
            {
                "text": text,
                "assistant_phase": "final_answer",
                "segment_id": f"assistant_{rid}_seg_0",
                "segment_group_index": 0,
                "completion_source": COMPLETION_SOURCE,
            },
        )
        self.terminal.append(
            notification(
                CHAT_DONE_METHOD,
                {
                    **self._context_fields(),
                    "usage": {
                        "input_tokens": 0,
                        "output_tokens": 0,
                        "total_tokens": 0,
                        "provider": _MODEL,
                        "model": _MODEL,
                        "estimated": True,
                    },
                    "stop_reason": "end_turn",
                    "model": _MODEL,
                    "provider": _MODEL,
                    "response_text": text,
                    "completion_source": COMPLETION_SOURCE,
                },
            )
        )
        self._canonical(
            "turn_completed", {"stop_reason": "end_turn", "model": _MODEL, "provider": _MODEL}
        )
        return self._finish(
            _terminal_chat_response(
                request_id=rid,
                status=TURN_STATE_COMPLETED,
                notifications=self.terminal,
                tool_observation_stack=self.stack,
                response_text=text,
                completion_source=COMPLETION_SOURCE,
            ),
            outcome,
        )

    def unknown(self) -> ProcessOutcome:
        message = "Command outcome unknown."
        self.terminal.append(
            notification(
                CHAT_ERROR_METHOD,
                {
                    **self._context_fields(),
                    "code": CMP_CHAT_STREAM_FAILED,
                    "message": message,
                    "retryable": False,
                },
            )
        )
        self._canonical(
            "turn_failed", {"code": CMP_CHAT_STREAM_FAILED, "message": message, "retryable": False}
        )
        return self._finish(
            _terminal_chat_response(
                request_id=self.request.request_id,
                status=TURN_STATE_RUNTIME_ERROR,
                notifications=self.terminal,
                tool_observation_stack=self.stack,
            ),
            oc.unknown_outcome(),
        )

    def cancelled(
        self, error: TerminalChatStateError, outcome: oc.CommandOutcome
    ) -> ProcessOutcome:
        return self._finish(
            _terminal_chat_response(
                request_id=self.request.request_id,
                status=error.status,
                terminal_subcode=error.terminal_subcode,
                tool_observation_stack=self.stack,
            ),
            outcome,
        )

    def approval_stopped(self, verdict: ApprovalVerdict) -> ProcessOutcome:
        """The user denied, the ask timed out, or the round trip was cancelled: nothing ran."""
        r = self.request
        notifications: list[dict[str, Any]] = []
        if verdict.status == TURN_STATE_DENIED:
            notifications.append(
                emit_approval_rejection(
                    runtime=None,
                    request_id=r.request_id,
                    trace_id=r.trace_id,
                    session_id=r.session_id,
                    tool_name=_TOOL,
                    tool_call_id=r.tool_call_id,
                    observation_store=getattr(self.stack, "tool_observations", None),
                )
            )
        result = chat_result_with_tool_observations(
            build_turn_result(
                request_id=r.request_id,
                status=verdict.status,
                terminal_subcode=verdict.terminal_subcode,
            ),
            self.stack,
            request_id=r.request_id,
        )
        outcome = (
            oc.CommandOutcome(oc.STATUS_CANCELLED, None, None)
            if verdict.status == TURN_STATE_CANCELLED
            else oc.denied_outcome()
        )
        result["command_outcome"] = outcome.to_wire()
        return ProcessOutcome(True, False, result_response(self.message_id, result), notifications)


__all__ = ["COMPLETION_SOURCE", "TerminalBuilders"]
