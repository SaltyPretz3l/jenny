"""Telemetry and capability-probe recording mixin for the Ollama engine.

This module also hosts the Ollama stream FINISH-REASON resolver and the shared
daemon-residency re-exports. Both belong next to ``build_usage_from_done_chunk``
rather than in ``ollama_runtime`` (which sits at 953/1015 raw lines) or in
``ollama.py`` (which is already AT the 6-module leaf import-fan-out cap enforced
by ``scripts/checks/check_import_fanout.py`` -- re-exporting through a module it
ALREADY imports is what keeps that check green).
"""

from __future__ import annotations

import json
import math
from typing import TYPE_CHECKING, Any

from sidecar.ai.engines.ollama_residency import (  # noqa: F401 -- re-exported.
    ResidencyKey,
    claim_residency,
    forget_residency,
    release_residency,
)
from sidecar.ai.engines.ollama_shared import logger
from sidecar.ai.error_codes import CMP_STREAM_INCOMPLETE
from sidecar.ai.routing.provider_stream_normalizer import (
    FINISH_REASON_INCOMPLETE,
    FINISH_REASON_PROVIDER_ERROR,
)
from sidecar.ai.tools.models import GenerationUsage
from sidecar.runtime.diagnostics import emit_startup_audit_mark
from sidecar.runtime.local_engine.request_context import current_diagnostics_store

# Ollama in-band error frames are top-level ``{"error": "..."}`` NDJSON lines,
# not ``message`` envelopes. Bound the captured text so a provider stack trace
# cannot bloat a log line.
_MAX_INBAND_ERROR_CHARS = 200


def ollama_thinking_enabled(value: Any) -> bool:
    """Return whether an Ollama ``think`` payload enables reasoning output."""
    return value is True or isinstance(value, str) and bool(value.strip())


def _provider_reasoning_effort(think_value: Any) -> str | None:
    if isinstance(think_value, str):
        return think_value
    if think_value is True:
        return "automatic"
    if think_value is False:
        return "none"
    return None


def record_ollama_chat_request(
    engine: Any,
    data: dict[str, Any],
    messages: list[Any],
    final_output_tokens: int,
    tools_payload: list[Any] | None = None,
) -> None:
    """Record the effective reasoning, sampler, and output-budget request state."""
    raw_options = data.get("options")
    options: dict[str, Any] = raw_options if isinstance(raw_options, dict) else {}
    num_predict = options.get("num_predict")
    num_predict = num_predict if isinstance(num_predict, int) else None
    estimate_prompt = getattr(engine, "_estimate_request_prompt_tokens", None)
    remaining_context = getattr(engine, "_remaining_context_tokens", None)
    prompt_tokens_estimate = estimate_prompt(data) if callable(estimate_prompt) else None
    remaining_context_tokens = (
        remaining_context(prompt_tokens_estimate) if callable(remaining_context) else None
    )
    telemetry: dict[str, Any] = {
        "think_enabled": ollama_thinking_enabled(data.get("think")),
        "provider_reasoning_effort": _provider_reasoning_effort(data.get("think")),
        "num_predict": num_predict,
        "final_output_tokens": max(int(final_output_tokens), 0),
        "thinking_headroom_tokens": max(0, int(num_predict or 0) - int(final_output_tokens or 0)),
        "temperature": options["temperature"],
        "message_count": len(messages),
        "tool_count": len(tools_payload or []),
        "tool_capable": tools_payload is not None,
        "provider_sampler": options,
        "prompt_tokens_estimate": prompt_tokens_estimate,
        "remaining_context_tokens": remaining_context_tokens,
    }
    if tools_payload is not None:
        telemetry["tool_payload_bytes"] = len(json.dumps(tools_payload)) if tools_payload else 0
    engine._record_provider_request(**telemetry)


def ollama_stream_inband_error(chunk: Any) -> str:
    """Return an Ollama chunk's in-band error text, or ``""`` when clean."""
    if not isinstance(chunk, dict):
        return ""
    raw = chunk.get("error")
    if not raw:
        return ""
    return str(raw)[:_MAX_INBAND_ERROR_CHARS]


