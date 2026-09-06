"""Streamed tool-call generation extracted from the generation-runtime hub.

Owns ``stream_generate_with_tools`` and its exclusive stream-reader helper
cluster. Hub-defined and monkeypatched dependencies are resolved late-bound
through ``sidecar.ai.routing.generation_runtime`` so the test suite's patches
on the hub module object keep working.
"""

from __future__ import annotations

import logging
import queue
import threading
import time
from contextvars import copy_context
from dataclasses import dataclass
from typing import Any

from sidecar.ai import engine_liveness as _engine_liveness
from sidecar.ai import error_codes as _error_codes
from sidecar.ai import feature_flags as _feature_flags
from sidecar.ai import thinking_guard as _thinking_guard
from sidecar.ai.engines import engine_events as _engine_events
from sidecar.ai.routing import loop_events as _loop_events
from sidecar.ai.routing import tool_call_canonicalization as _tool_call_canonicalization
from sidecar.ai.routing import tool_observation as _tool_observation
from sidecar.ai.thinking_guard import (
    resolve_thinking_budget_chars,
    thinking_budget_abort_enabled,
)
from sidecar.ai.tools import models as _tool_models
from sidecar.ai.tools import sanitization as _tool_sanitization
from sidecar.protocol import CHAT_THINKING_KIND_REASONING, CHAT_THINKING_KIND_STATUS
from sidecar.runtime.local_engine.request_context import (
    current_app_profile_behavior,
    current_diagnostics_store,
)

# Emit under the generation-runtime hub's logger name (not this module's) so
# the streamed-generation log records keep their pre-split logger identity —
# ``caplog.at_level(logger="sidecar.ai.routing.generation_runtime")`` in the
# test suite gates the guard-trip/sampler INFO records on exactly that name.
logger = logging.getLogger("sidecar.ai.routing.generation_runtime")

CMP_LOOP_ENGINE_STALLED = _error_codes.CMP_LOOP_ENGINE_STALLED
CMP_LOOP_GENERATION_FAILED = _error_codes.CMP_LOOP_GENERATION_FAILED
CMP_LOOP_INVALID_TOOL_CALL = _error_codes.CMP_LOOP_INVALID_TOOL_CALL
CMP_RESOURCE_EXCEEDED = _error_codes.CMP_RESOURCE_EXCEEDED
CMP_STREAM_REASONING_ONLY = _error_codes.CMP_STREAM_REASONING_ONLY
FEATURE_PHASE_EVENTS = _feature_flags.FEATURE_PHASE_EVENTS
is_feature_flag_enabled = _feature_flags.is_feature_flag_enabled
EngineEvent = _engine_events.EngineEvent
ENGINE_EVENT_DONE = _engine_events.ENGINE_EVENT_DONE
ENGINE_EVENT_FAILED = _engine_events.ENGINE_EVENT_FAILED
ENGINE_EVENT_REASONING_DELTA = _engine_events.ENGINE_EVENT_REASONING_DELTA
ENGINE_EVENT_TEXT_DELTA = _engine_events.ENGINE_EVENT_TEXT_DELTA
ENGINE_EVENT_TOOL_CALL_BOUNDARY = _engine_events.ENGINE_EVENT_TOOL_CALL_BOUNDARY
ENGINE_EVENT_TOOL_CALL_COMPLETED = _engine_events.ENGINE_EVENT_TOOL_CALL_COMPLETED
ENGINE_EVENT_TOOL_CALL_DELTA = _engine_events.ENGINE_EVENT_TOOL_CALL_DELTA
ThinkingRepetitionGuard = _thinking_guard.ThinkingRepetitionGuard
KIND_MODEL_REASONING_DELTA = _tool_observation.KIND_MODEL_REASONING_DELTA
KIND_MODEL_VISIBLE_TEXT_DELTA = _tool_observation.KIND_MODEL_VISIBLE_TEXT_DELTA
ThinkingEvent = _loop_events.ThinkingEvent
TokenDeltaEvent = _loop_events.TokenDeltaEvent
PhaseStartedEvent = _loop_events.PhaseStartedEvent
PhaseCompletedEvent = _loop_events.PhaseCompletedEvent
GenerationResult = _tool_models.GenerationResult
StreamChunk = _tool_models.StreamChunk
StreamingEvent = _tool_models.StreamingEvent
ThinkingDelta = _tool_models.ThinkingDelta
ToolCallRequest = _tool_models.ToolCallRequest
_POST_RESPONSE_ANALYSIS_RE = _tool_sanitization._POST_RESPONSE_ANALYSIS_RE
drop_special_tokens = _tool_sanitization.drop_special_tokens
has_control_tokens = _tool_sanitization.has_control_tokens
strip_visible_thought_sentinels = _tool_sanitization.strip_visible_thought_sentinels

