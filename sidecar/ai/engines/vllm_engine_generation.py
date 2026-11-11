# ruff: noqa: PLR0913
"""Generation and streaming methods for the vLLM engine (split from vllm_engine.py)."""

from __future__ import annotations

import contextlib
import json
import logging
import time
from collections.abc import Generator
from typing import Any

import httpx

from sidecar.ai.engines.base import EngineMessage, clamp_timeout_to_deadline
from sidecar.ai.engines.engine_events import EngineEvent
from sidecar.ai.engines.provider_call_finalize import ProviderCallFinalizer
from sidecar.ai.engines.provider_http import ProviderHttpError
from sidecar.ai.engines.provider_metrics import ProviderMetrics
from sidecar.ai.engines.request_route import route_token_headers
from sidecar.ai.engines.vllm_engine_completion import _VLLMCompletionMixin
from sidecar.ai.engines.vllm_sse_stream import (
    LlamaPrefillStream,
    _iter_bounded_sse_lines,  # noqa: F401 - compatibility re-export
    _iter_cancel_aware_sse_lines,
    _parse_usage,
    _resolve_vllm_stream_finish_reason,
    has_generated_delta,
)
from sidecar.ai.engines.vllm_tool_stream import (
    THINKING_BUDGET_ABORT_EVENT,
    _collect_normalized_tool_calls,
    _log_native_reasoning_suppressed,
    _raise_if_cancelled,
    _stream_tool_response,
    log_guard_trip,
    log_guard_verdict,
    log_rejected_tool_input,
    log_truncated_tool_calls,
)
from sidecar.ai.routing.provider_stream_normalizer import (
    FINISH_REASON_INCOMPLETE,
    FINISH_REASON_PROVIDER_ERROR,
    FINISH_REASON_THINKING_BUDGET,
    NormalizedStreamEvent,
    ProviderStreamNormalizer,
)
from sidecar.ai.thinking_guard import (
    budget_trip_check,
    resolve_thinking_budget_chars,
    thinking_budget_abort_enabled,
)
from sidecar.ai.tools.models import ToolCallRequest
from sidecar.runtime.vllm_engine_support import (
    EngineConnectionError,
    GenerationError,
    GenerationResult,
    GenerationUsage,
    ModelNotLoadedError,
    StreamChunk,
    StreamingEvent,
    ThinkingRepetitionGuard,
    _build_tools_payload,
    _normalize_content,
    extract_reasoning_delta,
    log_vllm_stream_terminal_gap,
)

logger = logging.getLogger(__name__)
# Compatibility alias: the abort event now lives beside its logger in
# ``vllm_tool_stream``.
_EVENT = THINKING_BUDGET_ABORT_EVENT

_STREAM_TIMEOUT_SECONDS = 120.0
_SSE_DATA_PREFIX = "data: "
_SSE_DONE_SENTINEL = "[DONE]"


def _terminal_gap_diagnostics(
    normalizer: ProviderStreamNormalizer,
    truncated: list[NormalizedStreamEvent],
    started_at: float,
) -> dict[str, Any]:
    """Counts and names only (never message text) for the terminal-gap event.

    ``ms_since_last_chunk`` and ``bytes_read`` are not here: the SSE reader
    owns those clocks and does not surface them (TR-016 follow-up).
    """
    counters = normalizer.counters
    return {
        "chunk_count": counters.total_chunk_count,
        "tool_args_streaming": counters.tool_call_delta_count > 0,
        "truncated_call_names": [str(event.tool_name or "") for event in truncated],
        "elapsed_ms": int((time.monotonic() - started_at) * 1000),
    }



