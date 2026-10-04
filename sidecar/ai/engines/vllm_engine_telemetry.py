"""Turn-diagnostics telemetry hooks for the vLLM / OpenAI-compatible engine.

Split from ``vllm_engine.py`` (at the 600-line ratchet, 2026-09-20) when the
per-provider-call purpose/outcome tagging landed. Mirrors ``ollama_telemetry``:
the host ``VLLMEngine`` supplies request ids, the request context and the
provider identity; this mixin only talks to the turn diagnostics store.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any

from sidecar.ai.engines.vllm_sse_stream import provider_prompt_cache_counts, provider_timings
from sidecar.runtime.diagnostics import log_event
from sidecar.runtime.local_engine.request_context import (
    consume_provider_call_purpose,
    current_diagnostics_store,
    current_time_to_first_visible_token_ms,
)

logger = logging.getLogger(__name__)


def _ms_to_ns(value_ms: float) -> int | None:
    return int(value_ms * 1_000_000) if value_ms > 0 else None


class _VLLMTelemetryMixin:
    """Provider-request telemetry; every other attribute belongs to the host."""

    model_name: str | None
    _DISPLAY_NAME: str
    _PROVIDER_LABEL: str

    if TYPE_CHECKING:

        def _request_id(self) -> str: ...

        def _current_request_context(self) -> dict[str, Any] | None: ...

    def _record_provider_request(  # noqa: PLR0913  # telemetry
        self,
        *,
        think_enabled: bool,
        num_predict: int | None,
        temperature: float,
        message_count: int,
        tool_count: int,
        tool_capable: bool,
        tool_payload_bytes: int = 0,
        provider_sampler: dict[str, Any] | None = None,
        final_output_tokens: int | None = None,
        thinking_headroom_tokens: int = 0,
    ) -> None:
        # Consumed before the guard: the tag is for THIS call whether or
        # not it is recorded, never for the next one.
        purpose = consume_provider_call_purpose(self) or "turn"
        request_id = self._request_id()
        if not request_id:
            return
        context = self._current_request_context()
        trace_id = str(context.get("trace_id") or "") if isinstance(context, dict) else ""
        # One turn may make several provider calls (tool-loop iterations, an
        # internal reasoning summary, a checkpoint continuation). The purpose
        # tag is set by the routing layer for the next call and consumed here;
        # the first-chunk latch is per CALL so each one gets its own timing.
        if isinstance(context, dict):
            context["first_chunk_logged"] = False
        log_event(
            logger, logging.INFO,
            component="ai.engines.vllm",
            event="ai.engines.vllm.request_started",
            message=f"{self._DISPLAY_NAME} request started.",
            request_id=request_id,
            trace_id=trace_id or request_id,
            data={
                "model": self.model_name,
                "think_enabled": think_enabled,
                "num_predict": num_predict,
                "temperature": temperature,
                "message_count": message_count,
                "tool_count": tool_count,
                "tool_capable": tool_capable,
                "tool_payload_bytes": tool_payload_bytes,
                "purpose": purpose,
            },
        )
        store = current_diagnostics_store(self)
        if store is None or not hasattr(store, "record_provider_request"):
            return
        store.record_provider_request(
            request_id=request_id,
            think_enabled=think_enabled,
            num_predict=num_predict,
            temperature=temperature,
            message_count=message_count,
            tool_count=tool_count,
            tool_capable=tool_capable,
            tool_payload_bytes=tool_payload_bytes,
            provider_sampler=provider_sampler,
            purpose=purpose,
            final_output_tokens=final_output_tokens,
            thinking_headroom_tokens=thinking_headroom_tokens,
        )

    def _record_first_chunk(self) -> None:
        request_id = self._request_id()
        if not request_id:
            return
        context = self._current_request_context()
        if isinstance(context, dict):
            if context.get("first_chunk_logged") is True:
                return
            context["first_chunk_logged"] = True
        store = current_diagnostics_store(self)
        if store is None or not hasattr(store, "record_first_chunk"):
            return
        store.record_first_chunk(request_id=request_id)

    def _record_visible_output(self, text: str) -> None:
        request_id = self._request_id()
        if not request_id:
            return
        store = current_diagnostics_store(self)
        if store is None or not hasattr(store, "record_visible_output"):
            return
        store.record_visible_output(request_id=request_id, text=text)

    def _record_provider_usage(self, body: dict[str, Any] | None) -> None:
        """Extract OpenAI-style usage metrics from a vLLM completion body.

        vLLM's non-streaming ``/chat/completions`` response carries a
        ``usage`` object in OpenAI's shape: ``prompt_tokens``,
        ``completion_tokens``, ``total_tokens``, and optionally a
        ``prompt_tokens_details`` sub-object containing ``cached_tokens``
        when the prefix cache is enabled on the server. This hook merges
        those into the turn diagnostic so the dump exposes cache hit-rate
        and tokens-per-second alongside the Ollama-shaped fields.
        """

        if not isinstance(body, dict):
            return
        usage = body.get("usage")
        if not isinstance(usage, dict):
            return
        store = current_diagnostics_store(self)
        request_id = self._request_id()
        if store is None or not request_id or not hasattr(store, "record_provider_usage"):
            return
        details = usage.get("prompt_tokens_details")
        cached_tokens: Any = None
        if isinstance(details, dict):
            cached_tokens = details.get("cached_tokens")
        # llama-server's ``timings`` splits the prefill into evaluated
        # (``prompt_n``) and reused (``cache_n``) tokens: the prefix-cache meter.
        prompt_n, cache_n = provider_prompt_cache_counts(body)
        if cached_tokens is None:
            cached_tokens = cache_n
        # llama-server's ``timings`` gives the dump provider_tokens_per_second
        # and prefill time; vLLM sends none and these stay unset.
        prompt_ms, predicted_ms, predicted_n = provider_timings(body)
        store.record_provider_usage(
            request_id=request_id,
            prompt_eval_count=usage.get("prompt_tokens"),
            eval_count=predicted_n
            if predicted_ms > 0 and predicted_n > 0
            else usage.get("completion_tokens"),
            cached_tokens=cached_tokens,
            prompt_tokens_evaluated=prompt_n,
            prompt_eval_duration_ns=_ms_to_ns(prompt_ms),
            eval_duration_ns=_ms_to_ns(predicted_ms),
            provider_label=self._PROVIDER_LABEL,
        )

    def _current_time_to_first_token_ms(self) -> float:
        return current_time_to_first_visible_token_ms(self)

    def _complete_provider_request(
        self, *, outcome: str = "completed", finish_reason: str | None = None
    ) -> None:
        request_id = self._request_id()
        store = current_diagnostics_store(self)
        if store is None or not request_id or not hasattr(store, "complete_provider_request"):
            return
        store.complete_provider_request(
            request_id=request_id, outcome=outcome, finish_reason=finish_reason
        )
