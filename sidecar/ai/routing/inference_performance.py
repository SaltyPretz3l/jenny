"""Consumer-thread coalescing of ephemeral physical-attempt observations."""

from __future__ import annotations

import sys
import time
from dataclasses import replace
from typing import Any, Callable

from sidecar.ai.engines.engine_events import ENGINE_EVENT_INFERENCE_PERFORMANCE, EngineEvent
from sidecar.ai.engines.provider_metrics import TERMINAL_PHASES, InferencePerformance
from sidecar.ai.routing.loop_events import InferencePerformanceEvent
from sidecar.ai.routing.prefill_progress import PrefillStatus

_MAX_RETIRED_ATTEMPTS = 64


class InferencePerformanceStatus:
    """Keep only the latest cumulative reading, with no background producer."""

    def __init__(self, runtime: Any, *, clock: Callable[[], float] = time.monotonic) -> None:
        self.runtime = runtime
        self.clock = clock
        self.latest: InferencePerformance | None = None
        self.pending: InferencePerformance | None = None
        self.next_emit = 0.0
        self.emitted_phase = ""
        self.sequence = -1
        self.closed = False
        self.retired: set[str] = set()

    def accept(self, event: Any) -> bool:
        if not isinstance(event, EngineEvent) or event.kind != ENGINE_EVENT_INFERENCE_PERFORMANCE:
            return False
        try:
            self._accept(event.performance)
        except Exception:  # noqa: BLE001 - optional telemetry never breaks generation.
            pass
        return True

    def _accept(self, sample: InferencePerformance | None) -> None:
        if sample is None or sample.attempt_id in self.retired:
            return
        if self.latest is None or sample.attempt_id != self.latest.attempt_id:
            if sample.phase != "waiting" or len(self.retired) >= _MAX_RETIRED_ATTEMPTS:
                return
            if self.latest is not None:
                self.finish("failed")
                self.retired.add(self.latest.attempt_id)
            self.latest = None
            self.emitted_phase = ""
            self.sequence = -1
            self.closed = False
            self.next_emit = 0.0
        if self.closed or (self.latest and sample.sequence <= self.latest.sequence):
            return
        self.latest = sample
        self.pending = sample
        if sample.phase in TERMINAL_PHASES:
            self.finish(sample.phase)
        elif sample.phase != self.emitted_phase:
            self._emit(sample)
        elif sample.phase == "waiting":
            self.pending = None
        else:
            self.flush()

    def _emit(self, sample: InferencePerformance) -> None:
        self.sequence += 1
        self.pending = None
        self.emitted_phase = sample.phase
        self.next_emit = self.clock() + 0.25
        request = getattr(self.runtime, "request_context", None)
        turn_id = str(
            getattr(self.runtime, "logical_turn_id", None)
            or getattr(request, "logical_turn_id", None)
            or getattr(self.runtime, "request_id", None)
            or ""
        )
        # Hosted does not advertise this protocol; its request gate also strips the opt-in.
        if getattr(request, "inference_performance_enabled", True) is False:
            return
        try:
            self.runtime.emit_safe(
                InferencePerformanceEvent(
                    turn_id=turn_id,
                    observation=replace(sample, sequence=self.sequence),
                )
            )
        except Exception:  # noqa: BLE001 - a failed meter subscriber cannot fail inference.
            pass

    def flush(self, now: float | None = None) -> None:
        if self.pending is not None and (self.clock() if now is None else now) >= self.next_emit:
            self._emit(self.pending)

    def wait_timeout(self, now: float, timeout: float) -> float:
        return min(timeout, max(0.001, self.next_emit - now)) if self.pending else timeout

    def finish(self, phase: str = "finished") -> None:
        if self.latest is None or self.closed:
            return
        self.closed = True
        phase = phase if phase in TERMINAL_PHASES else "failed"
        self._emit(replace(self.latest, phase=phase, sampled_at=int(time.time() * 1000)))


class GenerationStatus:
    """Small routing seam; metric frames must never retire the llama prefill row."""

    def __init__(self, runtime: Any, thinking_id: str) -> None:
        self.runtime = runtime
        self.prefill = PrefillStatus(runtime, thinking_id)
        self.metrics = InferencePerformanceStatus(runtime)
        self.terminal_phase = "failed"

    def accept(self, event: Any, now: float) -> tuple[bool, bool]:
        if self.metrics.accept(event):
            return True, False
        # These are private reader envelopes. Inspect without importing their owner.
        if type(event).__name__ == "_StreamTerminal":
            result = getattr(event, "result", None)
            reason = getattr(result, "finish_reason", "stop")
            self.terminal_phase = _terminal_phase(reason)
        return self.prefill.accept(event, now)

    def flush(self, now: float) -> None:
        self.metrics.flush(now)
        self.prefill.flush(now)

    def wait_timeout(self, now: float, timeout: float) -> float:
        return self.metrics.wait_timeout(now, self.prefill.wait_timeout(now, timeout))

    def finish(self, reason: str = "provider_terminal") -> None:
        cancelled = (
            getattr(getattr(self.runtime, "cancel_handle", None), "cancelled", False) is True
            or isinstance(sys.exception(), (GeneratorExit, KeyboardInterrupt))
            or getattr(sys.exception(), "status", None) == "cancelled"
        )
        phase = (
            "cancelled"
            if cancelled or reason == "thinking_budget"
            else (self.terminal_phase if reason == "provider_terminal" else "failed")
        )
        try:
            self.metrics.finish(phase)
        finally:
            self.prefill.finish()


def _terminal_phase(reason: str) -> str:
    if reason in {"thinking_budget", "cancelled"}:
        return "cancelled"
    failed = reason in {"error", "provider_error", "incomplete", "timeout"}
    return "failed" if failed else "finished"