def resolve_ollama_stream_finish_reason(
    *,
    saw_terminal: bool,
    done_reason: str | None,
    has_tool_calls: bool,
) -> str:
    """Map missing terminal evidence to ``incomplete``, in-band errors to
    ``error``, and tool calls to ``tool_calls``. Provider ``length`` is surfaced
    verbatim: consumers accept visible text or tool calls and fail closed only
    when a length-terminated turn produced no usable output.
    """
    if not saw_terminal:
        return FINISH_REASON_INCOMPLETE
    if str(done_reason or "").strip().lower() == FINISH_REASON_PROVIDER_ERROR:
        return FINISH_REASON_PROVIDER_ERROR
    if has_tool_calls:
        return "tool_calls"
    if str(done_reason or "").strip().lower() == "length":
        return "length"
    return "stop"


def log_ollama_stream_terminal_gap(
    engine: Any,
    *,
    finish_reason: str,
    inband_error: str = "",
) -> None:
    """Emit the actionable observability event for a non-clean stream end.

    No-op for a clean finish so the hot path stays silent.
    """
    if finish_reason not in (FINISH_REASON_INCOMPLETE, FINISH_REASON_PROVIDER_ERROR):
        return
    try:
        request_id = engine._request_id()  # noqa: SLF001 -- engine-owned accessor.
    except Exception:  # noqa: BLE001 -- diagnostic-only.
        request_id = ""
    logger.warning(
        "Ollama stream ended without clean terminal evidence.",
        extra={
            "event": "ai.engines.ollama.stream_incomplete",
            "code": CMP_STREAM_INCOMPLETE,
            "request_id": request_id,
            "model": getattr(engine, "model_name", None),
            "finish_reason": finish_reason,
            "inband_error": inband_error,
        },
    )


def _coerce_token_count(value: Any) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return 0
    return parsed if parsed > 0 else 0


def _coerce_duration_ms(value: Any) -> float:
    if isinstance(value, bool):
        return 0
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return 0
    return parsed / 1_000_000 if math.isfinite(parsed) and parsed > 0 else 0


def _coerce_positive_ms(value: Any) -> float:
    if isinstance(value, bool):
        return 0
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return 0
    return parsed if math.isfinite(parsed) and parsed > 0 else 0


def current_time_to_first_token_ms(engine: Any) -> float:
    reader = getattr(engine, "_current_time_to_first_token_ms", None)
    if not callable(reader):
        return 0
    try:
        return _coerce_positive_ms(reader())
    except Exception:  # Diagnostics are best-effort and must not break generation.
        return 0


def current_time_to_first_token_ms_from_store(engine: Any) -> float:
    store = current_diagnostics_store(engine)
    request_id = engine._request_id()
    if store is None or not request_id or not hasattr(store, "snapshot"):
        return 0
    try:
        snapshot = store.snapshot()
        if not isinstance(snapshot, dict):
            return 0
        observed_request_id = str(snapshot.get("request_id") or "")
        if observed_request_id and observed_request_id != request_id:
            return 0
        return _coerce_positive_ms(snapshot.get("time_to_first_visible_token_ms"))
    except Exception:  # Diagnostics are best-effort and must not break generation.
        return 0


