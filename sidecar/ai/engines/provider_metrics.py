"""Bounded, best-effort observations for one physical provider dispatch.

No IO, timers, sleeps or generation decisions belong here. Missing provider
fields remain unknown; a corrupt cumulative field stays unknown for the attempt.
"""

from __future__ import annotations

import math
import sys
import time
import uuid
from contextvars import ContextVar
from dataclasses import dataclass
from functools import wraps
from typing import Any, Callable

from sidecar.ai.engines.engine_events import ENGINE_EVENT_INFERENCE_PERFORMANCE, EngineEvent

_TOKEN_LIMIT = 1_048_576
_DURATION_LIMIT = 86_400_000
_RATE_LIMIT = 10_000_000
PROVIDER_KINDS = frozenset({"ninfer", "llama-server", "ollama", "other"})
TERMINAL_PHASES = frozenset({"finished", "failed", "cancelled"})
_NONSTREAM_METRICS: ContextVar[Any] = ContextVar("sidecar_nonstream_metrics", default=None)


@dataclass(frozen=True)
class InferencePerformance:
    """W2 observation, without the runtime-owned turn/notification context."""

    attempt_id: str
    sequence: int
    sampled_at: int
    phase: str
    source: str
    provider_kind: str
    generated_tokens: int | None = None
    decode_interval_tokens: int | None = None
    decode_elapsed_ms: float | None = None
    prompt_tokens: int | None = None
    cached_prompt_tokens: int | None = None
    processed_prompt_tokens: int | None = None
    prefill_elapsed_ms: float | None = None
    time_to_first_generated_token_ms: float | None = None
    terminal_decode_tps: float | None = None
    terminal_prefill_tps: float | None = None


def _number(value: Any, limit: int, *, integer: bool = False) -> bool:
    return (type(value) is int if integer else type(value) in (int, float)) and (
        0 <= value <= limit and math.isfinite(value)
    )


def _rate(tokens: Any, elapsed: Any) -> float | None:
    if tokens is None or elapsed is None or elapsed <= 0:
        return None
    rate = tokens / elapsed * 1000
    return rate if _number(rate, _RATE_LIMIT) else None


def configure_metrics_request(engine: Any, payload: dict[str, Any]) -> None:
    """Only the frozen per-request NInfer opt-in adds provider options."""
    try:
        context = engine._current_request_context() or {}
        options = context.get("inference_performance")
        if (
            context.get("inference_performance_enabled", True) is not False
            and isinstance(options, dict)
            and options.get("live") is True
            and options == {"live": True, "provider_kind": "ninfer"}
        ):
            payload.update(timings_per_token=True, return_progress=True)
    except Exception:  # noqa: BLE001 - optional telemetry must not break generation.
        pass


