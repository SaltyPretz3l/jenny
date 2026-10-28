"""Canonical turn-result status and terminal-subcode helpers.

Also the live per-turn state the shell can reach mid-turn through unversioned
notifications: the run mode (``session.run_mode_updated``) and the mid-turn mail
queue (``session.mail_arrived``, row 70 W2a). Each is held on the multiplexer's
turn handle and bound for the tool loop through a contextvar.
"""

from __future__ import annotations

import json
import logging
import threading
from contextlib import contextmanager
from contextvars import ContextVar, Token
from dataclasses import dataclass, field
from typing import Any, Callable, Iterator

# Per-turn bound on mid-turn mail (row 70 W2a): the admission snapshot entry cap and
# the per-snapshot envelope byte budget on the Electron side. The oldest rows are kept.
MAX_PENDING_MAIL_ROWS = 16
MAX_PENDING_MAIL_BYTES = 32 * 1024


@dataclass
class LiveRunModeState:
    approval_mode: str = "prompt"
    read_only: bool = False
    paused_unattended: bool = False
    auto_approvals: int = 0
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def update(
        self,
        *,
        approval_mode: str,
        read_only: bool,
        paused_unattended: bool | None = None,
    ) -> None:
        normalized_mode = "auto_run" if approval_mode == "auto_run" else "prompt"
        with self._lock:
            self.approval_mode = normalized_mode
            # Entering Plan Mode cannot safely make an in-flight turn read-only.
            # Leaving Plan Mode may relax the request-local boundary immediately.
            if read_only is False:
                self.read_only = False
            if paused_unattended is not None:
                self.paused_unattended = paused_unattended

    def snapshot(self) -> tuple[str, bool]:
        with self._lock:
            return self.approval_mode, self.read_only

    def is_paused_unattended(self) -> bool:
        with self._lock:
            return self.paused_unattended

    def record_auto_approval(self) -> int:
        with self._lock:
            self.auto_approvals += 1
            return self.auto_approvals

    def reset_auto_approvals(self) -> None:
        with self._lock:
            self.auto_approvals = 0


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


def _row_message_id(row: dict[str, Any]) -> str:
    envelope = row.get("session_message")
    return str(envelope.get("message_id") or "") if isinstance(envelope, dict) else ""


@dataclass
class PendingMailQueue:
    """Mid-turn mail parked for the tool loop: already-validated context rows.

    Bounded per turn (not per drain): at most ``MAX_PENDING_MAIL_ROWS`` rows and
    ``MAX_PENDING_MAIL_BYTES`` of compact JSON are ever accepted, the earliest kept;
    a message id is accepted at most once.
    """

    _rows: list[dict[str, Any]] = field(default_factory=list)
    _accepted_ids: set[str] = field(default_factory=set)
    _accepted_bytes: int = 0
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def push(self, rows: list[dict[str, Any]]) -> tuple[list[str], int]:
        """Queue rows in order; returns (accepted message ids, dropped row count)."""
        accepted: list[str] = []
        dropped = 0
        with self._lock:
            for row in rows:
                message_id = _row_message_id(row)
                if (
                    not message_id
                    or message_id in self._accepted_ids
                    or len(self._accepted_ids) >= MAX_PENDING_MAIL_ROWS
                ):
                    dropped += 1
                    continue
                # Serialize only rows that passed the cheap checks (stdin reader thread).
                encoded = json.dumps(row, separators=(",", ":"), ensure_ascii=False)
                size = len(encoded.encode("utf-8"))
                if self._accepted_bytes + size > MAX_PENDING_MAIL_BYTES:
                    dropped += 1
                    continue
                self._accepted_ids.add(message_id)
                self._accepted_bytes += size
                self._rows.append(row)
                accepted.append(message_id)
        return accepted, dropped

    def drain(self) -> list[dict[str, Any]]:
        """Return and clear the queued rows (the per-turn bound is not reset)."""
        with self._lock:
            rows, self._rows = self._rows, []
        return rows