_STREAM_READER_QUEUE_MAXSIZE = 32
_STREAM_READER_SHUTDOWN_GRACE_SECONDS = 0.5
_STREAM_CANCEL_POLL_SECONDS = 0.1
_STREAM_READER_CAP = 16

# Process-wide reader ownership. A wedged provider iterator retains its slot
# until its daemon reader actually exits, so sequential stalls cannot grow
# threads or engine-liveness generations without bound.
@dataclass
class _ZombieReaderStats:
    total: int = 0


_zombie_reader_count_lock = threading.Lock()
_zombie_reader_stats = _ZombieReaderStats()
_quarantined_reader_names: set[str] = set()
_live_stream_reader_count = 0


class _StreamReaderCapacityExceeded(RuntimeError):
    pass


def zombie_reader_count() -> int:
    """Return the running total of stream-reader cleanup timeouts."""
    with _zombie_reader_count_lock:
        return _zombie_reader_stats.total


def quarantined_reader_count() -> int:
    """Return readers still alive after their owner stopped awaiting them."""
    with _zombie_reader_count_lock:
        return len(_quarantined_reader_names)


def live_stream_reader_count() -> int:
    with _zombie_reader_count_lock:
        return _live_stream_reader_count


def _reserve_stream_reader_slot() -> bool:
    global _live_stream_reader_count  # noqa: PLW0603
    with _zombie_reader_count_lock:
        if _live_stream_reader_count >= _STREAM_READER_CAP:
            return False
        _live_stream_reader_count += 1
        return True


def _release_stream_reader_slot() -> None:
    global _live_stream_reader_count  # noqa: PLW0603
    with _zombie_reader_count_lock:
        _live_stream_reader_count = max(0, _live_stream_reader_count - 1)


def _reset_zombie_reader_count_for_tests() -> None:
    """Test-only: reset the zombie-reader counter for isolated assertions."""
    with _zombie_reader_count_lock:
        _zombie_reader_stats.total = 0
        _quarantined_reader_names.clear()

# Engine-liveness deferral (2026-07-11 RCA): Ollama buffers a tool call until
# it is fully parsed, so a model composing a multi-thousand-token write_file
# streams NOTHING for minutes while decoding healthily — the fixed silence
# window alone killed such a turn 3 seconds before its tool call completed.
# When the window expires but the shell's managed-engine capture stamped the
# liveness clock recently (sidecar/ai/engine_liveness.py), the watchdog defers
# the stall verdict and re-checks on a short interval; an absolute silence
# ceiling still bounds a pathological run (e.g. runaway decode that never
# yields a chunk). Deliberately constants, not config: the user-tunable knob
# stays ``chunk_inactivity_seconds`` — these are safety internals, and adding
# config fields would re-open the un-threaded-flag bug class across the four
# LoopRuntime construction sites.
_ENGINE_ACTIVITY_FRESH_SECONDS = 30.0
_ENGINE_LIVENESS_RECHECK_SECONDS = 30.0
_ENGINE_SILENCE_CEILING_SECONDS = 1800.0


@dataclass(frozen=True)
class _StreamTerminal:
    result: Any


@dataclass(frozen=True)
class _StreamFailure:
    error: BaseException


