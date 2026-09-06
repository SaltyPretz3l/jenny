"""Internal tool/observation audit layer (Phase 6).

Provides a typed audit-event DTO (``ToolObservationEvent``) and a bounded
per-turn store (``ToolObservationStore``) that records routing-layer
transitions without modifying the public protocol or the persisted
``turn_events[]`` log.

Audit events are internal-only:
- They are not in ``sidecar/protocol.py``.
- They are not in ``ALLOWED_NOTIFICATION_METHODS``.
- They are not a ``turn_events[]`` kind.
- They are surfaced solely through ``harness.inspect`` →
  ``runtime.recent_tool_observations[]`` for diagnostics + reconstruction.

The store mirrors ``sidecar/runtime/turn_diagnostics.TurnDiagnosticsStore``
exactly: an ``OrderedDict`` of per-turn buffers, a single ``Lock``, and a
FIFO eviction policy. See the Phase 6 plan for the locked design.
"""

from __future__ import annotations

import hashlib
import json
import threading
from collections import OrderedDict, deque
from dataclasses import dataclass, field, replace
from typing import Any, Deque

KIND_MODEL_TOOL_REQUESTED = "model_tool_requested"
KIND_TOOL_EXECUTION_STARTED = "tool_execution_started"
KIND_TOOL_EXECUTION_OBSERVED = "tool_execution_observed"
KIND_TOOL_EXECUTION_FAILED = "tool_execution_failed"
KIND_USER_APPROVAL_REQUESTED = "user_approval_requested"
KIND_USER_APPROVAL_REJECTED = "user_approval_rejected"
KIND_MODEL_VISIBLE_TEXT_DELTA = "model_visible_text_delta"
KIND_MODEL_REASONING_DELTA = "model_reasoning_delta"
KIND_TURN_COMPLETED = "turn_completed"
KIND_TURN_FAILED = "turn_failed"

ALL_KINDS: frozenset[str] = frozenset(
    {
        KIND_MODEL_TOOL_REQUESTED,
        KIND_TOOL_EXECUTION_STARTED,
        KIND_TOOL_EXECUTION_OBSERVED,
        KIND_TOOL_EXECUTION_FAILED,
        KIND_USER_APPROVAL_REQUESTED,
        KIND_USER_APPROVAL_REJECTED,
        KIND_MODEL_VISIBLE_TEXT_DELTA,
        KIND_MODEL_REASONING_DELTA,
        KIND_TURN_COMPLETED,
        KIND_TURN_FAILED,
    }
)

_TOOL_EVENT_KINDS = frozenset(
    {
        KIND_MODEL_TOOL_REQUESTED,
        KIND_TOOL_EXECUTION_STARTED,
        KIND_TOOL_EXECUTION_OBSERVED,
        KIND_TOOL_EXECUTION_FAILED,
    }
)
_VOLATILE_TOOL_ARGUMENT_KEYS = frozenset(
    {
        "session_id",
        "request_id",
        "trace_id",
        "tool_call_id",
        "api_version",
        "_jenny_session_id",
        "_jenny_idempotency_key",
        # Model-authored explanation shown on the approval card; it never
        # changes what the tool does, so two calls differing only in their
        # purpose text are the same call for the repeat-call guardrail.
        "purpose",
    }
)


@dataclass(frozen=True)
class ToolObservationEvent:
    """Typed audit event recorded at routing-layer transitions.

    Public fields are surfaced via ``to_payload()`` and through
    ``runtime.recent_tool_observations[]``. Underscore-prefixed fields are
    implementation details and never leave the store.
    """

    kind: str
    request_id: str
    turn_id: str | None = None
    tool_call_id: str | None = None
    tool_name: str | None = None
    summary: str = ""
    error_code: str | None = None
    sequence: int = 0
    _argument_fingerprint: str = ""

    def to_payload(self) -> dict[str, Any]:
        """Return the public-payload dict (underscore-prefixed fields stripped)."""
        return {
            "kind": self.kind,
            "request_id": self.request_id,
            "turn_id": self.turn_id,
            "tool_call_id": self.tool_call_id,
            "tool_name": self.tool_name,
            "summary": self.summary,
            "error_code": self.error_code,
            "sequence": self.sequence,
        }


