"""Bounded SSE line iteration and stream-terminal parsing for the vLLM engine."""

from __future__ import annotations

import json
import logging
from typing import Any

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


def _parse_usage(
    body: dict[str, Any],
    *,
    model_name: str | None,
    provider: str = "vllm",
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
    return GenerationUsage(
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        total_tokens=total_tokens,
        provider=provider,
        model=str(model_name or ""),
        raw_usage=raw_usage,
        last_request_input_tokens=input_tokens,
        generation_tokens=output_tokens,
        generation_duration_ms=positive_number("generation_duration_ms"),
        prompt_eval_duration_ms=positive_number("prompt_eval_duration_ms"),
        load_duration_ms=positive_number("load_duration_ms"),
        time_to_first_token_ms=positive_number("time_to_first_token_ms"),
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