class _StreamReader:
    def __init__(self, stream: Any) -> None:
        self.queue: queue.Queue[StreamChunk | _StreamTerminal | _StreamFailure] = queue.Queue(
            maxsize=_STREAM_READER_QUEUE_MAXSIZE
        )
        self._stream = stream
        self._stop = threading.Event()
        # A reader's lifetime IS a generation's flight time, so it carries the
        # engine-liveness generation accounting (the deferral is only sound
        # when a single generation can claim the process-wide activity clock).
        # Accounting ends exactly once, on worker exit. A close request may leave
        # next(stream) wedged; retaining that generation prevents its engine
        # telemetry from being attributed to a later turn.
        self._generation_ended = False
        self._quarantine_recorded = False
        self._generation_lock = threading.Lock()
        worker_context = copy_context()
        _engine_liveness.begin_generation()
        self.thread = threading.Thread(
            target=worker_context.run,
            args=(self._worker,),
            name="router-stream-reader",
            daemon=True,
        )
        try:
            self.thread.start()
        except BaseException:
            self._end_generation_once()
            raise

    def _end_generation_once(self) -> None:
        with self._generation_lock:
            if self._generation_ended:
                return
            self._generation_ended = True
        _engine_liveness.end_generation()

    def _put(self, item: StreamChunk | _StreamTerminal | _StreamFailure) -> None:
        while not self._stop.is_set():
            try:
                self.queue.put(item, timeout=0.05)
                return
            except queue.Full:
                continue

    def _worker(self) -> None:
        try:
            while not self._stop.is_set():
                try:
                    chunk = next(self._stream)
                except StopIteration as stop:
                    self._put(_StreamTerminal(result=stop.value))
                    return
                if self._stop.is_set():
                    return
                self._put(chunk)
        except BaseException as error:  # noqa: BLE001
            if not self._stop.is_set():
                self._put(_StreamFailure(error=error))
        finally:
            quarantine_name = _reader_quarantine_name(threading.current_thread())
            with _zombie_reader_count_lock:
                _quarantined_reader_names.discard(quarantine_name)
            self._end_generation_once()
            _release_stream_reader_slot()

    def mark_quarantined_once(self) -> bool:
        with self._generation_lock:
            if self._quarantine_recorded:
                return False
            self._quarantine_recorded = True
            return True

    def close(self) -> None:
        self._stop.set()
        close = getattr(self._stream, "close", None)
        if callable(close):
            try:
                close()
            except Exception:  # noqa: BLE001 - provider close is best-effort.
                pass

    def join(self, timeout_seconds: float = 1.0) -> None:
        if self.thread.is_alive():
            self.thread.join(timeout=max(0.0, float(timeout_seconds)))


def _spawn_stream_reader(
    stream: Any,
) -> _StreamReader:
    if not _reserve_stream_reader_slot():
        raise _StreamReaderCapacityExceeded("provider stream reader capacity exhausted")
    try:
        return _StreamReader(stream)
    except BaseException:
        _release_stream_reader_slot()
        raise


def _reader_quarantine_name(thread: threading.Thread) -> str:
    return f"{thread.name}:{thread.ident or 'pending'}"


def _close_stream_reader(reader: _StreamReader, *, runtime: Any, reason: str) -> None:
    reader.close()
    reader.join(timeout_seconds=_STREAM_READER_SHUTDOWN_GRACE_SECONDS)
    if reader.thread.is_alive() and reader.mark_quarantined_once():
        quarantine_name = _reader_quarantine_name(reader.thread)
        with _zombie_reader_count_lock:
            _zombie_reader_stats.total += 1
            _quarantined_reader_names.add(quarantine_name)
            zombie_reader_total = _zombie_reader_stats.total
            quarantined_reader_total = len(_quarantined_reader_names)
        if not reader.thread.is_alive():
            with _zombie_reader_count_lock:
                _quarantined_reader_names.discard(quarantine_name)
                quarantined_reader_total = len(_quarantined_reader_names)
        logger.warning(
            "Provider stream reader did not stop within the cleanup grace.",
            extra={
                "event": "generation.stream_reader_cleanup_incomplete",
                "request_id": str(getattr(runtime, "request_id", "") or ""),
                "reason": reason,
                "grace_seconds": _STREAM_READER_SHUTDOWN_GRACE_SECONDS,
                "zombie_reader_count": zombie_reader_total,
                "quarantined_reader_count": quarantined_reader_total,
                "reader_name": quarantine_name,
            },
        )


