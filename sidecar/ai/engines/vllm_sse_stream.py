"""Bounded SSE line iteration and stream-terminal parsing for the vLLM engine."""

from __future__ import annotations

import json
import logging
import math
import uuid
from typing import Any, cast

from sidecar.ai.engines.engine_events import ENGINE_EVENT_PREFILL, EngineEvent, PrefillProgress
from sidecar.ai.engines.ollama_stream_transport import (
    raise_if_cancelled as _raise_if_cancelled,
)
from sidecar.ai.engines.ollama_stream_transport import (
    register_response_cancel_callback as _register_close_cancel_callback,
)
from sidecar.ai.routing.provider_stream_normalizer import (
    FINISH_REASON_INCOMPLETE,
    FINISH_REASON_PROVIDER_ERROR,
    FINISH_REASON_REASONING_ONLY,
)
from sidecar.ai.utils.coercion import (
    coerce_non_negative_int,
    coerce_positive_finite_float,
)
from sidecar.runtime.bounded_io import BoundedIOError, iter_bounded_byte_lines
from sidecar.runtime.vllm_engine_support import GenerationUsage

logger = logging.getLogger("sidecar.ai.engines.vllm_engine_generation")

_SSE_DATA_PREFIX = "data: "
_SSE_DONE_SENTINEL = "[DONE]"
_MAX_PROVIDER_STREAM_LINE_BYTES = 1024 * 1024
_MAX_PROVIDER_STREAM_TOTAL_BYTES = 32 * 1024 * 1024
_MAX_PREFILL_CONTEXT_TOKENS = 1_048_576


def _iter_bounded_sse_lines(response: Any):
    iter_raw = getattr(response, "iter_raw", None)
    if callable(iter_raw):
        # No chunk_size: httpx would hold bytes until a whole block filled,
        # releasing a stream of small deltas in bursts.
        chunks = iter_raw(chunk_size=None)
    else:
        # Deterministic test doubles historically expose only iter_lines().
        chunks = (
            f"{line}\n".encode("utf-8", errors="replace")
            for line in response.iter_lines()
        )
    try:
        for raw_line in iter_bounded_byte_lines(
            chunks,
            max_line_bytes=_MAX_PROVIDER_STREAM_LINE_BYTES,
            max_total_bytes=_MAX_PROVIDER_STREAM_TOTAL_BYTES,
        ):
            yield raw_line.decode("utf-8", errors="replace").rstrip("\r\n")
    except BoundedIOError:
        logger.warning(
            "vLLM stream exceeded its bounded transport contract.",
            extra={
                "event": "ai.engines.vllm.stream_bounded",
                "max_line_bytes": _MAX_PROVIDER_STREAM_LINE_BYTES,
                "max_total_bytes": _MAX_PROVIDER_STREAM_TOTAL_BYTES,
            },
        )
        raise


def _iter_cancel_aware_sse_lines(response: Any, cancel_handle: Any):
    unregister_cancel = _register_close_cancel_callback(cancel_handle, response)
    try:
        _raise_if_cancelled(cancel_handle)
        for line in _iter_bounded_sse_lines(response):
            _raise_if_cancelled(cancel_handle)
            yield line
    finally:
        unregister_cancel()


def _decode_sse_chunk(line: str) -> dict[str, Any] | None:
    if not line or not line.startswith(_SSE_DATA_PREFIX):
        return None
    data_str = line[len(_SSE_DATA_PREFIX) :]
    if data_str.strip() == _SSE_DONE_SENTINEL:
        return None
    try:
        value = json.loads(data_str)
    except json.JSONDecodeError:
        return None
    return value if isinstance(value, dict) else None


def provider_timings(body: Any) -> tuple[float, float, int]:
    """Return ``(prompt_ms, predicted_ms, predicted_n)`` from a llama-server body.

    llama-server reports prefill/decode timing in a top-level ``timings``
    object beside ``usage`` (on the final include_usage stream chunk and on a
    non-streaming completion), never inside ``usage``. vLLM sends no timing,
    so every value is ``0`` there and callers keep their other sources.
    """
    timings = body.get("timings") if isinstance(body, dict) else None
    if not isinstance(timings, dict):
        return 0, 0, 0
    return (
        coerce_positive_finite_float(timings.get("prompt_ms")),
        coerce_positive_finite_float(timings.get("predicted_ms")),
        coerce_non_negative_int(timings.get("predicted_n")),
    )