class ProviderMetrics:
    """Fixed-size parser state. ``feed`` and ``finish`` never propagate errors."""

    def __init__(
        self,
        *,
        provider_kind: str = "other",
        live: bool = False,
        enabled: bool = True,
        clock: Callable[[], float] = time.monotonic,
        epoch: Callable[[], float] = time.time,
    ) -> None:
        self.provider_kind = provider_kind if provider_kind in PROVIDER_KINDS else "other"
        self.live = live is True and self.provider_kind == "ninfer"
        self.enabled = enabled
        self.clock, self.epoch = clock, epoch
        self.dispatched_at = clock()
        self.attempt_id = uuid.uuid4().hex
        self.sequence = -1
        self.phase = "waiting"
        self.values: dict[str, Any] = {}
        self.invalid: set[str] = set()
        self.closed = False
        self.first_generated = False
        self.body_valid = False
        self.prompt_total_reported = False

    @classmethod
    def for_engine(cls, engine: Any) -> ProviderMetrics:
        try:
            context = engine._current_request_context() or {}
            options = context.get("inference_performance") or {}
            return cls(
                provider_kind=options.get("provider_kind", "other"),
                live=options.get("live") is True,
                enabled=context.get("inference_performance_enabled") is True,
            )
        except Exception:  # noqa: BLE001
            return cls(enabled=False)

    def _drop(self, name: str) -> None:
        self.invalid.add(name)
        self.values[name] = None

    def _put(self, name: str, value: Any, *, integer: bool = True) -> None:
        if name in self.invalid:
            return
        previous = self.values.get(name)
        if not _number(value, _TOKEN_LIMIT if integer else _DURATION_LIMIT, integer=integer) or (
            previous is not None and value < previous
        ):
            self._drop(name)
        else:
            self.values[name] = value

    def _fields(self, raw: Any, mapping: dict[str, str], durations: tuple[str, ...]) -> None:
        if not isinstance(raw, dict):
            return
        for key, name in mapping.items():
            if key in raw:
                self._put(name, raw[key], integer=key not in durations)

    def _timings(self, raw: Any) -> None:
        self._fields(
            raw,
            {
                "predicted_n": "generated_tokens",
                "predicted_ms": "decode_elapsed_ms",
                "prompt_n": "fresh_prompt_tokens",
                "prompt_ms": "prompt_ms",
                "cache_n": "cached_prompt_tokens",
            },
            ("predicted_ms", "prompt_ms"),
        )
        fresh, cache = (
            self.values.get(key) for key in ("fresh_prompt_tokens", "cached_prompt_tokens")
        )
        if fresh is not None and cache is not None:
            self._put("prompt_tokens", fresh + cache)
        elif not self.prompt_total_reported and self.invalid.intersection(
            {"fresh_prompt_tokens", "cached_prompt_tokens"}
        ):
            self._drop("prompt_tokens")

    def _progress(self, raw: Any) -> None:
        if isinstance(raw, dict) and "total" in raw:
            self.prompt_total_reported = True
        self._fields(
            raw,
            {
                "total": "prompt_tokens",
                "cache": "cached_prompt_tokens",
                "processed": "processed_prompt_tokens",
                "time_ms": "prefill_elapsed_ms",
            },
            ("time_ms",),
        )
        if self.live and self.phase == "waiting":
            self.phase = "prefill"

    def _relationships(self) -> None:
        total, cache, processed = (
            self.values.get(key)
            for key in ("prompt_tokens", "cached_prompt_tokens", "processed_prompt_tokens")
        )
        if total is not None and cache is not None and cache > total:
            self._drop("cached_prompt_tokens")
            cache = None
        if processed is not None and (
            (total is not None and processed > total) or (cache is not None and processed < cache)
        ):
            self._drop("processed_prompt_tokens")

    def _event(self) -> EngineEvent:
        self.sequence += 1
        v = self.values
        generated = v.get("generated_tokens")
        intervals = max(generated - 1, 0) if generated is not None else None
        sample = InferencePerformance(
            attempt_id=self.attempt_id,
            sequence=self.sequence,
            sampled_at=int(self.epoch() * 1000),
            phase=self.phase,
            source="provider" if any(value is not None for value in v.values()) else "unavailable",
            provider_kind=self.provider_kind,
            generated_tokens=generated,
            decode_interval_tokens=intervals,
            decode_elapsed_ms=v.get("decode_elapsed_ms"),
            prompt_tokens=v.get("prompt_tokens"),
            cached_prompt_tokens=v.get("cached_prompt_tokens"),
            processed_prompt_tokens=v.get("processed_prompt_tokens"),
            prefill_elapsed_ms=v.get("prefill_elapsed_ms"),
            time_to_first_generated_token_ms=v.get("time_to_first_generated_token_ms"),
            terminal_decode_tps=_rate(intervals, v.get("decode_elapsed_ms")),
            terminal_prefill_tps=_rate(v.get("fresh_prompt_tokens"), v.get("prompt_ms")),
        )
        return EngineEvent(
            kind=ENGINE_EVENT_INFERENCE_PERFORMANCE,
            performance=sample,
            attempt_id=self.attempt_id,
            sequence=self.sequence,
        )

    def start_events(self) -> list[EngineEvent]:
        try:
            if self.sequence < 0:
                self.dispatched_at = self.clock()
            return [self._event()] if self.enabled else []
        except Exception:  # noqa: BLE001
            return []

    def feed(self, chunk: Any, *, non_stream: bool = False) -> list[EngineEvent]:
        try:
            events = self._feed(chunk, non_stream=non_stream)
            return events if self.enabled else []
        except Exception:  # noqa: BLE001 - provider metadata can never fail a turn.
            return []

    def _feed(self, chunk: Any, *, non_stream: bool) -> list[EngineEvent]:
        from sidecar.ai.engines.vllm_sse_stream import has_generated_delta

        if self.closed or not isinstance(chunk, dict):
            return []
        previous_values, previous_phase = dict(self.values), self.phase
        if "timings" in chunk:
            self._timings(chunk["timings"])
        if "prompt_progress" in chunk:
            self._progress(chunk["prompt_progress"])
        self._relationships()
        observed = chunk
        if non_stream:
            observed = {
                "choices": [
                    {"delta": choice.get("message")}
                    for choice in chunk.get("choices", [])
                    if isinstance(choice, dict)
                ]
            }
        if not self.first_generated and has_generated_delta(observed):
            self.first_generated = True
            self._put(
                "time_to_first_generated_token_ms",
                (self.clock() - self.dispatched_at) * 1000,
                integer=False,
            )
            if self.live:
                self.phase = "decode"
        if self.values != previous_values or self.phase != previous_phase:
            return [self._event()] if self.enabled else []
        return []

    def feed_ollama(self, chunk: Any) -> list[EngineEvent]:
        try:
            return self.feed({"choices": [{"delta": chunk.get("message")}]})
        except Exception:  # noqa: BLE001
            return []

    def ollama_done(self, chunk: Any) -> list[EngineEvent]:
        try:
            if not isinstance(chunk, dict):
                return []
            self._fields(
                chunk,
                {"eval_count": "generated_tokens", "prompt_eval_count": "fresh_prompt_tokens"},
                (),
            )
            for source, target in (
                ("eval_duration", "decode_elapsed_ms"),
                ("prompt_eval_duration", "prompt_ms"),
            ):
                if source in chunk:
                    raw = chunk[source]
                    self._put(
                        target, raw / 1_000_000 if type(raw) in (int, float) else raw, integer=False
                    )
            # Ollama's prompt_eval_count excludes cached tokens: total/cache stay unknown.
            return [self._event()] if self.enabled else []
        except Exception:  # noqa: BLE001
            return []

    def finish(self, phase: str = "finished") -> EngineEvent | None:
        try:
            if self.closed:
                return None
            self.closed = True
            self.phase = phase if phase in TERMINAL_PHASES else "failed"
            return self._event()
        except Exception:  # noqa: BLE001
            return None