def stream_generate_with_tools(
    kernel: Any,
    *,
    runtime: Any,
    latest_user_content: str,
    prompt_messages: list[Any],
    max_tokens: int,
    reasoning_effort: str | None,
    prompt_cache_enabled: bool,
    system_prompt: Any,
    tool_schemas: list[dict[str, Any]],
    response_format: Any | None = None,
    event_types_sink: set[str] | None = None,
) -> tuple[GenerationResult, set[str]]:
    import sidecar.ai.routing.generation_runtime as _gr_hub

    emitted_event_types = event_types_sink if event_types_sink is not None else set()
    emitted_event_types.clear()
    content_parts: list[str] = []
    content_text = ""
    thinking_parts: list[str] = []
    token_index = 0
    content_suppressed = False
    iteration = max(int(getattr(runtime, "current_iteration", 0) or 0), 0)
    # Drop the prior iteration's unflushed buffer: if a STOP needed it,
    # ``tool_loop.run_tool_loop`` already drained it before reaching here.
    runtime.last_iteration_unflushed = []
    thinking_id = (
        f"think_{runtime.request_id}_iter{iteration}"
        if iteration > 0
        else f"think_{runtime.request_id}_model"
    )
    phase_events_enabled = is_feature_flag_enabled(
        getattr(kernel._config, "feature_flags", {}) or {},
        FEATURE_PHASE_EVENTS,
    )
    current_phase: dict[str, Any] | None = None
    phase_index = 0
    thinking_budget_chars = resolve_thinking_budget_chars(kernel._engine, max_tokens)
    thinking_guard = ThinkingRepetitionGuard(max_chars=thinking_budget_chars)
    # One-shot phase summary staged by the checkpoint rung for THIS generation
    # only: pop it unconditionally so a generation that never enters a
    # reasoning phase cannot leak it onto a later, unrelated phase.
    pending_phase_summary = getattr(runtime, "next_reasoning_phase_summary", None)
    runtime.next_reasoning_phase_summary = None
    thinking_suppression_logged = False
    thinking_has_content = False
    thinking_budget_aborted = False
    # Cursor into ``content_parts`` so ``flush_content`` is incremental:
    # text arriving on either side of a mid-stream tool boundary surfaces
    # as separate ``chat.token`` notifications without re-emitting deltas
    # already flushed.
    content_flush_cursor = 0

    def transition_phase(
        next_kind: str | None,
        *,
        next_thinking_id: str | None = None,
        summary: str | None = None,
    ) -> None:
        nonlocal current_phase, phase_index
        if not phase_events_enabled:
            return
        if current_phase is not None:
            runtime.emit(
                PhaseCompletedEvent(
                    phase_id=current_phase["phase_id"],
                    phase_kind=current_phase["phase_kind"],
                    iteration=current_phase["iteration"],
                    thinking_id=current_phase.get("thinking_id"),
                    summary=current_phase.get("summary"),
                )
            )
            current_phase = None
        if not next_kind:
            return
        phase_index += 1
        phase_id = (
            f"phase_{next_kind}_{runtime.request_id}_iter{iteration}_{phase_index}"
            if iteration > 0
            else f"phase_{next_kind}_{runtime.request_id}_{phase_index}"
        )
        current_phase = {
            "phase_id": phase_id,
            "phase_kind": next_kind,
            "iteration": iteration,
            "thinking_id": next_thinking_id,
            "summary": summary,
        }
        runtime.emit(
            PhaseStartedEvent(
                phase_id=phase_id,
                phase_kind=next_kind,
                iteration=iteration,
                thinking_id=next_thinking_id,
                summary=summary,
            )
        )

    def buffer_content(delta: str) -> None:
        nonlocal content_suppressed, content_text
        if not delta or content_suppressed:
            return
        if has_control_tokens(delta):
            if content_parts:
                content_suppressed = True
                return
            delta = drop_special_tokens(delta)
            if not delta:
                return
        tentative = content_text + delta
        if _POST_RESPONSE_ANALYSIS_RE.search(tentative):
            content_suppressed = True
            return
        delta = drop_special_tokens(delta)
        if not content_parts:
            delta = strip_visible_thought_sentinels(delta)
        if not delta:
            return
        content_parts.append(delta)
        content_text += delta

    def flush_content() -> None:
        """Emit each not-yet-flushed delta in ``content_parts`` as a token.

        Incremental: tracks a cursor so calling ``flush_content`` twice
        emits only the deltas appended since the prior call.
        """
        nonlocal token_index, content_flush_cursor
        if content_flush_cursor >= len(content_parts):
            return
        if current_phase is None or current_phase.get("phase_kind") != "text":
            transition_phase("text", summary="Writing response")
        while content_flush_cursor < len(content_parts):
            delta = content_parts[content_flush_cursor]
            content_flush_cursor += 1
            if not delta:
                continue
            token_index += 1
            runtime.emit(TokenDeltaEvent(delta=delta, token_index=token_index))
            runtime.audit(KIND_MODEL_VISIBLE_TEXT_DELTA, summary=f"len={len(delta)}")
            emitted_event_types.add("chat.token")

    def record_unflushed_content(reason: str) -> None:
        unflushed_parts = content_parts[content_flush_cursor:]
        if not unflushed_parts:
            return
        # Stash on the runtime so a downstream STOP (semantic stuck-loop guard,
        # wall-clock, budget, cycle) can drain the preamble as ``chat.token``
        # events instead of leaving the user with only the stop-reason stub.
        runtime.last_iteration_unflushed = list(unflushed_parts)
        store = current_diagnostics_store(kernel._engine)
        if store is None or not hasattr(store, "record_buffered_visible_output"):
            return
        store.record_buffered_visible_output(
            request_id=runtime.request_id,
            text="".join(unflushed_parts),
            reason=str(reason or "").strip() or "unknown",
        )

    def emit_thinking(delta: str, *, persist: bool) -> None:
        nonlocal pending_phase_summary, thinking_budget_aborted, thinking_has_content
        nonlocal thinking_suppression_logged
        if (
            phase_events_enabled
            and current_phase is not None
            and current_phase.get("phase_kind") != "reasoning"
        ):
            thinking_has_content = False
        if not delta.strip() and not thinking_has_content:
            return
        if thinking_guard.feed(delta):
            if not thinking_suppression_logged:
                _gr_hub.log_event(
                    logger,
                    logging.INFO,
                    component="ai.router",
                    event="ai.router.thinking_guard_tripped",
                    message="Suppressing tool-loop thinking after guard tripped.",
                    status="degraded",
                    data={
                        "provider": getattr(kernel._config, "engine_type", ""),
                        "model": getattr(kernel._config, "model", ""),
                        "reason": thinking_guard.stop_reason,
                    },
                    request_id=getattr(runtime, "request_id", ""),
                )
                if thinking_guard.stop_reason == "repetition":
                    runtime.emit(
                        ThinkingEvent(
                            thinking_id=thinking_id,
                            delta="Reasoning hidden - repetition detected",
                            kind=CHAT_THINKING_KIND_STATUS,
                            persist=False,
                        )
                    )
                    emitted_event_types.add("chat.thinking")
                thinking_suppression_logged = True
            if thinking_guard.tripped_on_budget() and thinking_budget_abort_enabled():
                thinking_budget_aborted = True
            return
        if current_phase is None or current_phase.get("phase_kind") != "reasoning":
            phase_summary = pending_phase_summary
            pending_phase_summary = None
            transition_phase(
                "reasoning",
                next_thinking_id=thinking_id,
                summary=phase_summary or "Reasoning through the turn",
            )
        runtime.emit(
            ThinkingEvent(
                thinking_id=thinking_id,
                delta=delta,
                kind=CHAT_THINKING_KIND_REASONING,
                persist=persist,
                thinking_budget_chars=thinking_budget_chars,
            )
        )
        runtime.audit(KIND_MODEL_REASONING_DELTA, summary=f"len={len(delta)}")
        emitted_event_types.add("chat.thinking")
        thinking_parts.append(delta)
        thinking_has_content = True

    stream_method = kernel._engine.stream_with_tools
    # One line per generation of the effective sampler inputs. An empty
    # app_profile_behavior means no profile bound for this model/engine pair,
    # so the engine fell back to config defaults - the exact mismatch that is
    # otherwise invisible until a degeneration shows up in llama.cpp logs.
    _gr_hub.log_event(
        logger,
        logging.DEBUG,
        component="ai.generation_runtime",
        event="ai.generation_runtime.sampler_params",
        message="Effective sampler params resolved.",
        status="start",
        data={
            "model": str(getattr(kernel._config, "model", "") or ""),
            "engine_type": str(getattr(kernel._config, "engine_type", "") or ""),
            "config_temperature": kernel._config.temperature,
            "reasoning_effort": reasoning_effort or kernel._config.reasoning_effort or "",
            "app_profile_behavior": current_app_profile_behavior(kernel._engine),
        },
        request_id=getattr(runtime, "request_id", ""),
    )
    stream = stream_method(
        prompt=latest_user_content,
        tools=tool_schemas,
        max_tokens=max_tokens,
        temperature=kernel._config.temperature,
        reasoning_effort=reasoning_effort or kernel._config.reasoning_effort or None,
        prompt_cache_enabled=prompt_cache_enabled,
        system=_gr_hub._system_prompt_for_generation(
            kernel,
            system_prompt,
            prompt_cache_enabled=prompt_cache_enabled,
        ),
        messages=prompt_messages,
        response_format=response_format,
        cancel_handle=getattr(runtime, "cancel_handle", None),
        wall_clock_deadline=getattr(runtime, "wall_clock_deadline", None),
    )
    inactivity_limit = runtime.chunk_inactivity_seconds
    # The wait for the FIRST chunk also covers a model (re)load into VRAM, which
    # on local hardware can legitimately take longer than the between-token
    # inactivity window and emits no output (the engine blocks on the provider's
    # first byte). Govern that first wait by a separate, longer model-load grace
    # so a slow load is not mistaken for an engine stall; once any chunk arrives
    # the model is alive and the unchanged inactivity window governs every
    # subsequent wait. ``max`` keeps the grace from ever being shorter than the
    # inter-token window even if misconfigured below it.
    model_load_grace = max(
        inactivity_limit,
        float(
            getattr(runtime, "model_load_grace_seconds", inactivity_limit)
            or inactivity_limit
        ),
    )
    try:
        stream_reader = _spawn_stream_reader(stream)
    except _StreamReaderCapacityExceeded:
        close_stream = getattr(stream, "close", None)
        if callable(close_stream):
            try:
                close_stream()
            except Exception:  # noqa: BLE001 - provider close is best-effort.
                pass
        reason = "Provider stream reader capacity exhausted"
        logger.warning(
            reason,
            extra={
                "event": "generation.stream_reader_capacity_rejected",
                "request_id": str(getattr(runtime, "request_id", "") or ""),
                "reader_limit": _STREAM_READER_CAP,
                "live_reader_count": live_stream_reader_count(),
                "quarantined_reader_count": quarantined_reader_count(),
            },
        )
        runtime.emit(_loop_events.StopEvent(reason=reason, code=CMP_RESOURCE_EXCEEDED))
        synthetic = "Generation could not start because provider stream capacity is exhausted."
        buffer_content(synthetic)
        flush_content()
        transition_phase(None)
        return GenerationResult(content=synthetic, finish_reason="error"), emitted_event_types
    stream_queue = stream_reader.queue
    received_first_chunk = False
    silence_started = time.monotonic()
    next_watchdog_at = silence_started + model_load_grace
    liveness_deferrals = 0
    while True:
        try:
            runtime.raise_if_interrupted(
                message="turn working-time limit exceeded during provider generation",
            )
        except Exception:
            record_unflushed_content(getattr(runtime.cancel_handle, "reason", "timeout"))
            transition_phase(None)
            _close_stream_reader(stream_reader, runtime=runtime, reason="request_interrupted")
            raise
        base_window = inactivity_limit if received_first_chunk else model_load_grace
        # Once deferring, re-check on the short interval so a subsequently-dead
        # engine is still detected promptly and the ceiling stays accurate.
        current_timeout = (
            _ENGINE_LIVENESS_RECHECK_SECONDS if liveness_deferrals else base_window
        )
        now = time.monotonic()
        wait_timeout = max(0.001, next_watchdog_at - now)
        remaining_deadline = runtime.remaining_wall_clock_seconds(now=now)
        if remaining_deadline is not None:
            wait_timeout = min(wait_timeout, max(0.001, remaining_deadline))
        if getattr(runtime, "cancel_handle", None) is not None:
            wait_timeout = min(wait_timeout, _STREAM_CANCEL_POLL_SECONDS)
        try:
            chunk = stream_queue.get(timeout=wait_timeout)
        except queue.Empty:
            try:
                runtime.raise_if_interrupted(
                    message="turn working-time limit exceeded during provider generation",
                )
            except Exception:
                record_unflushed_content(getattr(runtime.cancel_handle, "reason", "timeout"))
                transition_phase(None)
                _close_stream_reader(
                    stream_reader,
                    runtime=runtime,
                    reason="request_interrupted",
                )
                raise
            now = time.monotonic()
            if now < next_watchdog_at:
                continue
            silent_for = now - silence_started
            engine_age = _engine_liveness.seconds_since_engine_activity()
            if (
                engine_age is not None
                and engine_age <= _ENGINE_ACTIVITY_FRESH_SECONDS
                and silent_for < _ENGINE_SILENCE_CEILING_SECONDS
                # The activity clock is process-wide, so it only ATTRIBUTES to
                # this generation when it is the sole one in flight — with a
                # concurrent generation running (e.g. a background.run worker),
                # a healthy sibling's telemetry must not mask THIS request
                # being wedged. Ambiguity falls back to the fixed window.
                and _engine_liveness.active_generation_count() <= 1
                ):
                liveness_deferrals += 1
                next_watchdog_at = now + _ENGINE_LIVENESS_RECHECK_SECONDS
                if liveness_deferrals == 1 or liveness_deferrals % 8 == 0:
                    logger.info(
                        "Stream silent %.0fs but the managed engine reported "
                        "activity %.1fs ago; deferring the stall verdict "
                        "(deferral %d)",
                        silent_for,
                        engine_age,
                        liveness_deferrals,
                        extra={
                            "event": "generation.stall_deferred_engine_active",
                            "silent_seconds": round(silent_for, 1),
                            "engine_activity_age_seconds": round(engine_age, 1),
                            "deferral_count": liveness_deferrals,
                        },
                    )
                continue
            stall_phase = "inactivity" if received_first_chunk else "model_load"
            if stall_phase == "model_load":
                stall_reason = (
                    f"Model load stalled (no output for {current_timeout:.0f}s "
                    "while loading the model)"
                )
                synthetic = "Generation timed out while loading the model."
            else:
                stall_reason = f"Engine stalled (no output for {current_timeout:.0f}s)"
                synthetic = "Generation timed out due to engine inactivity."
            if liveness_deferrals:
                stall_reason += (
                    f" after {silent_for:.0f}s of silence"
                    f" ({liveness_deferrals} engine-liveness deferrals)"
                )
            # Record the phase so ``tool_loop`` builds a phase-accurate user
            # message; never let a diagnostics write break the turn.
            try:
                runtime.stall_phase = stall_phase
            except Exception:  # noqa: BLE001 - diagnostics are best-effort
                pass
            runtime.emit(
                _loop_events.StopEvent(
                    reason=stall_reason,
                    code=CMP_LOOP_ENGINE_STALLED,
                )
            )
            buffer_content(synthetic)
            flush_content()
            transition_phase(None)
            _close_stream_reader(stream_reader, runtime=runtime, reason="provider_stalled")
            return GenerationResult(
                content=synthetic,
                finish_reason="timeout",
            ), emitted_event_types
        # Any item (delta, tool boundary, terminal, or failure) means the model
        # is alive: every subsequent wait reverts to the inactivity window.
        received_first_chunk = True
        silence_started = time.monotonic()
        next_watchdog_at = silence_started + inactivity_limit
        liveness_deferrals = 0
        try:
            runtime.raise_if_interrupted(
                message="turn working-time limit exceeded during provider generation",
            )
        except Exception:
            record_unflushed_content(getattr(runtime.cancel_handle, "reason", "cancelled"))
            transition_phase(None)
            _close_stream_reader(stream_reader, runtime=runtime, reason="request_interrupted")
            raise
        if isinstance(chunk, _StreamFailure):
            record_unflushed_content("stream_failure")
            _close_stream_reader(stream_reader, runtime=runtime, reason="provider_failure")
            raise chunk.error
        if isinstance(chunk, _StreamTerminal):
            stream_reader.join(timeout_seconds=_STREAM_READER_SHUTDOWN_GRACE_SECONDS)
            if stream_reader.thread.is_alive():
                _close_stream_reader(stream_reader, runtime=runtime, reason="provider_terminal")
            result = _gr_hub._to_generation_result(chunk.result)
            final_thinking = str(result.thinking_text or "").strip()
            if final_thinking and not thinking_parts:
                # No budget-abort break here: this is the provider's clean
                # terminal, so generation is already over and the result may
                # carry tool calls that must dispatch (mirrors the engine
                # guards, which gate their aborts on ``not chunk_done``).
                emit_thinking(final_thinking, persist=True)
            if str(result.content or "") and not content_parts:
                buffer_content(str(result.content))
            if content_parts and not str(result.content or ""):
                result = GenerationResult(
                    content="".join(content_parts).strip(),
                    tool_calls=result.tool_calls,
                    finish_reason=result.finish_reason,
                    usage=result.usage,
                    thinking_text=result.thinking_text,
                    inband_tool_call_parse_failed=(
                        result.inband_tool_call_parse_failed
                    ),
                )
            if thinking_parts and not final_thinking:
                result = GenerationResult(
                    content=result.content,
                    tool_calls=result.tool_calls,
                    finish_reason=result.finish_reason,
                    usage=result.usage,
                    thinking_text="".join(thinking_parts).strip(),
                    inband_tool_call_parse_failed=(
                        result.inband_tool_call_parse_failed
                    ),
                )
            if result.tool_calls:
                canonical_calls, coerced_aliases, coalesced_count = (
                    _tool_call_canonicalization.canonicalize_tool_calls(
                        result.tool_calls
                    )
                )
                if canonical_calls != result.tool_calls:
                    result = GenerationResult(
                        content=result.content,
                        tool_calls=canonical_calls,
                        finish_reason=result.finish_reason,
                        usage=result.usage,
                        thinking_text=result.thinking_text,
                        inband_tool_call_parse_failed=(
                            result.inband_tool_call_parse_failed
                        ),
                    )
                if coerced_aliases or coalesced_count:
                    _gr_hub.log_event(
                        logger,
                        logging.INFO,
                        component="ai.router",
                        event="ai.router.tool_calls_canonicalized",
                        message="Canonicalized model tool calls before dispatch.",
                        status="recovered",
                        data={
                            "aliases": coerced_aliases,
                            "coalesced_count": coalesced_count,
                            "remaining_count": len(result.tool_calls),
                        },
                        request_id=getattr(runtime, "request_id", ""),
                    )
            # Two terminal-shape fail-closed signals: ``finish_reason ==
            # "tool_calls"`` with no parsed tool_calls (the normalizer
            # suppressed them as malformed), and reasoning-only completions
            # (thinking only, no content, no tool). Either short-circuits
            # the visible-text flush.
            finish_reason_lower = str(result.finish_reason or "").strip().lower()
            has_visible = bool(content_parts) or bool(
                str(result.content or "").strip()
            )
            has_tool_calls = bool(result.tool_calls)
            has_thinking = bool(thinking_parts) or bool(final_thinking)
            if finish_reason_lower == "tool_calls" and not has_tool_calls:
                record_unflushed_content("malformed_tool_arguments")
                runtime.emit(
                    _loop_events.StopEvent(
                        reason="tool_call arguments could not be parsed",
                        code=CMP_LOOP_INVALID_TOOL_CALL,
                    )
                )
                transition_phase(None)
                return result, emitted_event_types
            if (
                not has_visible
                and not has_tool_calls
                and has_thinking
                # A reasoning-only shape with a bad stream terminal is surfaced
                # by the tool-loop fence as retryable CMP-STREAM-INCOMPLETE.
                # This non-retryable stop is reserved for clean terminals.
                and finish_reason_lower
                not in ("incomplete", "error", "thinking_budget", "length")
            ):
                runtime.emit(
                    _loop_events.StopEvent(
                        reason=(
                            "Reasoning-only completion (no visible text "
                            "and no tool call)"
                        ),
                        code=CMP_STREAM_REASONING_ONLY,
                    )
                )
                transition_phase(None)
                return result, emitted_event_types
            # Visible text always surfaces as ``chat.token`` before the loop
            # dispatches tool calls, whether it streamed mid-flight or arrived
            # only in the terminal result; the tool loop's stream reset clears
            # the provisional preamble when the loop continues past the tools.
            flush_content()
            transition_phase(None)
            return result, emitted_event_types

        if isinstance(chunk, EngineEvent):
            kind = str(chunk.kind or "").strip().lower()
            if kind == ENGINE_EVENT_TEXT_DELTA:
                buffer_content(str(chunk.text or ""))
                flush_content()
                continue
            if kind == ENGINE_EVENT_REASONING_DELTA:
                emit_thinking(str(chunk.text or ""), persist=bool(chunk.is_complete))
                if thinking_budget_aborted:
                    break
                continue
            if kind == ENGINE_EVENT_TOOL_CALL_BOUNDARY:
                if content_parts:
                    flush_content()
                continue
            if kind == ENGINE_EVENT_TOOL_CALL_DELTA:
                runtime.emit(
                    _loop_events.ToolCallDeltaEvent(
                        call_id=str(chunk.tool_call_id or ""),
                        tool_name=chunk.tool_name,
                        arguments_delta=str(chunk.arguments_delta or ""),
                        sequence=int(chunk.sequence),
                    )
                )
                continue
            if kind == ENGINE_EVENT_TOOL_CALL_COMPLETED:
                runtime.emit(
                    _loop_events.ToolCallCompletedEvent(
                        call_id=str(chunk.tool_call_id or ""),
                        tool_name=str(chunk.tool_name or ""),
                        arguments=dict(chunk.arguments),
                        sequence=int(chunk.sequence),
                    )
                )
                continue
            if kind == ENGINE_EVENT_FAILED:
                runtime.emit(
                    _loop_events.StopEvent(
                        reason=str(chunk.text or "Engine stream failed."),
                        code=CMP_LOOP_GENERATION_FAILED,
                    )
                )
                continue
            if kind == ENGINE_EVENT_DONE:
                continue
            continue

        if isinstance(chunk, ToolCallRequest):
            # Mid-stream tool boundary: flush pre-boundary text so it
            # surfaces before the tool-call signal reaches the loop.
            if content_parts:
                flush_content()
            continue
        if isinstance(chunk, ThinkingDelta):
            emit_thinking(str(chunk.text or ""), persist=chunk.is_complete)
            if thinking_budget_aborted:
                break
            continue
        if isinstance(chunk, StreamingEvent):
            kind = str(chunk.kind or "content").strip().lower()
            if kind == "thinking":
                emit_thinking(str(chunk.text or ""), persist=True)
                if thinking_budget_aborted:
                    break
                continue
            if kind == "content":
                buffer_content(str(chunk.text or ""))
                flush_content()
                continue
            continue
        buffer_content(str(chunk or ""))
        flush_content()

    _close_stream_reader(stream_reader, runtime=runtime, reason="thinking_budget")
    transition_phase(None)
    return GenerationResult(
        content="".join(content_parts).strip(),
        finish_reason="thinking_budget",
        thinking_text="".join(thinking_parts).strip(),
    ), emitted_event_types