def provider_prompt_cache_counts(body: Any) -> tuple[int | None, int | None]:
    """Return llama-server's ``(prompt_n, cache_n)`` prefill split, or ``None`` each.

    ``timings.prompt_n`` counts the prompt tokens the server evaluated and
    ``timings.cache_n`` the prefix tokens it reused from the slot's KV cache
    (llama.cpp builds from mid-2025 on). ``None`` means the server did not
    report the field, which is different from a reported zero.
    """
    timings = body.get("timings") if isinstance(body, dict) else None
    if not isinstance(timings, dict):
        return None, None

    def count(key: str) -> int | None:
        value = timings.get(key)
        if value is None or isinstance(value, bool):
            return None
        return coerce_non_negative_int(value)

    return count("prompt_n"), count("cache_n")


def _parse_usage(
    body: dict[str, Any],
    *,
    model_name: str | None,
    provider: str = "vllm",
    time_to_first_token_ms: float = 0,
) -> GenerationUsage | None:
    usage = body.get("usage")
    if not isinstance(usage, dict):
        return None
    input_tokens = coerce_non_negative_int(usage.get("prompt_tokens"))
    output_tokens = coerce_non_negative_int(usage.get("completion_tokens"))
    total_tokens = coerce_non_negative_int(usage.get("total_tokens"))
    if total_tokens <= 0:
        total_tokens = input_tokens + output_tokens
    if total_tokens <= 0 and input_tokens <= 0 and output_tokens <= 0:
        return None

    def positive_number(key: str) -> float:
        return coerce_positive_finite_float(usage.get(key))

    raw_usage = {
        key: value
        for key, value in usage.items()
        if key not in {
            "generation_duration_ms",
            "prompt_eval_duration_ms",
            "load_duration_ms",
            "time_to_first_token_ms",
        }
    }
    prompt_ms, predicted_ms, predicted_n = provider_timings(body)
    generation_tokens = output_tokens
    generation_duration_ms = positive_number("generation_duration_ms")
    if generation_duration_ms <= 0 and predicted_ms > 0:
        # Pair the duration with the token count it was measured over.
        generation_duration_ms = predicted_ms
        generation_tokens = predicted_n or output_tokens
    return GenerationUsage(
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        total_tokens=total_tokens,
        provider=provider,
        model=str(model_name or ""),
        raw_usage=raw_usage,
        last_request_input_tokens=input_tokens,
        generation_tokens=generation_tokens,
        generation_duration_ms=generation_duration_ms,
        prompt_eval_duration_ms=positive_number("prompt_eval_duration_ms") or prompt_ms,
        load_duration_ms=positive_number("load_duration_ms"),
        time_to_first_token_ms=(
            positive_number("time_to_first_token_ms")
            or coerce_positive_finite_float(time_to_first_token_ms)
        ),
    )


def _resolve_vllm_stream_finish_reason(
    *,
    saw_terminal: bool,
    inband_error: str,
    reasoning_only: bool,
    terminal_finish_reason: str = "", has_tool_calls: bool = False,
) -> str:
    """Classify how a vLLM stream ACTUALLY ended.

    Precedence, first match wins: a provider error is a definite verdict; a
    missing terminal is not evidence the turn ended, even when tool calls
    parsed, so it stays ``incomplete``; ``reasoning_only`` is the fail-closed
    verdict over a clean ``stop`` terminal; and tool calls outrank a raw
    ``length``. Shares the Ollama sibling's "missing terminal beats parsed tool
    calls" rule -- checking tool calls first made an EOF mid-batch
    indistinguishable from a clean tool turn -- and adds the
    provider-error-first and reasoning-only steps.

    ``reasoning_only`` never masks a provider ``length``: a model still inside
    its thinking block when ``n_predict`` ran out was cut off mid-thought, not
    finished, so the normalized ``length`` is returned and the turn reaches the
    thinking-budget checkpoint continuation
    (``thinking_checkpoint.is_thinking_budget_checkpoint``) instead of the
    empty-generation fallback. Reasoning-only over a clean ``stop`` stays the
    fail-closed ``CMP-STREAM-REASONING-ONLY`` verdict: there the model chose to
    end the turn without answering.
    """
    if inband_error or terminal_finish_reason == FINISH_REASON_PROVIDER_ERROR:
        return FINISH_REASON_PROVIDER_ERROR
    if not saw_terminal:
        return FINISH_REASON_INCOMPLETE
    if reasoning_only:
        normalized = _normalize_vllm_finish_reason(terminal_finish_reason)
        return normalized if normalized == "length" else FINISH_REASON_REASONING_ONLY
    if has_tool_calls:
        return "tool_calls"
    return _normalize_vllm_finish_reason(terminal_finish_reason)


