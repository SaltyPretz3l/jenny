"""Canonical turn-result status and terminal-subcode helpers."""

from __future__ import annotations

import threading
from contextlib import contextmanager
from contextvars import ContextVar, Token
from dataclasses import dataclass, field
from typing import Iterator


@dataclass
class LiveRunModeState:
    approval_mode: str = "prompt"
    read_only: bool = False
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def update(self, *, approval_mode: str, read_only: bool) -> None:
        normalized_mode = "auto_run" if approval_mode == "auto_run" else "prompt"
        with self._lock:
            self.approval_mode = normalized_mode
            # Entering Plan Mode cannot safely make an in-flight turn read-only.
            # Leaving Plan Mode may relax the request-local boundary immediately.
            if read_only is False:
                self.read_only = False

    def snapshot(self) -> tuple[str, bool]:
        with self._lock:
            return self.approval_mode, self.read_only


_LIVE_RUN_MODE_STATE: ContextVar[LiveRunModeState | None] = ContextVar(
    "sidecar_live_run_mode_state",
    default=None,
)


@contextmanager
def bind_live_run_mode_state(state: LiveRunModeState) -> Iterator[None]:
    token: Token[LiveRunModeState | None] = _LIVE_RUN_MODE_STATE.set(state)
    try:
        yield
    finally:
        _LIVE_RUN_MODE_STATE.reset(token)


def current_live_run_mode_state() -> LiveRunModeState | None:
    return _LIVE_RUN_MODE_STATE.get()

TURN_STATE_COMPLETED = "completed"
TURN_STATE_DENIED = "denied"
TURN_STATE_CANCELLED = "cancelled"
TURN_STATE_PREEMPTED = "preempted"
TURN_STATE_TIMEOUT = "timeout"
TURN_STATE_RUNTIME_ERROR = "runtime_error"
TURN_STATE_QUESTION_BATCH = "question_batch"

TERMINAL_SUBCODE_SIDECAR_CRASH = "sidecar_crash"
TERMINAL_SUBCODE_TRANSPORT_BACKPRESSURE = "transport_backpressure"
TERMINAL_SUBCODE_SCHEMA_RETRY_EXHAUSTED = "schema_retry_exhausted"
TERMINAL_SUBCODE_PLAN_DRIFT_EXHAUSTED = "plan_drift_exhausted"
TERMINAL_SUBCODE_PROTOCOL_VIOLATION = "protocol_violation"
TERMINAL_SUBCODE_UNHANDLED_EXCEPTION = "unhandled_exception"
TERMINAL_SUBCODE_REASONING_ONLY = "reasoning_only"
TERMINAL_SUBCODE_STREAM_INCOMPLETE = "stream_incomplete"
TERMINAL_SUBCODE_THINKING_BUDGET = "thinking_budget"

TERMINAL_SUBCODE_TIMEOUT_PROVIDER = "provider"
TERMINAL_SUBCODE_TIMEOUT_APPROVAL = "approval"
TERMINAL_SUBCODE_TIMEOUT_TOOL = "tool"
TERMINAL_SUBCODE_TIMEOUT_TURN = "turn"

TERMINAL_SUBCODE_PREEMPTED_PLAN_DRIFT = "plan_drift"
TERMINAL_SUBCODE_PREEMPTED_WORKSPACE_CHANGED = "workspace_changed"

TERMINAL_SUBCODE_DENIED_USER_EXPLICIT = "user_explicit"
TERMINAL_SUBCODE_DENIED_POLICY_WORKSPACE_ROOT_MISSING = "policy_workspace_root_missing"
TERMINAL_SUBCODE_DENIED_POLICY_DANGEROUS_TOOL = "policy_dangerous_tool"
TERMINAL_SUBCODE_DENIED_READ_ONLY_BLOCKED = "read_only_blocked"
TERMINAL_SUBCODE_DENIED_EXPIRED = "expired"

TERMINAL_SUBCODE_COMPLETED_ASSISTANT_RESPONSE = "assistant_response"
TERMINAL_SUBCODE_COMPLETED_NO_OUTPUT = "no_output"

CANCELLED_TERMINAL_SUBCODES = frozenset(
    {
        "user_cancel",
        "service_stop",
        "dispose",
        "timeout",
        "session_delete",
        "transport_abort",
        "sidecar_cancel",
    }
)