@dataclass
class _TurnBuffer:
    request_id: str
    turn_id: str | None
    events: Deque[ToolObservationEvent] = field(default_factory=deque)
    next_sequence: int = 1


class ToolObservationStore:
    """Thread-safe bounded per-turn audit store.

    Mirrors ``TurnDiagnosticsStore``: ``OrderedDict`` keyed by ``request_id``,
    FIFO eviction when ``max_retained_turns`` is exceeded, and per-turn
    ``deque(maxlen=max_events_per_turn)`` for fast bounded inserts.

    A failure inside any method is allowed to raise — callers must wrap in
    ``try/except``. ``LoopRuntime.observe()`` is the canonical guard.
    """

    def __init__(
        self,
        *,
        max_events_per_turn: int = 200,
        max_retained_turns: int = 64,
    ) -> None:
        self._lock = threading.Lock()
        self._turns: "OrderedDict[str, _TurnBuffer]" = OrderedDict()
        self._max_events_per_turn = max(int(max_events_per_turn or 200), 1)
        self._max_retained_turns = max(int(max_retained_turns or 64), 1)
        self._latest_request_id: str | None = None
        self._event_eviction_count = 0
        self._turn_eviction_count = 0

    def ensure_turn(
        self,
        *,
        request_id: str,
        turn_id: str | None = None,
    ) -> None:
        """Create a turn buffer once while preserving approval-resume history."""

        normalized = str(request_id or "").strip()
        if not normalized:
            return
        normalized_turn_id = str(turn_id).strip() if turn_id is not None else None
        with self._lock:
            existing = self._turns.get(normalized)
            if existing is not None:
                if existing.turn_id is None and normalized_turn_id:
                    existing.turn_id = normalized_turn_id
                self._turns.move_to_end(normalized)
                self._latest_request_id = normalized
                return
            self._turns[normalized] = _TurnBuffer(
                request_id=normalized,
                turn_id=normalized_turn_id,
                events=deque(maxlen=self._max_events_per_turn),
                next_sequence=1,
            )
            self._latest_request_id = normalized
            self._prune_locked()

    def record(self, event: ToolObservationEvent) -> None:
        """Append ``event`` to its turn's buffer.

        Assigns a monotonic per-turn ``sequence`` (overwriting whatever the
        caller passed). Lazily creates the buffer when ``ensure_turn`` was
        skipped — defensive for early-emit scenarios.
        """
        normalized = str(event.request_id or "").strip()
        if not normalized:
            return
        with self._lock:
            buffer = self._turns.get(normalized)
            newly_created = buffer is None
            if buffer is None:
                buffer = _TurnBuffer(
                    request_id=normalized,
                    turn_id=event.turn_id,
                    events=deque(maxlen=self._max_events_per_turn),
                    next_sequence=1,
                )
                self._turns[normalized] = buffer
                self._prune_locked()
            sequence = buffer.next_sequence
            buffer.next_sequence = sequence + 1
            turn_id = event.turn_id if event.turn_id is not None else buffer.turn_id
            stamped = replace(
                event,
                request_id=normalized,
                turn_id=turn_id,
                sequence=sequence,
            )
            if len(buffer.events) >= self._max_events_per_turn:
                self._event_eviction_count += 1
            buffer.events.append(stamped)
            if not newly_created:
                self._turns.move_to_end(normalized)
            self._latest_request_id = normalized

    def recent_events(
        self,
        *,
        request_id: str,
        limit: int = 50,
    ) -> tuple[ToolObservationEvent, ...]:
        normalized = str(request_id or "").strip()
        if not normalized:
            return ()
        bounded = max(int(limit or 0), 0)
        if bounded == 0:
            return ()
        with self._lock:
            buffer = self._turns.get(normalized)
            if buffer is None:
                return ()
            events = tuple(buffer.events)
        if len(events) <= bounded:
            return events
        return events[-bounded:]

    def recent_events_for_latest_turn(
        self,
        *,
        limit: int = 50,
    ) -> tuple[str | None, tuple[ToolObservationEvent, ...]]:
        """Return ``(latest_request_id, events)`` under a single lock.

        Keeps the ``harness.inspect`` payload path to a single lock acquisition.
        """
        bounded = max(int(limit or 0), 0)
        with self._lock:
            request_id = self._latest_request_id
            if not request_id or bounded == 0:
                return request_id, ()
            buffer = self._turns.get(request_id)
            if buffer is None:
                return request_id, ()
            events = tuple(buffer.events)
        if len(events) <= bounded:
            return request_id, events
        return request_id, events[-bounded:]

    def retention_snapshot(self) -> dict[str, Any]:
        with self._lock:
            event_count = sum(len(buffer.events) for buffer in self._turns.values())
            return {
                "max_events_per_turn": self._max_events_per_turn,
                "max_retained_turns": self._max_retained_turns,
                "retained_turn_count": len(self._turns),
                "retained_event_count": event_count,
                "event_eviction_count": self._event_eviction_count,
                "turn_eviction_count": self._turn_eviction_count,
            }

    def _prune_locked(self) -> None:
        while len(self._turns) > self._max_retained_turns:
            oldest_request_id, _ = next(iter(self._turns.items()))
            self._turns.pop(oldest_request_id, None)
            self._turn_eviction_count += 1
            if self._latest_request_id == oldest_request_id:
                self._latest_request_id = next(reversed(self._turns), None)


