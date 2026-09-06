"""Single-pipe transport routing for sidecar stdio requests."""

from __future__ import annotations

import logging
import queue
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable

from sidecar.ai.engine_liveness import record_engine_activity
from sidecar.ai.error_codes import CMP_PROTO_VERSION_MISMATCH
from sidecar.protocol import (
    CHAT_CANCEL_METHOD,
    ENGINE_ACTIVITY_METHOD,
    SESSION_RUN_MODE_UPDATED_METHOD,
)
from sidecar.runtime import subagent_slots as _subagent_slots
from sidecar.runtime.chat_models import TerminalChatStateError
from sidecar.runtime.diagnostics import log_event
from sidecar.runtime.framing import encode_framed_body
from sidecar.runtime.message_reader import BackgroundMessageReader, ReaderDrainResult
from sidecar.runtime.rpc import (
    JsonRpcEnvelope,
    JsonRpcEnvelopeError,
    result_response,
    validate_jsonrpc_envelope,
    validate_method_version,
)
from sidecar.runtime.turn_state import (
    CANCELLED_TERMINAL_SUBCODES,
    TURN_STATE_CANCELLED,
    LiveRunModeState,
)

SubAgentSlotAllocator = _subagent_slots.SubAgentSlotAllocator
SubAgentSlotLease = _subagent_slots.SubAgentSlotLease
SubAgentSlotLimitExceededError = _subagent_slots.SubAgentSlotLimitExceededError
SubAgentSlotPerParentLimitExceededError = (
    _subagent_slots.SubAgentSlotPerParentLimitExceededError
)

_DEFAULT_CANCEL_TOMBSTONE_TTL_SECONDS = 5.0
DEFAULT_MAX_ACTIVE_TURNS = 16
DEFAULT_MAX_CANCEL_TOMBSTONES = 256
_OUTPUT_QUEUE_GET_TIMEOUT_SECONDS = 0.05
_OUTPUT_HIGH_WATER_MARK_BYTES = 4 * 1024 * 1024
_OUTPUT_CONTROL_RESERVE_BYTES = 1 * 1024 * 1024
_INVALID_PARAMS_CODE = -32602


def _normalize_cancel_reason(value: Any, *, fallback: str = "sidecar_cancel") -> str:
    normalized = str(value or "").strip().replace("-", "_").replace(" ", "_").lower()
    if normalized in {"chat_cancel", "chat_cancelled"}:
        return "sidecar_cancel"
    if normalized in CANCELLED_TERMINAL_SUBCODES:
        return normalized
    return fallback if fallback in CANCELLED_TERMINAL_SUBCODES else "sidecar_cancel"


class TransportBackpressureError(RuntimeError):
    """Raised when the outbound transport queue stays above its safe bound."""


class DuplicateRequestIdError(RuntimeError):
    """Raised when a live request_id is registered twice."""


class DuplicateSessionTurnError(RuntimeError):
    """Raised when one session attempts a second non-superseding turn."""


class ActiveTurnLimitExceededError(RuntimeError):
    """Raised when the sidecar active-turn ceiling is reached."""


class ApprovalResponseCancelledError(RuntimeError):
    """Raised when approval waiting is interrupted by turn cancellation."""