class _VLLMGenerationMixin(_VLLMCompletionMixin):
    # Per engine class: whether chat-completion calls carry the request's opaque
    # routing token (request_route.py) to a gateway on a loopback IP literal.
    _SENDS_ROUTE_TOKEN: bool = False

    def stream(  # noqa: C901, PLR0912, PLR0915 - BaseEngine transport contract.
        self,
        prompt: str,
        max_tokens: int = 256,
        temperature: float = 0.7,
        reasoning_effort: str | None = None,
        prompt_cache_enabled: bool = False,
        system: str = "",
        messages: list[EngineMessage] | None = None,
        response_format: Any = None,
        cancel_handle: Any = None,
        wall_clock_deadline: float | None = None,
    ) -> Generator[StreamChunk | EngineEvent, None, None]:
        # ``wall_clock_deadline`` is an OPTIONAL widening of BaseEngine.stream:
        # this mode previously hardcoded a 120 s transport timeout even though
        # its caller owns a turn deadline, so a transport acquisition could
        # outlive the routing watchdog. Optional-keyword widening keeps every
        # existing caller (and every subclass/mock implementing the ABC)
        # signature-compatible.
        self._assert_ready()
        payload = self._build_payload(
            prompt=prompt,
            max_tokens=max_tokens,
            temperature=temperature,
            reasoning_effort=reasoning_effort,
            prompt_cache_enabled=prompt_cache_enabled,
            system=system,
            messages=messages,
            response_format=response_format,
        )
        payload["stream"] = True
        prefill = LlamaPrefillStream(self)
        prefill.configure_request(payload)
        num_predict = self._fit_output_to_window(payload)
        # Opt into the OpenAI-style final usage chunk so streaming turns can
        # surface provider-reported prompt/completion token counts (and, when
        # the server has prefix caching enabled, cached_tokens for cache hit-
        # rate). Servers that do not recognize this option simply ignore it.
        existing_stream_options = payload.get("stream_options")
        if isinstance(existing_stream_options, dict):
            existing_stream_options.setdefault("include_usage", True)
        else:
            payload["stream_options"] = {"include_usage": True}
        payload_messages = payload.get("messages")
        message_count = len(payload_messages) if isinstance(payload_messages, list) else 0
        reasoning_output_enabled = self._reasoning_output_enabled()
        self._record_provider_request(
            think_enabled=reasoning_output_enabled,
            num_predict=num_predict,
            temperature=float(payload.get("temperature") or temperature),
            message_count=message_count,
            tool_count=0,
            tool_capable=False,
            provider_sampler=payload,
            final_output_tokens=max_tokens,
            thinking_headroom_tokens=max(num_predict - max_tokens, 0),
        )

        finalizer = ProviderCallFinalizer(self)
        metrics = ProviderMetrics.for_engine(self)
        try:
            reasoning_parser = self._create_request_reasoning_parser()
            thinking_guard = (
                ThinkingRepetitionGuard(
                    max_chars=resolve_thinking_budget_chars(self, max_tokens)
                )
                if reasoning_output_enabled
                else None
            )
            budget_tripped = budget_trip_check(thinking_guard)
            thinking_suppression_logged = False
            native_thinking_seen = False
            # Layered alongside the existing parser: see ollama_runtime for the
            # rationale; the normalizer tracks counters and reasoning-only state.
            normalizer = ProviderStreamNormalizer(provider="vllm")
            finalizer.normalizer = normalizer
            # Terminal-evidence tracking (F10): the sentinel is not the only clean
            # ending -- a chunk carrying ``finish_reason`` is provider truth too,
            # and the normalizer already records it.
            saw_sentinel = False
            inband_error = ""
            stream_usage: GenerationUsage | None = None
            thinking_budget_aborted = False
            started_at = time.monotonic()

            request_timeout = clamp_timeout_to_deadline(
                _STREAM_TIMEOUT_SECONDS,
                wall_clock_deadline,
            )
            # Pooled: the engine's ProviderHttpService owns a keep-alive client
            # (and the base_url), so a streaming turn no longer pays a fresh
            # connection setup per call. The per-call timeout override carries
            # the deadline-clamped transport bound the old throwaway client got
            # from its constructor.
            yield from metrics.start_events()
            with self._service.stream_response(
                "POST",
                "/chat/completions",
                json=payload,
                timeout=request_timeout,
                **self._completion_header_kwargs(),
            ) as response:
                self._raise_for_stream_status(response)
                yield from prefill.start_events()
                for line in _iter_cancel_aware_sse_lines(response, cancel_handle):
                    if not line:
                        continue
                    if not line.startswith(_SSE_DATA_PREFIX):
                        continue
                    data_str = line[len(_SSE_DATA_PREFIX) :]
                    if data_str.strip() == _SSE_DONE_SENTINEL:
                        saw_sentinel = True
                        break
                    try:
                        chunk = json.loads(data_str)
                    except json.JSONDecodeError:
                        continue
                    if str(chunk.get("object") or "") == FINISH_REASON_PROVIDER_ERROR:
                        # In-band error frame: terminal, but not success.
                        inband_error = str(
                            chunk.get("error") or chunk.get("message") or ""
                        )[:200]
                        break
                    # The final include_usage chunk typically carries
                    # usage with empty/missing choices — capture it
                    # before the choices-required short-circuit below.
                    if isinstance(chunk.get("usage"), dict):
                        self._record_provider_usage(chunk)
                        parsed_usage = _parse_usage(
                            chunk,
                            model_name=self.model_name,
                            provider=self._PROVIDER_LABEL,
                            time_to_first_token_ms=self._current_time_to_first_token_ms(),
                        )
                        if parsed_usage is not None:
                            stream_usage = parsed_usage
                    yield from prefill.feed(chunk)
                    yield from metrics.feed(chunk)
                    normalizer.feed(chunk)  # diagnostic-only; logs and never raises
                    choices = chunk.get("choices")
                    if not isinstance(choices, list) or not choices:
                        continue
                    delta = choices[0].get("delta", {}) if isinstance(choices[0], dict) else {}
                    if has_generated_delta(chunk):
                        self._record_first_chunk()

                    reasoning = extract_reasoning_delta(delta)
                    if reasoning and not reasoning_output_enabled:
                        _log_native_reasoning_suppressed(self, reasoning)
                    if reasoning and reasoning_output_enabled:
                        native_thinking_seen = True
                        cleaned = self._sanitize_thinking(reasoning)
                        if cleaned:
                            suppressed = thinking_guard is not None and thinking_guard.feed(
                                cleaned
                            )
                            if suppressed:
                                if not thinking_suppression_logged and thinking_guard:
                                    log_guard_trip(self, thinking_guard)
                                    thinking_suppression_logged = True
                            else:
                                yield StreamingEvent(kind="thinking", text=cleaned)
                            if (
                                not normalizer.saw_terminal_evidence
                                and budget_tripped()
                                and thinking_budget_abort_enabled()
                            ):
                                thinking_budget_aborted = True
                                break

                    content = _normalize_content(delta.get("content"))
                    if content:
                        visible_text = self._sanitize_content(content)
                        reasoning_text = ""
                        if reasoning_parser is not None and not native_thinking_seen:
                            parsed_reasoning, parsed_visible = reasoning_parser.feed(content)
                            reasoning_text = self._sanitize_thinking(parsed_reasoning)
                            visible_text = self._sanitize_content(parsed_visible)
                            if reasoning_text and reasoning_parser.used_markers:
                                self._log_reasoning_parser_fallback(
                                    parser_mode="stream_fallback",
                                    reasoning_chars=len(reasoning_text),
                                    visible_chars=len(visible_text),
                                )
                        if reasoning_text:
                            suppressed = thinking_guard is not None and thinking_guard.feed(
                                reasoning_text
                            )
                            if suppressed:
                                if not thinking_suppression_logged and thinking_guard:
                                    log_guard_trip(self, thinking_guard)
                                    thinking_suppression_logged = True
                            else:
                                yield StreamingEvent(kind="thinking", text=reasoning_text)
                            if (
                                not normalizer.saw_terminal_evidence
                                and budget_tripped()
                                and thinking_budget_abort_enabled()
                            ):
                                thinking_budget_aborted = True
                                break
                        if visible_text:
                            self._record_visible_output(visible_text)
                            yield StreamingEvent(kind="content", text=visible_text)
                if (
                    not thinking_budget_aborted
                    and reasoning_parser is not None
                    and not native_thinking_seen
                ):
                    tail_reasoning, tail_visible = reasoning_parser.flush()
                    sanitized_reasoning = self._sanitize_thinking(tail_reasoning)
                    sanitized_visible = self._sanitize_content(tail_visible)
                    if sanitized_reasoning and reasoning_parser.used_markers:
                        self._log_reasoning_parser_fallback(
                            parser_mode="stream_fallback",
                            reasoning_chars=len(sanitized_reasoning),
                            visible_chars=len(sanitized_visible),
                        )
                    if sanitized_reasoning:
                        suppressed = thinking_guard is not None and thinking_guard.feed(
                            sanitized_reasoning
                        )
                        if not suppressed:
                            yield StreamingEvent(kind="thinking", text=sanitized_reasoning)
                    if sanitized_visible:
                        self._record_visible_output(sanitized_visible)
                        yield StreamingEvent(kind="content", text=sanitized_visible)
                # Finalize BEFORE resolving: the reasoning-only verdict comes
                # from the normalizer's terminal pass (idempotent; the
                # ``finally`` below repeats it for the counters).
                with contextlib.suppress(Exception):
                    normalizer.finalize_for_counters()
                # The finish reason rides the terminal chunk so the signal
                # stays request-scoped (a shared engine attribute leaked
                # reasoning-only verdicts across concurrent/later requests).
                log_guard_verdict(self, thinking_guard, aborted=thinking_budget_aborted)
                if thinking_budget_aborted:
                    stream_finish_reason = FINISH_REASON_THINKING_BUDGET
                else:
                    stream_finish_reason = _resolve_vllm_stream_finish_reason(
                        saw_terminal=(
                            saw_sentinel or normalizer.saw_terminal_evidence
                        ),
                        inband_error=inband_error,
                        reasoning_only=normalizer.reasoning_only_detected,
                        terminal_finish_reason=normalizer.terminal_finish_reason,
                    )
                    if stream_finish_reason in (
                        FINISH_REASON_INCOMPLETE,
                        FINISH_REASON_PROVIDER_ERROR,
                    ):
                        log_vllm_stream_terminal_gap(
                            self,
                            finish_reason=stream_finish_reason,
                            inband_error=inband_error,
                            diagnostics=_terminal_gap_diagnostics(normalizer, [], started_at),
                        )
                finalizer.finish_reason = stream_finish_reason
                finalizer.finalize(cancel_handle=cancel_handle)
                yield StreamingEvent(
                    kind="done",
                    finish_reason=stream_finish_reason,
                    usage=stream_usage,
                )
        except httpx.ConnectError as exc:
            raise EngineConnectionError(
                f"Could not connect to {self._DISPLAY_NAME} at {self._base_url}: {exc}"
            ) from exc
        except httpx.HTTPStatusError as exc:
            raise GenerationError(
                f"{self._DISPLAY_NAME} streaming request failed with "
                f"status {exc.response.status_code}"
            ) from exc
        except (EngineConnectionError, ModelNotLoadedError, GenerationError, ProviderHttpError):
            raise
        except Exception as exc:
            _raise_if_cancelled(cancel_handle)
            raise GenerationError(f"{self._DISPLAY_NAME} streaming failed: {exc}") from exc
        finally:
            finalizer.finalize(cancel_handle=cancel_handle)

    def stream_with_tools(  # BaseEngine transport contract.
        self,
        prompt: str,
        tools: list[dict[str, Any]],
        max_tokens: int = 256,
        temperature: float = 0.7,
        reasoning_effort: str | None = None,
        prompt_cache_enabled: bool = False,
        system: str = "",
        messages: list[EngineMessage] | None = None,
        response_format: Any = None,
        cancel_handle: Any = None,
        wall_clock_deadline: float | None = None,
    ) -> Generator[StreamChunk | EngineEvent, None, GenerationResult]:
        _raise_if_cancelled(cancel_handle)
        self._assert_ready()
        payload = self._build_tool_stream_payload(
            prompt=prompt,
            tools=tools,
            max_tokens=max_tokens,
            temperature=temperature,
            reasoning_effort=reasoning_effort,
            prompt_cache_enabled=prompt_cache_enabled,
            system=system,
            messages=messages,
            response_format=response_format,
        )
        prefill = LlamaPrefillStream(self)
        prefill.configure_request(payload)
        normalizer = ProviderStreamNormalizer(provider="vllm")
        content_parts: list[str] = []
        thinking_parts: list[str] = []
        tool_calls: list[ToolCallRequest] = []
        truncated_calls: list[NormalizedStreamEvent] = []
        usage: GenerationUsage | None = None
        finalizer = ProviderCallFinalizer(self)
        metrics = ProviderMetrics.for_engine(self)
        finalizer.normalizer = normalizer
        try:
            started_at = time.monotonic()
            reasoning_parser = self._create_request_reasoning_parser()
            needs_guard = self._reasoning_output_enabled() or reasoning_parser is not None
            thinking_guard = (
                ThinkingRepetitionGuard(
                    max_chars=resolve_thinking_budget_chars(self, max_tokens)
                )
                if needs_guard
                else None
            )
            request_timeout = clamp_timeout_to_deadline(
                _STREAM_TIMEOUT_SECONDS,
                wall_clock_deadline,
            )
            _raise_if_cancelled(cancel_handle)
            # Pooled, exactly like ``stream()`` above.
            #
            # There is deliberately NO client-level cancel callback here. This
            # path used to register one that called ``client.close()`` on
            # cancel; against the SHARED pooled client that permanently bricks
            # the engine, because an httpx.Client cannot be reopened and every
            # later post_json/stream would fail. Cancellation is already
            # handled at the RESPONSE level inside
            # ``_iter_cancel_aware_sse_lines`` -- the same seam
            # chatgpt_subscription relies on -- which closes only this
            # response and leaves the pool intact.
            yield from metrics.start_events()
            with self._service.stream_response(
                "POST",
                "/chat/completions",
                json=payload,
                timeout=request_timeout,
                **self._completion_header_kwargs(),
            ) as response:
                _raise_if_cancelled(cancel_handle)
                self._raise_for_stream_status(response)
                usage, saw_sentinel, thinking_budget_aborted, inband_error = (
                    yield from _stream_tool_response(
                        self,
                        response,
                        cancel_handle=cancel_handle,
                        normalizer=normalizer,
                        content_parts=content_parts,
                        thinking_parts=thinking_parts,
                        tool_calls=tool_calls,
                        parser=reasoning_parser,
                        guard=thinking_guard,
                        truncated=truncated_calls,
                        prefill=prefill,
                        metrics=metrics,
                    )
                )
            _collect_normalized_tool_calls(
                list(normalizer.finalize()), tool_calls, truncated=truncated_calls
            )
            log_truncated_tool_calls(
                self, truncated_calls, terminal_finish_reason=normalizer.terminal_finish_reason
            )
            log_guard_verdict(self, thinking_guard, aborted=thinking_budget_aborted)
            if thinking_budget_aborted:
                finish_reason = FINISH_REASON_THINKING_BUDGET
            else:
                finish_reason = _resolve_vllm_stream_finish_reason(
                    saw_terminal=saw_sentinel or normalizer.saw_terminal_evidence,
                    inband_error=inband_error,
                    reasoning_only=normalizer.reasoning_only_detected,
                    terminal_finish_reason=normalizer.terminal_finish_reason,
                    has_tool_calls=bool(tool_calls),
                )
                if finish_reason in (FINISH_REASON_INCOMPLETE, FINISH_REASON_PROVIDER_ERROR):
                    # Same actionable event as stream(): without it a socket EOF
                    # mid-tool-turn looked like a clean completion in the logs.
                    log_vllm_stream_terminal_gap(
                        self,
                        finish_reason=finish_reason,
                        inband_error=inband_error,
                        diagnostics=_terminal_gap_diagnostics(
                            normalizer, truncated_calls, started_at
                        ),
                    )
            # A cap rejection drops the call under ANY finish: a model that closed
            # an over-cap call cleanly (``stop``) left only its preamble, which is
            # not an answer (sweep W3-B1). A cut-off call counts only at ``length``.
            rejection_reason = normalizer.tool_input_rejection_reason
            if rejection_reason:
                log_rejected_tool_input(
                    self,
                    reason=rejection_reason,
                    finish_reason=finish_reason,
                    terminal_finish_reason=normalizer.terminal_finish_reason,
                )
            tool_call_truncated = bool(rejection_reason) or (
                finish_reason == "length" and bool(truncated_calls)
            )
            finalizer.finish_reason = finish_reason
            finalizer.finalize(cancel_handle=cancel_handle)
            yield StreamingEvent(kind="done", finish_reason=finish_reason)
            return GenerationResult(
                content="".join(content_parts).strip(),
                tool_calls=tuple(tool_calls),
                finish_reason=finish_reason,
                usage=usage,
                thinking_text="".join(thinking_parts).strip(),
                tool_call_truncated=tool_call_truncated,
                tool_call_rejected_reason=rejection_reason,
            )
        except Exception as error:
            _raise_if_cancelled(cancel_handle)
            if isinstance(error, (GenerationError, EngineConnectionError, ProviderHttpError)):
                raise
            raise GenerationError(
                f"{self._DISPLAY_NAME} tool streaming failed: {type(error).__name__}"
            ) from error
        finally:
            finalizer.finalize(cancel_handle=cancel_handle)

    def _build_tool_stream_payload(  # mirrors stream contract.
        self,
        *,
        prompt: str,
        tools: list[dict[str, Any]],
        max_tokens: int,
        temperature: float,
        reasoning_effort: str | None,
        prompt_cache_enabled: bool,
        system: str,
        messages: list[EngineMessage] | None,
        response_format: Any,
    ) -> dict[str, Any]:
        payload = self._build_payload(
            prompt=prompt,
            max_tokens=max_tokens,
            temperature=temperature,
            reasoning_effort=reasoning_effort,
            prompt_cache_enabled=prompt_cache_enabled,
            system=system,
            messages=messages,
            response_format=response_format,
        )
        tool_defs = _build_tools_payload(tools)
        if tool_defs:
            payload["tools"] = tool_defs
        payload["stream"] = True
        payload["stream_options"] = {"include_usage": True}
        num_predict = self._fit_output_to_window(payload)
        payload_messages = payload.get("messages")
        self._record_provider_request(
            think_enabled=self._reasoning_output_enabled(),
            num_predict=num_predict,
            temperature=float(payload.get("temperature") or temperature),
            message_count=(
                len(payload_messages) if isinstance(payload_messages, list) else 0
            ),
            tool_count=len(tool_defs),
            tool_capable=bool(tool_defs),
            tool_payload_bytes=len(json.dumps(tool_defs)) if tool_defs else 0,
            provider_sampler=payload,
            final_output_tokens=max_tokens,
            thinking_headroom_tokens=max(num_predict - max_tokens, 0),
        )
        return payload

    def _completion_request_headers(self) -> dict[str, str] | None:
        """Per-call headers for a chat-completion request; none unless the class opts in."""
        return route_token_headers(self._base_url) if self._SENDS_ROUTE_TOKEN else None

    def _completion_header_kwargs(self) -> dict[str, Any]:
        # No ``headers`` keyword at all without one: the call stays exactly as before.
        headers = self._completion_request_headers()
        return {} if headers is None else {"headers": headers}

    def _raise_for_stream_status(self, response: Any) -> None:
        """Map an initial streaming status; remote providers override with typed errors."""
        response.raise_for_status()