def tool_argument_fingerprint(arguments: Any) -> str:
    """Return a stable hash of semantic tool arguments without retaining them."""

    if isinstance(arguments, dict):
        filtered = {
            str(key): value
            for key, value in arguments.items()
            if not str(key).startswith("_")
            and str(key) not in _VOLATILE_TOOL_ARGUMENT_KEYS
        }
    else:
        filtered = arguments
    payload = json.dumps(filtered, sort_keys=True, default=str, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]


def observation_signature(event: ToolObservationEvent) -> str:
    """Return an argument-aware semantic signature for ``event``.

    Tool observations use a redacted argument fingerprint. Older or synthetic
    producers fall back to ``tool_call_id`` so unrelated calls fail open.
    ``summary`` remains excluded because its wording is diagnostic-only.
    """

    tool_identity = ""
    if event.kind in _TOOL_EVENT_KINDS:
        tool_identity = str(event._argument_fingerprint or "").strip()
        if not tool_identity:
            call_id = str(event.tool_call_id or "").strip()
            tool_identity = (
                f"call:{call_id}" if call_id else f"event:{event.sequence}"
            )
    payload = "|".join(
        [
            str(event.kind or ""),
            str(event.tool_name or ""),
            str(event.error_code or ""),
            tool_identity,
        ]
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]


def recent_observations_payload(
    store: ToolObservationStore | None,
    *,
    request_id: str | None,
    limit: int = 50,
) -> list[dict[str, Any]]:
    """Return the recent observations for ``request_id`` as public payloads.

    Returns ``[]`` when the store is None, the request_id is missing, or
    no events have been recorded for it. The returned list is sorted by
    insertion order (i.e., monotonic ``sequence``).
    """
    if store is None:
        return []
    normalized = str(request_id or "").strip()
    if not normalized:
        return []
    try:
        events = store.recent_events(request_id=normalized, limit=limit)
    except Exception:
        return []
    return [event.to_payload() for event in events]


__all__ = [
    "ALL_KINDS",
    "KIND_MODEL_REASONING_DELTA",
    "KIND_MODEL_TOOL_REQUESTED",
    "KIND_MODEL_VISIBLE_TEXT_DELTA",
    "KIND_TOOL_EXECUTION_FAILED",
    "KIND_TOOL_EXECUTION_OBSERVED",
    "KIND_TOOL_EXECUTION_STARTED",
    "KIND_TURN_COMPLETED",
    "KIND_TURN_FAILED",
    "KIND_USER_APPROVAL_REJECTED",
    "KIND_USER_APPROVAL_REQUESTED",
    "ToolObservationEvent",
    "ToolObservationStore",
    "observation_signature",
    "recent_observations_payload",
    "tool_argument_fingerprint",
]