def _normalize_vllm_finish_reason(value: Any) -> str:
    normalized = str(value or "").strip().lower()
    return "length" if normalized in {"length", "max_token", "max_tokens"} else "stop"


def has_generated_delta(chunk: dict[str, Any]) -> bool:
    """A role/id-only provider frame is not a generated token."""
    choices = chunk.get("choices")
    if not isinstance(choices, list):
        return False
    for choice in choices:
        delta = choice.get("delta") if isinstance(choice, dict) else None
        if not isinstance(delta, dict):
            continue
        if any(delta.get(key) for key in ("content", "reasoning_content", "reasoning", "thinking")):
            return True
        calls = delta.get("tool_calls")
        for call in calls if isinstance(calls, list) else []:
            function = call.get("function") if isinstance(call, dict) else None
            if isinstance(function, dict) and (function.get("name") or function.get("arguments")):
                return True
    return False


class LlamaPrefillStream:
    """One physical request's fail-closed progress adapter for the qualified build."""

    def __init__(self, engine: Any) -> None:
        getter = getattr(engine, "get_configured_context_length", None)
        limit = getter() if callable(getter) else None
        self.limit = limit if type(limit) is int and 0 < limit <= _MAX_PREFILL_CONTEXT_TOKENS else 0
        self.enabled = (
            getattr(engine, "_prefill_progress_enabled", False) is True and bool(self.limit)
        )
        self.attempt_id = uuid.uuid4().hex
        self.sequence = 0
        self.previous: PrefillProgress | None = None
        self.closed = False

    def configure_request(self, payload: dict[str, Any]) -> None:
        if self.enabled:
            payload["return_progress"] = True

    def _event(self, state: str, sample: PrefillProgress | None = None) -> EngineEvent:
        self.sequence += 1
        return EngineEvent(kind=ENGINE_EVENT_PREFILL, prefill=sample, prefill_state=state,
                           attempt_id=self.attempt_id, sequence=self.sequence)

    def start_events(self) -> list[EngineEvent]:
        return [self._event("start")] if self.enabled else []

    def _sample(self, raw: Any) -> PrefillProgress | None:
        if not isinstance(raw, dict):
            return None
        total, cache, processed = (raw.get(key) for key in ("total", "cache", "processed"))
        if not all(type(value) is int for value in (total, cache, processed)):
            return None
        total, cache, processed = cast(tuple[int, int, int], (total, cache, processed))
        if not 0 <= cache <= processed <= total <= self.limit or total == 0:
            return None
        elapsed = raw.get("time_ms")
        if elapsed is not None and (type(elapsed) not in (int, float)
                                    or not math.isfinite(elapsed) or elapsed < 0):
            return None
        return PrefillProgress(total, cache, processed, elapsed)

    def _consistent(self, sample: PrefillProgress) -> bool:
        previous = self.previous
        if previous is None:
            return True
        return (sample.total_tokens == previous.total_tokens
                and sample.cached_tokens == previous.cached_tokens
                and sample.processed_tokens >= previous.processed_tokens
                and (sample.elapsed_ms is None or previous.elapsed_ms is None
                     or sample.elapsed_ms >= previous.elapsed_ms))

    def feed(self, chunk: dict[str, Any]) -> list[EngineEvent]:
        if not self.enabled or self.closed:
            return []
        events = []
        if "prompt_progress" in chunk:
            sample = self._sample(chunk["prompt_progress"])
            if sample is None or not self._consistent(sample):
                self.closed = True
                events.append(self._event("unavailable"))
            else:
                if (self.previous is None
                        or sample.processed_tokens != self.previous.processed_tokens):
                    events.append(self._event("sample", sample))
                self.previous = sample
        if has_generated_delta(chunk) and not self.closed:
            # Generated tokens end prefill even when the engine hides them (reasoning).
            self.closed = True
            events.append(self._event("unavailable"))
        return events