@dataclass
class TurnCancellationHandle:
    request_id: str
    trace_id: str | None = None
    session_id: str | None = None
    generation: int | None = None
    live_run_mode: LiveRunModeState = field(default_factory=LiveRunModeState)
    reason: str = "chat_cancelled"
    _event: threading.Event = field(default_factory=threading.Event)
    _lock: threading.Lock = field(default_factory=threading.Lock)
    _callbacks: dict[int, Callable[[str], None]] = field(default_factory=dict)
    _children: list["TurnCancellationHandle"] = field(default_factory=list)
    _callback_sequence: int = 0

    def cancel(self, *, reason: str = "chat_cancelled") -> bool:
        callbacks: list[Callable[[str], None]] = []
        children: list[TurnCancellationHandle] = []
        normalized_reason = _normalize_cancel_reason(reason)
        with self._lock:
            already_cancelled = self._event.is_set()
            if not already_cancelled:
                self.reason = normalized_reason
                self._event.set()
                callbacks = list(self._callbacks.values())
                self._callbacks.clear()
                children = list(self._children)
            else:
                normalized_reason = self.reason
        for callback in callbacks:
            try:
                callback(normalized_reason)
            except Exception:  # noqa: BLE001 - cancellation cleanup is best-effort.
                pass
        for child in children:
            child.cancel(reason=normalized_reason)
        return not already_cancelled

    def register_cancel_callback(self, callback: Callable[[str], None]) -> Callable[[], None]:
        if not callable(callback):
            return lambda: None
        run_now = False
        reason = self.reason
        with self._lock:
            if self._event.is_set():
                run_now = True
                reason = self.reason
            else:
                self._callback_sequence += 1
                token = self._callback_sequence
                self._callbacks[token] = callback

                def unregister() -> None:
                    with self._lock:
                        self._callbacks.pop(token, None)

                return unregister
        if run_now:
            try:
                callback(reason)
            except Exception:  # noqa: BLE001 - cancellation cleanup is best-effort.
                pass
        return lambda: None

    @property
    def cancelled(self) -> bool:
        return self._event.is_set()

    def wait(self, timeout_seconds: float | None = None) -> bool:
        return self._event.wait(timeout_seconds)

    def raise_if_cancelled(self) -> None:
        if not self.cancelled:
            return
        raise TerminalChatStateError(
            status=TURN_STATE_CANCELLED,
            message="chat.send cancelled",
            terminal_subcode=self.reason,
        )

    def create_child(
        self,
        *,
        request_id: str,
        trace_id: str | None = None,
        session_id: str | None = None,
    ) -> "TurnCancellationHandle":
        child = TurnCancellationHandle(
            request_id=str(request_id or "").strip(),
            trace_id=trace_id if trace_id is not None else self.trace_id,
            session_id=session_id if session_id is not None else self.session_id,
            reason=self.reason,
        )
        with self._lock:
            self._children.append(child)
            already_cancelled = self._event.is_set()
            reason = self.reason
        if already_cancelled:
            child.cancel(reason=reason)
        return child

    def detach_child(self, child: "TurnCancellationHandle") -> bool:
        """Stop propagating future parent cancellation to a settled child."""
        with self._lock:
            for index, candidate in enumerate(self._children):
                if candidate is child:
                    self._children.pop(index)
                    return True
        return False


@dataclass(frozen=True)
class WriterDrainResult:
    """Bounded shutdown proof for the sidecar stdout writer."""

    drained: bool
    pending_frames: int
    pending_bytes: int
    worker_alive: bool
    write_error_type: str | None


@dataclass(frozen=True)
class TransportDrainResult:
    """One-deadline shutdown proof for both stdio transport workers."""

    drained: bool
    reader: ReaderDrainResult
    writer: WriterDrainResult


@dataclass(frozen=True)
class _OutboundFrame:
    body: bytes
    # Retained only for the no-body-writer fallback; production wires
    # write_frame_body and would otherwise hold a second copy of every payload.
    message: dict[str, Any] | None
    lane: str

    @property
    def encoded_size(self) -> int:
        return len(self.body)


@dataclass(frozen=True)
class _OutboundBatch:
    frames: tuple[_OutboundFrame, ...]
    encoded_size: int