def build_usage_from_done_chunk(
    chunk: Any,
    *,
    model_name: str | None,
    time_to_first_token_ms: float = 0,
) -> GenerationUsage | None:
    """Build a :class:`GenerationUsage` from an Ollama done-chunk.

    The terminal streaming chunk (and the non-streaming response body) carry
    ``prompt_eval_count``/``eval_count`` — the provider-truth token counts for
    the request. Returns ``None`` when both counts are missing or zero so a
    present-but-zero record falls through to estimation instead of reading
    as 0 in the context meter.

    Caveat: with server-side KV-cache reuse Ollama reports only the newly
    *evaluated* prompt tokens in ``prompt_eval_count``, so on cache hits this
    can under-read the full prompt. It is still provider truth for the work
    the request did, and strictly better than the ``len//4`` char estimate
    the meter previously ran on.
    """
    if not isinstance(chunk, dict):
        return None
    input_tokens = _coerce_token_count(chunk.get("prompt_eval_count"))
    output_tokens = _coerce_token_count(chunk.get("eval_count"))
    if input_tokens <= 0 and output_tokens <= 0:
        return None
    return GenerationUsage(
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        total_tokens=input_tokens + output_tokens,
        provider="ollama",
        model=str(model_name or ""),
        raw_usage={
            "prompt_eval_count": input_tokens,
            "eval_count": output_tokens,
        },
        last_request_input_tokens=input_tokens,
        generation_tokens=output_tokens,
        generation_duration_ms=_coerce_duration_ms(chunk.get("eval_duration")),
        prompt_eval_duration_ms=_coerce_duration_ms(
            chunk.get("prompt_eval_duration")
        ),
        load_duration_ms=_coerce_duration_ms(chunk.get("load_duration")),
        time_to_first_token_ms=_coerce_positive_ms(
            time_to_first_token_ms or chunk.get("_jenny_ttft_ms")
        ),
    )


