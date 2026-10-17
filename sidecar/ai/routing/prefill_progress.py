"""Request-local measured prefill coalescing; no durable state or background timer."""

from dataclasses import asdict
from typing import Any

from sidecar.ai.engines.engine_events import ENGINE_EVENT_PREFILL, EngineEvent
from sidecar.ai.routing.loop_events import ThinkingEvent

_MAX_ATTEMPTS = 64
_MIN_VISIBLE_TOKENS = 1024
_REVEAL_SECONDS = 0.3


class PrefillStatus:
    """One generation's attempt guard and single pending latest sample."""

    def __init__(self, runtime: Any, thinking_id: str) -> None:
        self.runtime = runtime
        self.thinking_id = thinking_id
        self.attempt_id = ""
        self.sequence = 0
        self.pending: EngineEvent | None = None
        self.next_emit = 0.0
        self.started_at = 0.0
        self.active = False
        self.retired: set[str] = set()
        self.processed: int | None = None

    def accept(self, event: Any, now: float) -> tuple[bool, bool]:
        if not isinstance(event, EngineEvent) or event.kind != ENGINE_EVENT_PREFILL:
            self.finish()
            return False, False
        if event.prefill_state == "start":
            return self._start(event, now)
        if (
            not self.active
            or event.attempt_id != self.attempt_id
            or event.sequence <= self.sequence
        ):
            return True, False
        self.sequence = event.sequence
        if event.prefill_state == "unavailable":
            self.pending = None
            self.active = False
            self._emit(event)
            return True, False
        if event.prefill is None:
            return True, False
        moved = event.prefill.processed_tokens > (
            self.processed if self.processed is not None else event.prefill.cached_tokens
        )
        self.processed = event.prefill.processed_tokens
        self.pending = event
        self.flush(now)
        return True, moved

    def _start(self, event: EngineEvent, now: float) -> tuple[bool, bool]:
        if event.attempt_id == self.attempt_id or event.attempt_id in self.retired:
            return True, False
        if self.attempt_id:
            self.retired.add(self.attempt_id)
        # Provider retries are bounded upstream; cap even malformed sources.
        if len(self.retired) >= _MAX_ATTEMPTS:
            self.finish()
            return True, False
        self.attempt_id = event.attempt_id
        self.sequence = event.sequence
        self.started_at = now
        self.processed = None
        self.active = True
        self.pending = None
        self._emit(event)
        return True, False

    def _emit(self, event: EngineEvent) -> None:
        self.runtime.emit(
            ThinkingEvent(
                thinking_id=self.thinking_id,
                delta="",
                kind="status",
                persist=False,
                progress={
                    "state": event.prefill_state,
                    "attempt_id": event.attempt_id,
                    "sequence": event.sequence,
                    **(asdict(event.prefill) if event.prefill else {}),
                },
            )
        )

    def flush(self, now: float) -> None:
        if self.pending is None or now < self.next_emit:
            return
        sample = self.pending.prefill
        if sample is None:
            return
        if (
            sample.total_tokens - sample.cached_tokens < _MIN_VISIBLE_TOKENS
            and now - self.started_at < _REVEAL_SECONDS
        ):
            return
        self._emit(self.pending)
        self.pending = None
        self.next_emit = now + 0.25

    def wait_timeout(self, now: float, timeout: float) -> float:
        if self.pending is None:
            return timeout
        due = (
            max(self.next_emit, self.started_at + _REVEAL_SECONDS)
            if (
                self.pending.prefill
                and self.pending.prefill.total_tokens - self.pending.prefill.cached_tokens
                < _MIN_VISIBLE_TOKENS
            )
            else self.next_emit
        )
        return min(timeout, max(0.001, due - now))

    def finish(self) -> None:
        self.pending = None
        if self.active:
            self.active = False
            self.sequence += 1
            self._emit(EngineEvent(kind=ENGINE_EVENT_PREFILL, prefill_state="unavailable",
                                   attempt_id=self.attempt_id, sequence=self.sequence))