class PrioritizedMessageWriter:
    """Serialize stdout writes through one worker with control-first priority."""

    def __init__(
        self,
        *,
        write_message: Callable[[dict[str, Any]], None],
        write_frame_body: Callable[[bytes], None] | None = None,
        logger: logging.Logger,
        high_water_mark_bytes: int = _OUTPUT_HIGH_WATER_MARK_BYTES,
        control_reserve_bytes: int | None = None,
    ) -> None:
        self._write_message = write_message
        self._write_frame_body = write_frame_body
        self._logger = logger
        self._high_water_mark_bytes = max(int(high_water_mark_bytes), 1024)
        requested_reserve = (
            min(_OUTPUT_CONTROL_RESERVE_BYTES, self._high_water_mark_bytes // 4)
            if control_reserve_bytes is None
            else int(control_reserve_bytes)
        )
        self._control_reserve_bytes = min(
            max(requested_reserve, 1),
            max(self._high_water_mark_bytes - 1, 1),
        )
        self._data_high_water_mark_bytes = (
            self._high_water_mark_bytes - self._control_reserve_bytes
        )
        self._soft_water_mark_bytes = max(int(self._data_high_water_mark_bytes * 0.75), 1)
        self._soft_reset_mark_bytes = max(int(self._data_high_water_mark_bytes * 0.50), 0)
        self._control_queue: queue.Queue[_OutboundBatch] = queue.Queue()
        self._data_queue: queue.Queue[_OutboundBatch] = queue.Queue()
        self._buffered_bytes = 0
        self._buffered_frames = 0
        self._lane_buffered_bytes = {"control": 0, "data": 0, "terminal": 0}
        self._soft_warning_active = False
        self._buffer_lock = threading.Lock()
        self._closed = False
        self._write_error: BaseException | None = None
        self._thread = threading.Thread(
            target=self._pump,
            name="sidecar-stdout-writer",
            daemon=True,
        )
        self._thread.start()

    def enqueue(self, message: dict[str, Any], *, control: bool) -> None:
        self.enqueue_batch([message], lane="control" if control else "data")

    def enqueue_batch(self, messages: list[dict[str, Any]], *, lane: str) -> None:
        """Admit an immutable frame batch under one lane-budget decision."""

        if lane not in {"control", "data", "terminal"}:
            raise ValueError(f"unsupported outbound lane: {lane}")
        frames = tuple(
            _OutboundFrame(
                body=encode_framed_body(message),
                message=None if self._write_frame_body is not None else message,
                lane=lane,
            )
            for message in messages
        )
        if not frames:
            return
        # Measure the UTF-8 wire-body size so escaped CJK/emoji expansion cannot
        # trigger premature backpressure.
        encoded_size = sum(frame.encoded_size for frame in frames)
        target_queue = self._control_queue if lane == "control" else self._data_queue
        lane_limit = (
            self._high_water_mark_bytes
            if lane in ("control", "terminal")
            else self._data_high_water_mark_bytes
        )
        with self._buffer_lock:
            if self._write_error is not None:
                raise self._write_error
            if self._closed:
                raise EOFError("sidecar output writer closed")
            next_size = self._buffered_bytes + encoded_size
            if (
                lane == "data"
                and
                next_size >= self._soft_water_mark_bytes
                and not self._soft_warning_active
            ):
                self._emit_soft_backpressure_warning_locked(encoded_size, next_size)
            if next_size > lane_limit:
                error = TransportBackpressureError(
                    "sidecar transport_backpressure: outbound frame queue "
                    f"exceeded the {lane} lane high-water mark"
                )
                self._logger.warning(
                    "sidecar transport backpressure detected",
                    extra={
                        "event": "sidecar.runtime.transport_backpressure",
                        "buffered_bytes": self._buffered_bytes,
                        "next_frame_bytes": encoded_size,
                        "high_water_mark_bytes": lane_limit,
                        "lane": lane,
                        "control_reserve_bytes": self._control_reserve_bytes,
                    },
                )
                raise error
            self._buffered_bytes = next_size
            self._buffered_frames += len(frames)
            self._lane_buffered_bytes[lane] += encoded_size
            target_queue.put(_OutboundBatch(frames=frames, encoded_size=encoded_size))

    def _emit_soft_backpressure_warning_locked(
        self,
        encoded_size: int,
        next_size: int,
    ) -> None:
        self._soft_warning_active = True
        log_event(
            self._logger,
            logging.WARNING,
            component="runtime.transport",
            event="sidecar.runtime.transport_backpressure_soft_warning",
            message="sidecar transport queue is nearing the high-water mark",
            status="warn",
            data={
                "buffered_bytes": next_size,
                "next_frame_bytes": encoded_size,
                "soft_water_mark_bytes": self._soft_water_mark_bytes,
                "high_water_mark_bytes": self._high_water_mark_bytes,
            },
            buffered_bytes=next_size,
            next_frame_bytes=encoded_size,
            soft_water_mark_bytes=self._soft_water_mark_bytes,
            high_water_mark_bytes=self._high_water_mark_bytes,
        )

    def stats(self) -> dict[str, int]:
        """Snapshot queue/budget state for backpressure diagnostics."""
        with self._buffer_lock:
            return {
                "buffered_bytes": self._buffered_bytes,
                "high_water_mark_bytes": self._high_water_mark_bytes,
                "data_high_water_mark_bytes": self._data_high_water_mark_bytes,
                "control_reserve_bytes": self._control_reserve_bytes,
                "data_buffered_bytes": self._lane_buffered_bytes["data"],
                "control_buffered_bytes": self._lane_buffered_bytes["control"],
                "terminal_buffered_bytes": self._lane_buffered_bytes["terminal"],
                "pending_frames": self._buffered_frames,
                "control_queue_size": self._control_queue.qsize(),
                "data_queue_size": self._data_queue.qsize(),
            }

    def close(self, join_timeout_seconds: float = 1.0) -> WriterDrainResult:
        with self._buffer_lock:
            self._closed = True
        if self._thread.is_alive():
            self._thread.join(timeout=max(0.0, join_timeout_seconds))
        with self._buffer_lock:
            worker_alive = self._thread.is_alive()
            write_error_type = (
                type(self._write_error).__name__ if self._write_error is not None else None
            )
            return WriterDrainResult(
                drained=(
                    not worker_alive
                    and self._buffered_frames == 0
                    and self._write_error is None
                ),
                pending_frames=self._buffered_frames,
                pending_bytes=self._buffered_bytes,
                worker_alive=worker_alive,
                write_error_type=write_error_type,
            )

    def _pump(self) -> None:
        while True:
            batch: _OutboundBatch | None = None
            try:
                batch = self._control_queue.get_nowait()
            except queue.Empty:
                pass
            if batch is None:
                with self._buffer_lock:
                    if self._closed and self._data_queue.empty() and self._control_queue.empty():
                        return
                try:
                    batch = self._data_queue.get(timeout=_OUTPUT_QUEUE_GET_TIMEOUT_SECONDS)
                except queue.Empty:
                    continue
            for index, frame in enumerate(batch.frames):
                try:
                    if self._write_frame_body is not None:
                        self._write_frame_body(frame.body)
                    elif frame.message is not None:
                        self._write_message(frame.message)
                except BaseException as error:  # noqa: BLE001
                    self._logger.exception("sidecar output writer failed")
                    remaining_frames = batch.frames[index:]
                    with self._buffer_lock:
                        self._write_error = error
                        self._closed = True
                        self._release_frames_locked(remaining_frames)
                    abandoned_count, abandoned_bytes = self._drain_pending_items()
                    self._logger.warning(
                        "Abandoned buffered sidecar output after writer failure",
                        extra={
                            "event": "sidecar.runtime.transport.write_abandoned",
                            "abandoned_count": len(remaining_frames) + abandoned_count,
                            "abandoned_bytes": (
                                sum(item.encoded_size for item in remaining_frames)
                                + abandoned_bytes
                            ),
                        },
                    )
                    return
                with self._buffer_lock:
                    self._release_frames_locked((frame,))
                    if self._lane_buffered_bytes["data"] <= self._soft_reset_mark_bytes:
                        self._soft_warning_active = False

    def _release_frames_locked(self, frames: tuple[_OutboundFrame, ...]) -> None:
        released_bytes = sum(frame.encoded_size for frame in frames)
        self._buffered_bytes = max(self._buffered_bytes - released_bytes, 0)
        self._buffered_frames = max(self._buffered_frames - len(frames), 0)
        for frame in frames:
            self._lane_buffered_bytes[frame.lane] = max(
                self._lane_buffered_bytes[frame.lane] - frame.encoded_size,
                0,
            )

    def _drain_pending_items(self) -> tuple[int, int]:
        abandoned_count = 0
        abandoned_bytes = 0
        for target_queue in (self._control_queue, self._data_queue):
            while True:
                try:
                    batch = target_queue.get_nowait()
                except queue.Empty:
                    break
                abandoned_count += len(batch.frames)
                abandoned_bytes += batch.encoded_size
                with self._buffer_lock:
                    self._release_frames_locked(batch.frames)
        return abandoned_count, abandoned_bytes


class StdioTransportMultiplexer:
    """Route approval responses and cancel control frames over one stdio pipe."""

    def __init__(
        self,
        *,
        reader: Callable[[], dict[str, Any]],
        write_message: Callable[[dict[str, Any]], None],
        write_frame_body: Callable[[bytes], None] | None = None,
        logger: logging.Logger,
        cancel_tombstone_ttl_seconds: float = _DEFAULT_CANCEL_TOMBSTONE_TTL_SECONDS,
        max_active_turns: int = DEFAULT_MAX_ACTIVE_TURNS,
        max_cancel_tombstones: int = DEFAULT_MAX_CANCEL_TOMBSTONES,
        message_reader_cls: type[BackgroundMessageReader] = BackgroundMessageReader,
        high_water_mark_bytes: int = _OUTPUT_HIGH_WATER_MARK_BYTES,
        control_reserve_bytes: int | None = None,
    ) -> None:
        self._logger = logger
        self._message_reader = message_reader_cls(reader)
        self._writer = PrioritizedMessageWriter(
            write_message=write_message,
            write_frame_body=write_frame_body,
            logger=logger,
            high_water_mark_bytes=high_water_mark_bytes,
            control_reserve_bytes=control_reserve_bytes,
        )
        self._approval_waiters: dict[int, queue.Queue[dict[str, Any]]] = {}
        self._active_turns: dict[str, TurnCancellationHandle] = {}
        self._active_turns_by_session: dict[str, TurnCancellationHandle] = {}
        self._cancel_tombstones: dict[str, tuple[float, str]] = {}
        self._lock = threading.Lock()
        self._cancel_tombstone_ttl_seconds = max(cancel_tombstone_ttl_seconds, 0.1)
        self._max_active_turns = max(int(max_active_turns), 1)
        self._max_cancel_tombstones = max(int(max_cancel_tombstones), 1)
        # Control-frame counters are written by multiple per-turn worker threads
        # and therefore share self._lock.
        self._control_frames_sent = 0
        self._control_frames_rejected = 0

    def read_request(self, timeout_seconds: float | None = None) -> dict[str, Any]:
        while True:
            message = self._message_reader.read(timeout_seconds)
            try:
                envelope = validate_jsonrpc_envelope(message)
            except JsonRpcEnvelopeError as error:
                self._logger.warning(
                    "Rejected invalid inbound JSON-RPC envelope",
                    extra={
                        "event": "sidecar.runtime.transport.invalid_envelope",
                        "reason": error.reason,
                        "has_id": "id" in message,
                    },
                )
                if error.should_respond:
                    try:
                        self.send_control(error.response())
                    except TransportBackpressureError as backpressure_error:
                        self._log_control_frame_rejected(
                            method=None,
                            request_id=None,
                            message_id=message.get("id") if isinstance(message, dict) else None,
                            error=backpressure_error,
                        )
                continue
            routed = self._route_incoming(envelope)
            if routed is not None:
                return routed

    def send_control(self, message: dict[str, Any]) -> None:
        self._writer.enqueue(message, control=True)
        with self._lock:
            self._control_frames_sent += 1

    def _log_control_frame_rejected(
        self,
        *,
        method: str | None,
        request_id: str | None,
        message_id: Any,
        error: TransportBackpressureError,
    ) -> None:
        # Control acknowledgements absorb backpressure locally so a dropped
        # acknowledgement cannot propagate through read_request and terminate
        # the main loop.
        with self._lock:
            self._control_frames_rejected += 1
            control_lane_stats = {
                "control_frames_sent": self._control_frames_sent,
                "control_frames_rejected": self._control_frames_rejected,
            }
        self._logger.warning(
            "Dropped control-lane frame after transport backpressure",
            extra={
                "event": "sidecar.runtime.transport.control_frame_rejected",
                "method": method,
                "request_id": request_id,
                "message_id": message_id,
                "error": str(error),
                **control_lane_stats,
                **self._writer.stats(),
            },
        )

    def send_data(self, message: dict[str, Any]) -> None:
        self._writer.enqueue(message, control=False)

    def send_terminal_result(
        self,
        notifications: list[dict[str, Any]],
        response: dict[str, Any] | None,
    ) -> None:
        """Send final turn notifications before the resolving response.

        The response intentionally uses the data lane here.  A terminal
        response resolves the Electron request and causes its notification
        handler to be removed, so final chat.token/chat.done notifications
        must not sit behind it in the lower-priority data queue.
        """
        bundle = [*notifications]
        if response is not None:
            bundle.append(response)
        self._writer.enqueue_batch(bundle, lane="terminal")

    def has_active_session_turn(self, session_id: str | None) -> bool:
        """True when a live chat.send turn is registered for this session.

        JCA-004 active-session guard: manual chat.compact must not run while
        the session's turn is still mutating history — the summary would be
        computed from a snapshot the live turn is about to invalidate.
        """
        normalized = str(session_id or "").strip()
        if not normalized:
            return False
        with self._lock:
            return normalized in self._active_turns_by_session

    def register_turn(
        self,
        *,
        request_id: str,
        trace_id: str | None,
        session_id: str | None,
        generation: int | None = None,
        approval_mode: str = "prompt",
        read_only: bool = False,
    ) -> TurnCancellationHandle:
        normalized_request_id = str(request_id or "").strip()
        normalized_session_id = str(session_id or "").strip() or None
        normalized_generation = (
            generation if isinstance(generation, int) and not isinstance(generation, bool)
            and generation > 0 else None
        )
        handle = TurnCancellationHandle(
            request_id=normalized_request_id,
            trace_id=trace_id,
            session_id=normalized_session_id,
            generation=normalized_generation,
            live_run_mode=LiveRunModeState(
                approval_mode="auto_run" if approval_mode == "auto_run" else "prompt",
                read_only=read_only is True,
            ),
        )
        superseded: TurnCancellationHandle | None = None
        with self._lock:
            self._prune_cancel_tombstones_locked()
            existing = self._active_turns.get(normalized_request_id)
            if existing is not None:
                self._logger.warning(
                    "Rejected duplicate active chat.send request_id",
                    extra={
                        "event": "sidecar.runtime.duplicate_request_id",
                        "request_id": normalized_request_id,
                        "trace_id": trace_id,
                        "session_id": session_id,
                        "existing_trace_id": existing.trace_id,
                        "existing_session_id": existing.session_id,
                    },
                )
                raise DuplicateRequestIdError(
                    f"active request_id already registered: {normalized_request_id}"
                )
            existing_session_turn = (
                self._active_turns_by_session.get(normalized_session_id)
                if normalized_session_id is not None
                else None
            )
            if existing_session_turn is not None:
                existing_generation = existing_session_turn.generation
                if (
                    normalized_generation is None
                    or existing_generation is None
                    or normalized_generation <= existing_generation
                ):
                    self._logger.warning(
                        "Rejected concurrent chat.send for one session",
                        extra={
                            "event": "sidecar.runtime.duplicate_session_turn",
                            "request_id": normalized_request_id,
                            "session_id": normalized_session_id,
                            "generation": normalized_generation,
                            "existing_request_id": existing_session_turn.request_id,
                            "existing_generation": existing_generation,
                        },
                    )
                    raise DuplicateSessionTurnError(
                        f"session already has an active turn: {normalized_session_id}"
                    )
                superseded = existing_session_turn
            if len(self._active_turns) >= self._max_active_turns:
                self._logger.warning(
                    "Rejected chat.send registration because active-turn cap is reached",
                    extra={
                        "event": "sidecar.runtime.active_turn_limit_exceeded",
                        "request_id": normalized_request_id,
                        "trace_id": trace_id,
                        "session_id": session_id,
                        "active_turn_count": len(self._active_turns),
                        "max_active_turns": self._max_active_turns,
                    },
                )
                raise ActiveTurnLimitExceededError("too many active chat.send turns")
            self._active_turns[normalized_request_id] = handle
            if normalized_session_id is not None:
                self._active_turns_by_session[normalized_session_id] = handle
            tombstone_hit = normalized_request_id in self._cancel_tombstones
            tombstone_reason = "sidecar_cancel"
            if tombstone_hit:
                _expires_at, tombstone_reason = self._cancel_tombstones.pop(
                    normalized_request_id,
                    (0.0, "sidecar_cancel"),
                )
        if superseded is not None:
            superseded.cancel(reason="preempted")
        if tombstone_hit:
            self._logger.info(
                "Replaying cancel tombstone for chat.send registration",
                extra={
                    "event": "sidecar.runtime.cancel_tombstone_hit",
                    "request_id": normalized_request_id,
                    "trace_id": trace_id,
                    "session_id": session_id,
                    "tombstone_hit": True,
                },
            )
            handle.cancel(reason=tombstone_reason)
        return handle

    def unregister_turn(
        self,
        request_id: str,
        *,
        expected_handle: TurnCancellationHandle | None = None,
    ) -> None:
        with self._lock:
            normalized_request_id = str(request_id or "").strip()
            current = self._active_turns.get(normalized_request_id)
            if expected_handle is not None and current is not expected_handle:
                return
            removed = self._active_turns.pop(normalized_request_id, None)
            normalized_session_id = str(getattr(removed, "session_id", "") or "").strip()
            if (
                normalized_session_id
                and self._active_turns_by_session.get(normalized_session_id) is removed
            ):
                self._active_turns_by_session.pop(normalized_session_id, None)

    def approval_reader_factory(
        self,
        approval_id: int,
        *,
        cancel_handle: TurnCancellationHandle | None = None,
    ) -> Callable[[float], dict[str, Any]]:
        wait_queue: queue.Queue[dict[str, Any]] = queue.Queue()
        with self._lock:
            self._approval_waiters[approval_id] = wait_queue

        def _read(timeout_seconds: float) -> dict[str, Any]:
            deadline = time.monotonic() + max(float(timeout_seconds or 0.0), 0.0)
            while True:
                if cancel_handle is not None and cancel_handle.cancelled:
                    self.clear_approval_waiter(approval_id)
                    raise ApprovalResponseCancelledError("approval wait cancelled")
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    self.clear_approval_waiter(approval_id)
                    raise TimeoutError("timed out waiting for approval response")
                try:
                    message = wait_queue.get(timeout=min(0.05, remaining))
                    self.clear_approval_waiter(approval_id)
                    return message
                except queue.Empty:
                    continue

        _read.close = lambda: self.clear_approval_waiter(approval_id)  # type: ignore[attr-defined]
        return _read

    def clear_approval_waiter(self, approval_id: int) -> None:
        with self._lock:
            self._approval_waiters.pop(int(approval_id), None)

    def close(self, timeout_seconds: float = 1.0) -> TransportDrainResult:
        deadline = time.monotonic() + max(float(timeout_seconds), 0.0)
        reader_result = self._message_reader.close(
            join_timeout_seconds=max(deadline - time.monotonic(), 0.0)
        )
        writer_result = self._writer.close(
            join_timeout_seconds=max(deadline - time.monotonic(), 0.0)
        )
        result = TransportDrainResult(
            drained=reader_result.drained and writer_result.drained,
            reader=reader_result,
            writer=writer_result,
        )
        if not result.drained:
            self._logger.warning(
                "Sidecar transport closed without draining all workers and frames",
                extra={
                    "event": "sidecar.runtime.transport.shutdown_undrained",
                    "reader_worker_alive": reader_result.worker_alive,
                    "pending_frames": writer_result.pending_frames,
                    "pending_bytes": writer_result.pending_bytes,
                    "writer_worker_alive": writer_result.worker_alive,
                    "write_error_type": writer_result.write_error_type,
                },
            )
        return result

    def _route_incoming(self, envelope: JsonRpcEnvelope) -> dict[str, Any] | None:
        message = envelope.payload
        method = envelope.method or ""
        if method == CHAT_CANCEL_METHOD:
            version_error = validate_method_version(
                method=method,
                message_id=envelope.message_id,
                params=envelope.params,
                invalid_params_code=_INVALID_PARAMS_CODE,
                version_mismatch_code=CMP_PROTO_VERSION_MISMATCH,
            )
            if version_error is not None:
                self._logger.warning(
                    "Rejected chat.cancel with incompatible API version",
                    extra={
                        "event": "sidecar.runtime.chat_cancel.version_rejected",
                        "has_id": envelope.message_id is not None,
                    },
                )
                if envelope.message_id is not None:
                    try:
                        self.send_control(version_error)
                    except TransportBackpressureError as backpressure_error:
                        self._log_control_frame_rejected(
                            method=method,
                            request_id=None,
                            message_id=envelope.message_id,
                            error=backpressure_error,
                        )
                return None
            self._handle_cancel_request(message)
            return None
        if method == ENGINE_ACTIVITY_METHOD:
            # Fire-and-forget liveness stamp from the shell's managed-engine
            # stderr capture; never dispatched, never answered (throttled
            # shell-side, so no per-message logging here either).
            record_engine_activity()
            return None
        if method == SESSION_RUN_MODE_UPDATED_METHOD:
            self._handle_run_mode_updated(envelope.params)
            return None
        if envelope.kind == "response":
            if self._route_approval_response(message):
                return None
        return message

    def _handle_run_mode_updated(self, params: dict[str, Any]) -> None:
        session_id = str(params.get("session_id") or "").strip()
        approval_mode = params.get("approval_mode")
        read_only = params.get("read_only")
        if (
            not session_id
            or approval_mode not in {"prompt", "auto_run"}
            or not isinstance(read_only, bool)
        ):
            self._logger.warning(
                "Ignored malformed live run-mode update",
                extra={"event": "sidecar.runtime.run_mode_update.invalid"},
            )
            return
        with self._lock:
            handle = self._active_turns_by_session.get(session_id)
        if handle is None:
            return
        handle.live_run_mode.update(
            approval_mode=approval_mode,
            read_only=read_only,
        )

    def _route_approval_response(self, message: dict[str, Any]) -> bool:
        raw_id = message.get("id")
        approval_id = raw_id if isinstance(raw_id, int) and not isinstance(raw_id, bool) else -1
        waiter: queue.Queue[dict[str, Any]] | None = None
        with self._lock:
            waiter = self._approval_waiters.get(approval_id)
        if waiter is not None:
            waiter.put(message)
            return True
        self._logger.warning(
            "Ignoring unmatched inbound response frame",
            extra={
                "event": "sidecar.runtime.transport.unmatched_response",
                "approval_id": approval_id if approval_id >= 0 else None,
                "incoming_method": "",
                "incoming_id": message.get("id"),
            },
        )
        return True

    def _handle_cancel_request(self, message: dict[str, Any]) -> None:
        params = message.get("params")
        params = params if isinstance(params, dict) else {}
        request_id = str(params.get("request_id") or "").strip()
        trace_id = str(params.get("trace_id") or "").strip() or None
        session_id = str(params.get("session_id") or "").strip() or None
        cancel_reason = _normalize_cancel_reason(params.get("cancel_reason"))
        status = "ignored"
        tombstone_hit = False
        if request_id:
            with self._lock:
                self._prune_cancel_tombstones_locked()
                handle = self._active_turns.get(request_id)
                if handle is not None:
                    handle.cancel(reason=cancel_reason)
                    status = "cancel_requested"
                else:
                    tombstone_hit = request_id in self._cancel_tombstones
                    self._cancel_tombstones[request_id] = (
                        time.monotonic() + self._cancel_tombstone_ttl_seconds,
                        cancel_reason,
                    )
                    self._enforce_cancel_tombstone_cap_locked()
                    status = "cancel_queued"
        self._logger.info(
            "Processed chat.cancel request",
            extra={
                "event": "sidecar.runtime.chat_cancel",
                "request_id": request_id,
                "trace_id": trace_id,
                "session_id": session_id,
                "cancel_reason": cancel_reason,
                "tombstone_hit": tombstone_hit,
                "status": status,
            },
        )
        if message.get("id") is not None:
            # The cancellation itself (handle.cancel(...) / tombstone write,
            # above) has already been applied by this point -- it does not
            # depend on the ack below landing on the wire.
            try:
                self.send_control(
                    result_response(
                        message.get("id"),
                        {
                            "request_id": request_id,
                            "status": status,
                            "cancel_reason": cancel_reason,
                            "tombstone_hit": tombstone_hit,
                        },
                    )
                )
            except TransportBackpressureError as error:
                self._log_control_frame_rejected(
                    method=CHAT_CANCEL_METHOD,
                    request_id=request_id,
                    message_id=message.get("id"),
                    error=error,
                )

    def _prune_cancel_tombstones_locked(self) -> None:
        now = time.monotonic()
        expired = [
            request_id
            for request_id, (expires_at, _reason) in self._cancel_tombstones.items()
            if expires_at <= now
        ]
        for request_id in expired:
            self._cancel_tombstones.pop(request_id, None)

    def _enforce_cancel_tombstone_cap_locked(self) -> None:
        while len(self._cancel_tombstones) > self._max_cancel_tombstones:
            evicted_request_id = next(iter(self._cancel_tombstones))
            self._cancel_tombstones.pop(evicted_request_id, None)
            self._logger.warning(
                "Evicted oldest cancel tombstone after cap was reached",
                extra={
                    "event": "sidecar.runtime.cancel_tombstone_evicted",
                    "evicted_request_id": evicted_request_id,
                    "max_cancel_tombstones": self._max_cancel_tombstones,
                    "remaining_tombstones": len(self._cancel_tombstones),
                },
            )
