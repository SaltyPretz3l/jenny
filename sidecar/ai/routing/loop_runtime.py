"""Per-request runtime context for the tool loop.

``LoopRuntime`` is an explicit dependency passed to ``run_tool_loop()`` --
not a global, not a ContextVar. It carries the event sink, optional
deadline state, and a lock for safe event emission.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable

from sidecar.ai.routing.loop_events import LoopEvent
from sidecar.ai.routing.tool_observation import (
    ToolObservationEvent,
    ToolObservationStore,
    tool_argument_fingerprint,
)
from sidecar.runtime.chat_models import TerminalChatStateError
from sidecar.runtime.multiplexer import TurnCancellationHandle
from sidecar.runtime.turn_state import (
    TERMINAL_SUBCODE_TIMEOUT_TURN,
    TURN_STATE_TIMEOUT,
)


def _noop_emit(_event: LoopEvent) -> None:
    """Default no-op emitter for non-streaming callers and tests."""


@dataclass
class LoopRuntime:
    """Per-request runtime context for the tool loop."""

    emit: Callable[[LoopEvent], None] = _noop_emit
    request_id: str = ""
    trace_id: str = ""
    session_id: str = ""
    notification_writer: Callable[[dict[str, Any]], None] | None = None
    electron_tool_writer: Callable[[dict[str, Any]], None] | None = None
    electron_tool_reader: Callable[[float], dict[str, Any]] | None = None
    electron_tool_reader_factory: Callable[..., Callable[[float], dict[str, Any]]] | None = None
    max_iterations: int = 8
    # Absolute iteration numbering for this run starts at ``iteration_base + 1``.
    # Non-zero only on approval-resume: the resumed loop must CONTINUE the
    # paused turn's numbering (not restart at 1) because streamed thinking/phase
    # identities embed ``current_iteration`` and must stay unique per turn.
    iteration_base: int = 0
    wall_clock_deadline: float | None = None
    chunk_inactivity_seconds: float = 120.0
    # Longer grace governing the wait for the FIRST streamed chunk only (which
    # also covers a model (re)load into VRAM). After the first chunk arrives,
    # ``chunk_inactivity_seconds`` governs every subsequent wait unchanged.
    model_load_grace_seconds: float = 300.0
    streaming: bool = False
    cancel_handle: TurnCancellationHandle | None = None
    current_iteration: int = 0
    completion_reason: str | None = None
    phase_events_enabled: bool = False
    observation_store: ToolObservationStore | None = None
    request_context: Any | None = None
    sub_agent_slot_allocator: Any | None = None
    tool_call_limit: int | None = None
    provider_cost_expected: bool = False
    tool_calls_consumed: int = 0
    pre_dispatch_emitted_call_ids: set[str] = field(default_factory=set)
    # TURN-scoped de-collision namespace for canonical tool-call ids. The
    # synthetic id formula is a pure function of (request_id, provider,
    # position, tool_name) -- all turn-constant or per-generation -- so two
    # iterations that call the same tool at the same ordinal mint BYTE-IDENTICAL
    # ids (the ordinary "read file A, then read file B" local-model shape).
    # Threading this set through ``canonicalize_tool_calls`` makes
    # ``safe_unique_tool_call_id`` rename the second occurrence deterministically
    # instead of letting it overwrite the first iteration's durable
    # tool_use/tool_result rows.
    turn_call_ids: set[str] = field(default_factory=set)
    emitted_tool_calls: dict[str, dict[str, Any]] = field(default_factory=dict)
    tool_result_emitted_call_ids: set[str] = field(default_factory=set)
    # Most-recent iteration's visible-text deltas buffered without flushing
    # (the "preamble + tool_calls" shape). Drained by ``StopController``-driven
    # aborts in ``tool_loop.run_tool_loop`` so users see the partial answer
    # instead of just the stop-reason stub.
    last_iteration_unflushed: list[str] = field(default_factory=list)
    # REQUEST-SCOPED memo for the ephemeral ``context.usage`` meter stream: the
    # last emitted (used, threshold, window) triple, so an unchanged reading is
    # not re-sent. ``LoopRuntime`` is per-request, so this cannot leak across
    # turns; it is deliberately NOT a high-water mark (compaction legitimately
    # lowers the used figure mid-turn and the ring must follow it down).
    context_usage_memo: tuple[int, int, int] | None = None
    # Set by ``generation_runtime`` when the stream-inactivity watchdog fires so
    # ``tool_loop`` can build a phase-accurate user message: "model_load" (the
    # first chunk never arrived — the (re)load itself exceeded the grace) vs
    # "inactivity" (the model started, then stalled between tokens). ``None``
    # means no stall fired this turn.
    stall_phase: str | None = None
    # Deadline time sources. Injectable because Windows' default monotonic
    # clock (GetTickCount64) has 15.625ms resolution: real-clock tests with
    # sub-tick deadlines quantize nondeterministically under load, so tests
    # supply a fake clock/sleep pair to make deadline decisions exact.
    clock: Callable[[], float] = field(default=time.monotonic, repr=False)
    sleep: Callable[[float], None] = field(default=time.sleep, repr=False)
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def emit_safe(self, event: LoopEvent) -> None:
        """Emit an event while serializing cross-thread producers."""
        with self._lock:
            self.emit(event)

    def ensure_tool_call_budget(self, configured_limit: int) -> None:
        """Initialize the request-owned cumulative tool budget once."""

        with self._lock:
            if self.tool_call_limit is None:
                self.tool_call_limit = max(1, int(configured_limit))
            self.tool_calls_consumed = min(
                max(0, int(self.tool_calls_consumed)),
                self.tool_call_limit,
            )

    def reserve_tool_calls(self, requested: int) -> int:
        """Reserve up to the remaining cumulative budget and return the admitted count."""

        with self._lock:
            if self.tool_call_limit is None:
                raise RuntimeError("tool call budget is not initialized")
            remaining = max(self.tool_call_limit - self.tool_calls_consumed, 0)
            admitted = min(max(0, int(requested)), remaining)
            self.tool_calls_consumed += admitted
            return admitted

    @property
    def remaining_tool_calls(self) -> int:
        with self._lock:
            if self.tool_call_limit is None:
                return 0
            return max(self.tool_call_limit - self.tool_calls_consumed, 0)

    def record_tool_executing(
        self,
        *,
        call_id: str,
        tool_name: str,
        arguments: dict[str, Any] | None = None,
    ) -> None:
        normalized_call_id = str(call_id or "").strip()
        if not normalized_call_id:
            return
        with self._lock:
            if normalized_call_id in self.emitted_tool_calls:
                return
            self.emitted_tool_calls[normalized_call_id] = {
                "call_id": normalized_call_id,
                "tool_name": str(tool_name or "").strip(),
                "arguments": dict(arguments or {}),
            }

    def record_tool_result(self, call_id: str) -> None:
        normalized_call_id = str(call_id or "").strip()
        if not normalized_call_id:
            return
        with self._lock:
            self.tool_result_emitted_call_ids.add(normalized_call_id)

    def pending_tool_executions(self) -> tuple[dict[str, Any], ...]:
        with self._lock:
            return tuple(
                dict(record)
                for call_id, record in self.emitted_tool_calls.items()
                if call_id not in self.tool_result_emitted_call_ids
            )

    def observe(self, event: ToolObservationEvent) -> None:
        """Record a Phase-6 audit event; failures must never break the turn.

        Mirrors the ``emit_safe`` guard pattern: if no observation store is
        wired, this is a no-op. Any exception raised by the store is
        swallowed — audit emissions are diagnostic-only and must not
        propagate into routing-layer control flow.
        """
        store = self.observation_store
        if store is None:
            return
        try:
            store.record(event)
        except Exception:
            return

    def audit(self, kind: str, **fields: Any) -> None:
        """Emit a Phase-6 audit event without callers building the DTO.

        Skips the dataclass allocation entirely when no store is wired,
        which matters on the streaming hot path. Wraps construction in
        ``try/except`` so a malformed kwarg cannot break the turn.
        """
        if self.observation_store is None:
            return
        try:
            call_id = str(fields.get("tool_call_id") or "").strip()
            if call_id and "_argument_fingerprint" not in fields:
                with self._lock:
                    emitted_call = self.emitted_tool_calls.get(call_id)
                    arguments = (
                        emitted_call.get("arguments")
                        if isinstance(emitted_call, dict)
                        else None
                    )
                if arguments is not None:
                    fields["_argument_fingerprint"] = tool_argument_fingerprint(arguments)
            event = ToolObservationEvent(
                kind=kind,
                request_id=self.request_id,
                **fields,
            )
        except Exception:
            return
        self.observe(event)

    @property
    def cancelled(self) -> bool:
        return self.cancel_handle.cancelled if self.cancel_handle is not None else False

    def raise_if_cancelled(self) -> None:
        if self.cancel_handle is None:
            return
        self.cancel_handle.raise_if_cancelled()

    def raise_if_deadline_exceeded(
        self,
        *,
        terminal_subcode: str = TERMINAL_SUBCODE_TIMEOUT_TURN,
        message: str = "chat.send wall-clock deadline exceeded",
    ) -> None:
        remaining = self.remaining_wall_clock_seconds()
        if remaining is None or remaining > 0:
            return
        raise TerminalChatStateError(
            status=TURN_STATE_TIMEOUT,
            message=message,
            terminal_subcode=terminal_subcode,
        )

    def raise_if_interrupted(
        self,
        *,
        terminal_subcode: str = TERMINAL_SUBCODE_TIMEOUT_TURN,
        message: str = "chat.send wall-clock deadline exceeded",
    ) -> None:
        """Raise the request's canonical cancellation or deadline terminal state."""

        self.raise_if_cancelled()
        self.raise_if_deadline_exceeded(
            terminal_subcode=terminal_subcode,
            message=message,
        )

    def remaining_wall_clock_seconds(self, *, now: float | None = None) -> float | None:
        if self.wall_clock_deadline is None:
            return None
        current = self.clock() if now is None else float(now)
        return self.wall_clock_deadline - current

    def tool_timeout_seconds(self, configured_timeout_seconds: float) -> float:
        configured = max(0.0, float(configured_timeout_seconds))
        remaining = self.remaining_wall_clock_seconds()
        if remaining is None:
            return configured
        return min(configured, max(0.0, remaining))

    def wait_interruptibly(
        self,
        delay_seconds: float,
        *,
        terminal_subcode: str = TERMINAL_SUBCODE_TIMEOUT_TURN,
        message: str = "chat.send wall-clock deadline exceeded",
    ) -> None:
        """Wait no longer than the request deadline and remain cancellation-aware."""

        self.raise_if_interrupted(
            terminal_subcode=terminal_subcode,
            message=message,
        )
        delay = max(0.0, float(delay_seconds))
        remaining = self.remaining_wall_clock_seconds()
        if remaining is not None:
            delay = min(delay, max(0.0, remaining))
        if self.cancel_handle is not None:
            self.cancel_handle.wait(delay)
        elif delay > 0:
            self.sleep(delay)
        self.raise_if_interrupted(
            terminal_subcode=terminal_subcode,
            message=message,
        )