RUNTIME_ERROR_TERMINAL_SUBCODES = frozenset(
    {
        TERMINAL_SUBCODE_SIDECAR_CRASH,
        TERMINAL_SUBCODE_TRANSPORT_BACKPRESSURE,
        TERMINAL_SUBCODE_SCHEMA_RETRY_EXHAUSTED,
        TERMINAL_SUBCODE_PLAN_DRIFT_EXHAUSTED,
        TERMINAL_SUBCODE_PROTOCOL_VIOLATION,
        TERMINAL_SUBCODE_UNHANDLED_EXCEPTION,
        TERMINAL_SUBCODE_REASONING_ONLY,
        TERMINAL_SUBCODE_STREAM_INCOMPLETE,
        TERMINAL_SUBCODE_THINKING_BUDGET,
    }
)

TIMEOUT_TERMINAL_SUBCODES = frozenset(
    {
        TERMINAL_SUBCODE_TIMEOUT_PROVIDER,
        TERMINAL_SUBCODE_TIMEOUT_APPROVAL,
        TERMINAL_SUBCODE_TIMEOUT_TOOL,
        TERMINAL_SUBCODE_TIMEOUT_TURN,
    }
)

PREEMPTED_TERMINAL_SUBCODES = frozenset(
    {
        TERMINAL_SUBCODE_PREEMPTED_PLAN_DRIFT,
        TERMINAL_SUBCODE_PREEMPTED_WORKSPACE_CHANGED,
    }
)

DENIED_TERMINAL_SUBCODES = frozenset(
    {
        TERMINAL_SUBCODE_DENIED_USER_EXPLICIT,
        TERMINAL_SUBCODE_DENIED_POLICY_WORKSPACE_ROOT_MISSING,
        TERMINAL_SUBCODE_DENIED_POLICY_DANGEROUS_TOOL,
        TERMINAL_SUBCODE_DENIED_READ_ONLY_BLOCKED,
        TERMINAL_SUBCODE_DENIED_EXPIRED,
    }
)

COMPLETED_TERMINAL_SUBCODES = frozenset(
    {
        TERMINAL_SUBCODE_COMPLETED_ASSISTANT_RESPONSE,
        TERMINAL_SUBCODE_COMPLETED_NO_OUTPUT,
    }
)

TERMINAL_SUBCODES_BY_STATE = {
    TURN_STATE_COMPLETED: COMPLETED_TERMINAL_SUBCODES,
    TURN_STATE_DENIED: DENIED_TERMINAL_SUBCODES,
    TURN_STATE_CANCELLED: CANCELLED_TERMINAL_SUBCODES,
    TURN_STATE_RUNTIME_ERROR: RUNTIME_ERROR_TERMINAL_SUBCODES,
    TURN_STATE_TIMEOUT: TIMEOUT_TERMINAL_SUBCODES,
    TURN_STATE_PREEMPTED: PREEMPTED_TERMINAL_SUBCODES,
}

TURN_STATE_VALUES = frozenset(
    {
        TURN_STATE_COMPLETED,
        TURN_STATE_DENIED,
        TURN_STATE_CANCELLED,
        TURN_STATE_PREEMPTED,
        TURN_STATE_TIMEOUT,
        TURN_STATE_RUNTIME_ERROR,
        TURN_STATE_QUESTION_BATCH,
    }
)

def normalize_turn_state(value: str) -> str:
    normalized = str(value or "").strip().lower()
    if normalized not in TURN_STATE_VALUES:
        raise ValueError(f"Unknown turn state: {value!r}")
    return normalized


def normalize_terminal_subcode(
    state: str,
    terminal_subcode: str | None,
) -> str | None:
    normalized_state = normalize_turn_state(state)
    normalized_subcode = str(terminal_subcode or "").strip().lower() or None
    allowed_subcodes = TERMINAL_SUBCODES_BY_STATE.get(normalized_state)
    if allowed_subcodes is None:
        return None
    if normalized_subcode is None:
        return None
    if normalized_subcode not in allowed_subcodes:
        raise ValueError(
            f"Unknown terminal subcode {terminal_subcode!r} for turn state {normalized_state!r}"
        )
    return normalized_subcode


def build_turn_result(
    *,
    request_id: str,
    status: str,
    terminal_subcode: str | None = None,
) -> dict[str, str]:
    normalized_status = normalize_turn_state(status)
    result = {
        "request_id": str(request_id or "").strip(),
        "status": normalized_status,
    }
    normalized_subcode = normalize_terminal_subcode(
        normalized_status,
        terminal_subcode,
    )
    if normalized_subcode:
        result["terminal_subcode"] = normalized_subcode
    return result