class _OllamaTelemetryMixin:
    # Attributes/methods provided by the concrete OllamaEngine hub
    # (sidecar/ai/engines/ollama.py); declared here only for mypy across the
    # mixin split. No runtime effect (bare annotations / TYPE_CHECKING stubs).
    host: str
    model_name: str | None
    _vision: bool
    _thinking: bool
    _tool_calls_enabled: bool
    _context_length: int | None

    if TYPE_CHECKING:

        def _request_id(self) -> str: ...
        def _current_request_context(self) -> dict[str, Any] | None: ...

    def _record_provider_request(
        self,
        *,
        think_enabled: bool,
        num_predict: int | None,
        temperature: float,
        message_count: int,
        tool_count: int,
        tool_capable: bool,
        provider_reasoning_effort: str | None = None,
        final_output_tokens: int | None = None,
        thinking_headroom_tokens: int = 0,
        tool_payload_bytes: int = 0,
        provider_sampler: dict[str, Any] | None = None,
        prompt_tokens_estimate: int | None = None,
        remaining_context_tokens: int | None = None,
    ) -> None:
        store = current_diagnostics_store(self)
        request_id = self._request_id()
        context = self._current_request_context()
        trace_id = str(context.get("trace_id") or "") if isinstance(context, dict) else ""
        if not request_id:
            return
        logger.info(
            "Ollama request started.",
            extra={
                "request_id": request_id,
                "trace_id": trace_id or request_id,
                "model": self.model_name,
                "think_enabled": think_enabled,
                "provider_reasoning_effort": provider_reasoning_effort,
                "num_predict": num_predict,
                "final_output_tokens": final_output_tokens,
                "thinking_headroom_tokens": thinking_headroom_tokens,
                "temperature": temperature,
                "message_count": message_count,
                "tool_count": tool_count,
                "tool_capable": tool_capable,
                "tool_payload_bytes": tool_payload_bytes,
                "prompt_tokens_estimate": prompt_tokens_estimate,
                "remaining_context_tokens": remaining_context_tokens,
            },
        )
        emit_startup_audit_mark(
            logger,
            "provider-request-start",
            data={
                "request_id": request_id,
                "trace_id": trace_id or request_id,
                "model": self.model_name,
                "message_count": message_count,
                "tool_count": tool_count,
            },
        )
        if store is None or not request_id or not hasattr(store, "record_provider_request"):
            return
        diagnostic_sampler = dict(provider_sampler or {})
        diagnostic_sampler["prompt_tokens_estimate"] = prompt_tokens_estimate
        diagnostic_sampler["remaining_context_tokens"] = remaining_context_tokens
        store.record_provider_request(
            request_id=request_id,
            think_enabled=think_enabled,
            provider_reasoning_effort=provider_reasoning_effort,
            num_predict=num_predict,
            final_output_tokens=final_output_tokens,
            thinking_headroom_tokens=thinking_headroom_tokens,
            temperature=temperature,
            message_count=message_count,
            tool_count=tool_count,
            tool_capable=tool_capable,
            tool_payload_bytes=tool_payload_bytes,
            provider_sampler=diagnostic_sampler,
        )

    def _record_first_chunk(self) -> None:
        request_id = self._request_id()
        if not request_id:
            return
        context = self._current_request_context()
        trace_id = str(context.get("trace_id") or "") if isinstance(context, dict) else ""
        if isinstance(context, dict) and context.get("first_chunk_logged") is not True:
            context["first_chunk_logged"] = True
            logger.info(
                "Ollama first chunk received.",
                extra={
                    "request_id": request_id,
                    "trace_id": trace_id or request_id,
                    "model": self.model_name,
                },
            )
            emit_startup_audit_mark(
                logger,
                "first-token-from-engine",
                data={
                    "request_id": request_id,
                    "trace_id": trace_id or request_id,
                    "model": self.model_name,
                },
            )
        store = current_diagnostics_store(self)
        if store is None or not hasattr(store, "record_first_chunk"):
            return
        store.record_first_chunk(request_id=request_id)

    def _record_visible_output(self, text: str) -> None:
        request_id = self._request_id()
        if not request_id:
            return
        context = self._current_request_context()
        trace_id = str(context.get("trace_id") or "") if isinstance(context, dict) else ""
        if isinstance(context, dict) and context.get("first_visible_logged") is not True:
            context["first_visible_logged"] = True
            logger.info(
                "Ollama first visible content received.",
                extra={
                    "request_id": request_id,
                    "trace_id": trace_id or request_id,
                    "model": self.model_name,
                },
            )
        store = current_diagnostics_store(self)
        if store is None or not hasattr(store, "record_visible_output"):
            return
        store.record_visible_output(request_id=request_id, text=text)

    def _current_time_to_first_token_ms(self) -> float:
        return current_time_to_first_token_ms_from_store(self)

    def _record_provider_usage(self, chunk: dict[str, Any] | None) -> None:
        """Extract provider-reported usage metrics from the Ollama done-chunk.

        The final streaming chunk from Ollama carries prompt_eval_count,
        eval_count, and duration fields. Capturing them here means the turn
        diagnostic dump can surface provider-side prompt cache hit-rate and
        tokens-per-second without a separate HTTP round-trip.

        If the done chunk is received but none of the usage fields are
        present, emit a DEBUG log so we can distinguish "Ollama didn't
        emit usage fields" (provider quirk, e.g. gemma generating zero
        output tokens) from "our hook didn't fire" (instrumentation
        regression). Without this, both failure modes surface identically
        as a dump with ``provider_eval_count = null``, which blocks
        Phase-B measurement work.
        """

        if not isinstance(chunk, dict):
            return
        store = current_diagnostics_store(self)
        request_id = self._request_id()
        if store is None or not request_id or not hasattr(store, "record_provider_usage"):
            return
        prompt_eval_count = chunk.get("prompt_eval_count")
        eval_count = chunk.get("eval_count")
        if prompt_eval_count is None and eval_count is None:
            # Done chunk arrived but carries no usage stats. Log what we
            # did see so the operator can correlate with the specific
            # turn. Use keys not values (the chunk can be large) to keep
            # the log line bounded.
            context = self._current_request_context()
            trace_id = str(context.get("trace_id") or "") if isinstance(context, dict) else ""
            logger.debug(
                "Ollama done-chunk missing usage fields.",
                extra={
                    "request_id": request_id,
                    "trace_id": trace_id or request_id,
                    "model": self.model_name,
                    "chunk_keys": sorted(str(key) for key in chunk.keys()),
                    "done_reason": str(chunk.get("done_reason") or ""),
                },
            )
            return
        store.record_provider_usage(
            request_id=request_id,
            prompt_eval_count=prompt_eval_count,
            eval_count=eval_count,
            prompt_eval_duration_ns=chunk.get("prompt_eval_duration"),
            eval_duration_ns=chunk.get("eval_duration"),
            total_duration_ns=chunk.get("total_duration"),
            load_duration_ns=chunk.get("load_duration"),
            provider_label="ollama",
        )

    def _complete_provider_request(self) -> None:
        store = current_diagnostics_store(self)
        request_id = self._request_id()
        if store is None or not request_id or not hasattr(store, "complete_provider_request"):
            return
        store.complete_provider_request(request_id=request_id)
        latest_snapshot = store.snapshot() if hasattr(store, "snapshot") else None
        current_request_context = self._current_request_context()
        logger.info(
            "Ollama request completed.",
            extra={
                "request_id": request_id,
                "trace_id": str(
                    (
                        current_request_context.get("trace_id")
                        if isinstance(current_request_context, dict)
                        else request_id
                    )
                    or request_id
                ),
                "model": self.model_name,
                "visible_output_chars": (
                    latest_snapshot.get("visible_output_chars")
                    if isinstance(latest_snapshot, dict)
                    else None
                ),
                "visible_output_tokens_estimate": (
                    latest_snapshot.get("visible_output_tokens_estimate")
                    if isinstance(latest_snapshot, dict)
                    else None
                ),
                "visible_tokens_per_second_estimate": (
                    latest_snapshot.get("visible_tokens_per_second_estimate")
                    if isinstance(latest_snapshot, dict)
                    else None
                ),
                "time_to_first_chunk_ms": (
                    latest_snapshot.get("time_to_first_chunk_ms")
                    if isinstance(latest_snapshot, dict)
                    else None
                ),
                "time_to_first_visible_token_ms": (
                    latest_snapshot.get("time_to_first_visible_token_ms")
                    if isinstance(latest_snapshot, dict)
                    else None
                ),
                "provider_prompt_eval_count": (
                    latest_snapshot.get("provider_prompt_eval_count")
                    if isinstance(latest_snapshot, dict)
                    else None
                ),
                "provider_eval_count": (
                    latest_snapshot.get("provider_eval_count")
                    if isinstance(latest_snapshot, dict)
                    else None
                ),
                "provider_tokens_per_second": (
                    latest_snapshot.get("provider_tokens_per_second")
                    if isinstance(latest_snapshot, dict)
                    else None
                ),
                "provider_total_duration_ms": (
                    latest_snapshot.get("provider_total_duration_ms")
                    if isinstance(latest_snapshot, dict)
                    else None
                ),
            },
        )

    def _record_capability_probe_success(self, model_name: str) -> None:
        store = getattr(self, "_provider_capability_profile_store", None)
        if store is None:
            return
        try:
            from sidecar.runtime.provider_capability_profile import (
                PROBE_STATUS_READY,
                ProviderCapabilityFeatures,
                ProviderCapabilityObserved,
                derive_endpoint_id,
            )

            store.record_probe_result(
                endpoint_id=derive_endpoint_id("ollama", self.host),
                model_id=model_name,
                features=ProviderCapabilityFeatures(
                    chat_supported=True,
                    streaming_supported=True,
                    native_tools_supported=bool(self._tool_calls_enabled),
                    thinking_or_reasoning_supported=bool(self._thinking),
                ),
                observed=ProviderCapabilityObserved(
                    max_context_advertised=self._context_length,
                ),
                probe_status=PROBE_STATUS_READY,
            )
        except Exception:  # noqa: BLE001
            pass

    def _record_capability_probe_failure(self, model_name: str, error: BaseException) -> None:
        store = getattr(self, "_provider_capability_profile_store", None)
        if store is None:
            return
        try:
            from sidecar.runtime.provider_capability_profile import derive_endpoint_id

            store.mark_failed(
                endpoint_id=derive_endpoint_id("ollama", self.host),
                model_id=model_name or "unknown",
                reason=f"{type(error).__name__}: {str(error)[:120]}",
            )
        except Exception:  # noqa: BLE001
            pass