_PENDING_MAIL: ContextVar[PendingMailQueue | None] = ContextVar(
    "sidecar_pending_mail",
    default=None,
)


@contextmanager
def bind_pending_mail(queue: PendingMailQueue) -> Iterator[None]:
    token: Token[PendingMailQueue | None] = _PENDING_MAIL.set(queue)
    try:
        yield
    finally:
        _PENDING_MAIL.reset(token)


def current_pending_mail() -> PendingMailQueue | None:
    return _PENDING_MAIL.get()


TurnLookup = Callable[[str], Any]


def apply_run_mode_update(
    params: dict[str, Any], lookup: TurnLookup, logger: logging.Logger
) -> None:
    """Apply ``session.run_mode_updated`` to the session's live turn, if any."""
    session_id = str(params.get("session_id") or "").strip()
    approval_mode = params.get("approval_mode")
    read_only = params.get("read_only")
    reason = params.get("reason")
    if not isinstance(reason, str):
        reason = None
    if (
        not session_id
        or approval_mode not in {"prompt", "auto_run"}
        or not isinstance(read_only, bool)
    ):
        logger.warning(
            "Ignored malformed live run-mode update",
            extra={"event": "sidecar.runtime.run_mode_update.invalid"},
        )
        return
    handle = lookup(session_id)
    if handle is None:
        return
    handle.live_run_mode.update(
        approval_mode=approval_mode,
        read_only=read_only,
        paused_unattended=reason == "unattended_idle",
    )


def _non_empty_str(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def admit_mail_arrived(params: dict[str, Any], lookup: TurnLookup, logger: logging.Logger) -> None:
    """Park ``session.mail_arrived`` rows on the matching live turn's queue.

    A notification: never raises and never answers. Rows are untrusted, so the
    logs carry ids and counts only, never a body or a title.
    """
    try:
        session_id = _non_empty_str(params.get("session_id"))
        request_id = _non_empty_str(params.get("request_id"))
        rows = params.get("rows")
        if not session_id or not request_id or not isinstance(rows, list):
            logger.warning(
                "Ignored malformed mid-turn mail",
                extra={"event": "sidecar.runtime.mail_arrived.invalid"},
            )
            return
        handle = lookup(session_id)
        queue = getattr(handle, "pending_mail", None)
        live = handle is not None and handle.request_id == request_id
        if not live or not isinstance(queue, PendingMailQueue):
            logger.info(
                "Ignored mid-turn mail for a turn that is not live",
                extra={
                    "event": "sidecar.runtime.mail_arrived.stale",
                    "session_id": session_id,
                    "request_id": request_id,
                },
            )
            return
        from sidecar.ai.context.session_messages import session_message_row_error

        valid = [row for row in rows if session_message_row_error(row) is None]
        context = {"session_id": session_id, "request_id": request_id}
        if len(valid) < len(rows):
            logger.warning(
                "Dropped invalid mid-turn mail rows",
                extra={
                    "event": "sidecar.runtime.mail_arrived.invalid_rows",
                    "count": len(rows) - len(valid),
                    **context,
                },
            )
        accepted, dropped = queue.push(valid)
        if dropped:
            logger.warning(
                "Dropped duplicate or over-bound mid-turn mail rows",
                extra={
                    "event": "sidecar.runtime.mail_arrived.dropped",
                    "count": dropped,
                    **context,
                },
            )
        logger.info(
            "Queued mid-turn mail",
            extra={"event": "sidecar.runtime.mail_arrived", "accepted": len(accepted), **context},
        )
    except Exception:  # noqa: BLE001 - a notification handler must never break the reader.
        logger.warning(
            "Mid-turn mail handling failed",
            extra={"event": "sidecar.runtime.mail_arrived.failed"},
        )

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
        # Electron cancels an in-flight turn with this when Jenny closes (dogfood TR-012).
        "app_shutdown",
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