def observe_nonstream_body(body: Any, *, ollama: bool = False) -> None:
    """Same parser for the buffered HTTP body; observation never alters its result."""
    metrics = _NONSTREAM_METRICS.get()
    if metrics is None:
        return
    if ollama:
        metrics.feed_ollama(body)
        metrics.ollama_done(body)
        metrics.body_valid = isinstance(body, dict) and body.get("done") is True
    else:
        metrics.feed(body, non_stream=True)
        choices = body.get("choices") if isinstance(body, dict) else None
        metrics.body_valid = bool(
            isinstance(choices, list)
            and choices
            and isinstance(choices[0], dict)
            and isinstance(choices[0].get("message"), dict)
        )


def observe_nonstream(function: Callable[..., Any]) -> Callable[..., Any]:
    """Own a physical buffered attempt, including exceptional/cancelled exits."""

    @wraps(function)
    def wrapped(engine: Any, *args: Any, **kwargs: Any) -> Any:
        metrics = ProviderMetrics.for_engine(engine)
        try:
            context = engine._current_request_context() or {}
            emit = context.get("inference_performance_emit")
        except Exception:  # noqa: BLE001
            emit = None

        def publish(event: EngineEvent | None) -> None:
            try:
                if metrics.enabled and callable(emit) and event is not None:
                    emit(event)
            except Exception:  # noqa: BLE001
                pass

        token = _NONSTREAM_METRICS.set(metrics)
        phase = "failed"
        try:
            for event in metrics.start_events():
                publish(event)
            result = function(engine, *args, **kwargs)
            reason = getattr(result, "finish_reason", "stop")
            if metrics.body_valid and reason in {"stop", "length", "tool_calls", "reasoning_only"}:
                phase = "finished"
            elif reason in {"thinking_budget", "cancelled"}:
                phase = "cancelled"
            return result
        finally:
            error = sys.exception()
            if isinstance(error, (GeneratorExit, KeyboardInterrupt)) or (
                getattr(error, "status", None) == "cancelled"
            ):
                phase = "cancelled"
            publish(metrics.finish(phase))
            _NONSTREAM_METRICS.reset(token)

    return wrapped
