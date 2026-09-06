# ruff: noqa: PLR0913
"""Generation and streaming methods for the vLLM engine (split from vllm_engine.py)."""

from __future__ import annotations

import json
import logging
from collections.abc import Generator
from typing import TYPE_CHECKING, Any

import httpx

from sidecar.ai.engines.base import EngineMessage, clamp_timeout_to_deadline
from sidecar.ai.engines.vision_input import (
    VisionInput,
    VisionInputError,
    normalize_vision_inputs,
)
from sidecar.ai.engines.vllm_sse_stream import (
    _decode_sse_chunk,
    _iter_bounded_sse_lines,  # noqa: F401 - compatibility re-export
    _iter_cancel_aware_sse_lines,
    _normalize_vllm_finish_reason,
    _parse_usage,
    _resolve_vllm_stream_finish_reason,
)
from sidecar.ai.routing.provider_stream_normalizer import (
    FINISH_REASON_INCOMPLETE,
    FINISH_REASON_PROVIDER_ERROR,
    FINISH_REASON_THINKING_BUDGET,
    NORMALIZED_KIND_MALFORMED_TOOL_ARGUMENTS,
    NORMALIZED_KIND_TOOL_CALL_COMPLETED,
    NormalizedStreamEvent,
    ProviderStreamNormalizer,
    record_counters_to_diagnostics,
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
    UnsupportedModalityError,
    _build_messages,
    _build_tools_payload,
    _normalize_content,
    _parse_tool_calls,
    extract_reasoning_delta,
    log_vllm_stream_terminal_gap,
)

if TYPE_CHECKING:
    from sidecar.ai.engines.provider_http import ProviderHttpService
    from sidecar.runtime.vllm_engine_support import (
        DelimitedReasoningParser,
        ReasoningExtraction,
    )

logger = logging.getLogger(__name__)
_EVENT = "ai.engines.vllm.thinking_budget_abort"

_STREAM_TIMEOUT_SECONDS = 120.0
_SSE_DATA_PREFIX = "data: "
_SSE_DONE_SENTINEL = "[DONE]"


def _raise_if_cancelled(cancel_handle: Any) -> None:
    if cancel_handle is None:
        return
    raise_method = getattr(cancel_handle, "raise_if_cancelled", None)
    if callable(raise_method):
        raise_method()


def _register_close_cancel_callback(cancel_handle: Any, target: Any) -> Any:
    register = getattr(cancel_handle, "register_cancel_callback", None)
    if not callable(register):
        return lambda: None

    def close_response(_reason: str) -> None:
        close = getattr(target, "close", None)
        if callable(close):
            close()

    unregister = register(close_response)
    return unregister if callable(unregister) else lambda: None


def _collect_normalized_tool_calls(
    events: list[NormalizedStreamEvent],
    calls: list[ToolCallRequest],
) -> None:
    for event in events:
        if event.kind == NORMALIZED_KIND_MALFORMED_TOOL_ARGUMENTS:
            raise GenerationError("vLLM returned malformed tool-call arguments")
        if (
            event.kind != NORMALIZED_KIND_TOOL_CALL_COMPLETED
            or not isinstance(event.arguments_delta, dict)
        ):
            continue
        calls.append(
            ToolCallRequest(
                tool_id=str(event.tool_name or ""),
                arguments=dict(event.arguments_delta),
                call_id=str(event.tool_call_id or ""),
            )
        )


def _emit_tool_thinking(
    guard: ThinkingRepetitionGuard | None, text: str, parts: list[str]
) -> Generator[StreamChunk, None, None]:
    if not text or (guard is not None and guard.feed(text)):
        return
    parts.append(text)
    yield StreamingEvent(kind="thinking", text=text)


def _log_native_reasoning_suppressed(engine: Any, text: str) -> None:
    context = engine._current_request_context()
    sentinel = context if isinstance(context, dict) else vars(engine)
    if sentinel.get("native_reasoning_suppressed_logged") is True:
        return
    sentinel["native_reasoning_suppressed_logged"] = True
    logger.warning(
        "Dropping %s provider reasoning: reasoning output is disabled for this model.",
        engine._DISPLAY_NAME,
        extra={
            "model": engine.model_name,
            "engine": engine._DISPLAY_NAME,
            "chars": len(text),
        },
    )


def _stream_tool_response(  # noqa: C901, PLR0912, PLR0915 - bounded SSE/parser state machine.
    engine: Any,
    response: Any,
    *,
    cancel_handle: Any,
    normalizer: ProviderStreamNormalizer,
    content_parts: list[str], thinking_parts: list[str],
    tool_calls: list[ToolCallRequest],
    parser: DelimitedReasoningParser | None, guard: ThinkingRepetitionGuard | None,
) -> Generator[StreamChunk, None, tuple[GenerationUsage | None, bool, bool]]:
    usage: GenerationUsage | None = None
    saw_sentinel = False
    native_thinking_seen = False
    budget_tripped = budget_trip_check(guard)
    for line in _iter_cancel_aware_sse_lines(response, cancel_handle):
        data = line[len(_SSE_DATA_PREFIX) :].strip() if line.startswith(_SSE_DATA_PREFIX) else ""
        if data == _SSE_DONE_SENTINEL:
            saw_sentinel = True
            break
        chunk = _decode_sse_chunk(line)
        if chunk is None:
            continue
        if isinstance(chunk.get("usage"), dict):
            engine._record_provider_usage(chunk)
            usage = _parse_usage(
                chunk,
                model_name=engine.model_name,
                provider=engine._PROVIDER_LABEL,
            )
        _collect_normalized_tool_calls(list(normalizer.process_chunk(chunk)), tool_calls)
        if normalizer.terminal_finish_reason == FINISH_REASON_PROVIDER_ERROR:
            break
        choices = chunk.get("choices")
        if not isinstance(choices, list) or not choices:
            continue
        first = choices[0] if isinstance(choices[0], dict) else {}
        delta = first.get("delta")
        if not isinstance(delta, dict):
            continue
        engine._record_first_chunk()
        reasoning = engine._sanitize_thinking(extract_reasoning_delta(delta))
        if reasoning:
            native_thinking_seen = True
            if engine._reasoning_output_enabled():
                yield from _emit_tool_thinking(guard, reasoning, thinking_parts)
            else:
                _log_native_reasoning_suppressed(engine, reasoning)
        content = _normalize_content(delta.get("content"))
        if content:
            parsed_reasoning = ""
            visible_content = engine._sanitize_content(content)
            if parser is not None and not native_thinking_seen:
                parsed_reasoning, parsed_visible = parser.feed(content)
                parsed_reasoning = engine._sanitize_thinking(parsed_reasoning)
                visible_content = engine._sanitize_content(parsed_visible)
            yield from _emit_tool_thinking(guard, parsed_reasoning, thinking_parts)
            if visible_content:
                engine._record_visible_output(visible_content)
                content_parts.append(visible_content)
                yield StreamingEvent(kind="content", text=visible_content)
        # Abort AFTER this chunk's visible content is out: the budget abort
        # ends the generation but must never eat text the provider already
        # delivered on the tripping chunk.
        if (
            not normalizer.saw_terminal_evidence
            and budget_tripped()
            and thinking_budget_abort_enabled()
        ):
            return usage, saw_sentinel, True
    if parser is not None and not native_thinking_seen:
        tail_reasoning, tail_visible = parser.flush()
        yield from _emit_tool_thinking(
            guard, engine._sanitize_thinking(tail_reasoning), thinking_parts
        )
        if (
            not (saw_sentinel or normalizer.saw_terminal_evidence)
            and budget_tripped()
            and thinking_budget_abort_enabled()
        ):
            return usage, saw_sentinel, True
        visible_tail = engine._sanitize_content(tail_visible)
        if visible_tail:
            engine._record_visible_output(visible_tail)
            content_parts.append(visible_tail)
            yield StreamingEvent(kind="content", text=visible_tail)
    return usage, saw_sentinel, False


class _VLLMGenerationMixin:
    # ------------------------------------------------------------------
    # Host-state declarations for static type-checking only.
    #
    # This mixin is combined with ``VLLMEngine`` (which subclasses
    # ``BaseEngine``); at runtime every attribute and method below is
    # provided by the host class. The bare annotations and TYPE_CHECKING
    # stubs exist so mypy can check this file in isolation after the
    # engine was split across two modules. They have ZERO runtime effect:
    # bare annotations only populate ``__annotations__`` and the stub
    # bodies never execute because ``TYPE_CHECKING`` is ``False`` at
    # runtime, so they cannot shadow the host's real implementations.
    # ------------------------------------------------------------------

    # -- data attributes owned by the host (VLLMEngine / BaseEngine) --
    model_name: str | None
    _base_url: str
    _service: ProviderHttpService
    _vision: bool

    # Provider-identity constants set on the host class. Declared as plain
    # ``str`` (not ``ClassVar``) to match the host's own ``_PROVIDER_LABEL:
    # str = ...`` declaration, which subclasses override with instance-level
    # assignments; a ``ClassVar`` here would conflict with those overrides.
    _DISPLAY_NAME: str
    _PROVIDER_LABEL: str

    if TYPE_CHECKING:
        # -- methods owned by the host (VLLMEngine / BaseEngine) --
        def _assert_ready(self) -> None: ...

        def _request_id(self) -> str: ...

        def _reasoning_output_enabled(self) -> bool: ...

        def _record_provider_request(
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
        ) -> None: ...

        def _record_first_chunk(self) -> None: ...

        def _record_provider_usage(self, body: dict[str, Any] | None) -> None: ...

        def _record_visible_output(self, text: str) -> None: ...

        def _complete_provider_request(self) -> None: ...

        @staticmethod
        def _sanitize_thinking(text: str) -> str: ...

        @staticmethod
        def _sanitize_content(text: str) -> str: ...

        def _create_request_reasoning_parser(self) -> DelimitedReasoningParser | None: ...

        def _extract_request_reasoning(
            self,
            text: str,
            *,
            parser_mode: str,
        ) -> ReasoningExtraction | None: ...

        def _log_reasoning_parser_fallback(
            self,
            *,
            parser_mode: str,
            reasoning_chars: int,
            visible_chars: int,
        ) -> None: ...

        def _effective_temperature(self, requested_temperature: float) -> float: ...

        def _effective_top_k(self) -> int | None: ...

        def _effective_top_p(self) -> float | None: ...

        def _effective_min_p(self) -> float | None: ...

        def _effective_presence_penalty(self) -> float | None: ...

        def _effective_repeat_penalty(self) -> float | None: ...

    def generate(  # noqa: PLR0917 - BaseEngine transport contract.
        self,
        prompt: str,
        max_tokens: int = 256,
        temperature: float = 0.7,
        reasoning_effort: str | None = None,
        prompt_cache_enabled: bool = False,
        system: str = "",
        messages: list[EngineMessage] | None = None,
        response_format: Any = None,
    ) -> str:
        result = self.generate_with_tools(
            prompt=prompt,
            tools=[],
            max_tokens=max_tokens,
            temperature=temperature,
            reasoning_effort=reasoning_effort,
            prompt_cache_enabled=prompt_cache_enabled,
            system=system,
            messages=messages,
            response_format=response_format,
        )
        return result.content

    def generate_with_vision(
        self,
        prompt: str,
        images: list[VisionInput],
        max_tokens: int = 256,
        temperature: float = 0.7,
    ) -> GenerationResult:
        self._assert_ready()
        if not self._vision:
            raise UnsupportedModalityError("vision", model=str(self.model_name or ""))

        try:
            normalized_images = normalize_vision_inputs(images)
        except VisionInputError as error:
            raise GenerationError(str(error)) from error
        content_blocks: list[dict[str, Any]] = [{"type": "text", "text": prompt}]
        for image in normalized_images:
            content_blocks.append(
                {
                    "type": "image_url",
                    "image_url": {"url": image.as_data_uri()},
                }
            )

        payload: dict[str, Any] = {
            "model": self.model_name,
            "messages": [{"role": "user", "content": content_blocks}],
            "max_tokens": max_tokens,
            "temperature": temperature,
        }
        body = self._service.post_json("/chat/completions", payload)

        choices = body.get("choices")
        if not isinstance(choices, list) or not choices:
            return GenerationResult(content="", finish_reason="stop")

        first = choices[0] if isinstance(choices[0], dict) else {}
        message = first.get("message", {})
        if not isinstance(message, dict):
            return GenerationResult(content="", finish_reason="stop")
        finish_reason = str(first.get("finish_reason", "") or "").strip().lower()
        return GenerationResult(
            content=_normalize_content(message.get("content")).strip(),
            finish_reason="length" if finish_reason == "length" else "stop",
        )

    def stream(  # noqa: C901, PLR0912, PLR0915, PLR0917 - BaseEngine transport contract.
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
    ) -> Generator[StreamChunk, None, None]:
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
            num_predict=max_tokens,
            temperature=float(payload.get("temperature") or temperature),
            message_count=message_count,
            tool_count=0,
            tool_capable=False,
            provider_sampler=payload,
        )

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
        # Terminal-evidence tracking (F10): the sentinel is not the only clean
        # ending -- a chunk carrying ``finish_reason`` is provider truth too,
        # and the normalizer already records it.
        saw_sentinel = False
        inband_error = ""
        stream_usage: GenerationUsage | None = None
        thinking_budget_aborted = False

        try:
            request_timeout = clamp_timeout_to_deadline(
                _STREAM_TIMEOUT_SECONDS,
                wall_clock_deadline,
            )
            # Pooled: the engine's ProviderHttpService owns a keep-alive client
            # (and the base_url), so a streaming turn no longer pays a fresh
            # connection setup per call. The per-call timeout override carries
            # the deadline-clamped transport bound the old throwaway client got
            # from its constructor.
            with self._service.stream_response(
                "POST",
                "/chat/completions",
                json=payload,
                timeout=request_timeout,
            ) as response:
                response.raise_for_status()
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
                        )
                        if parsed_usage is not None:
                            stream_usage = parsed_usage
                    try:
                        normalizer.feed(chunk)
                    except Exception:  # noqa: BLE001 — diagnostic-only.
                        pass
                    choices = chunk.get("choices")
                    if not isinstance(choices, list) or not choices:
                        continue
                    delta = choices[0].get("delta", {}) if isinstance(choices[0], dict) else {}
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
                                if not thinking_suppression_logged:
                                    logger.info(
                                        "Suppressing %s thinking stream after guard tripped.",
                                        self._DISPLAY_NAME,
                                        extra={
                                            "model": self.model_name,
                                            "reason": (
                                                thinking_guard.stop_reason
                                                if thinking_guard
                                                else None
                                            ),
                                        },
                                    )
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
                                if not thinking_suppression_logged:
                                    logger.info(
                                        "Suppressing %s thinking stream after guard tripped.",
                                        self._DISPLAY_NAME,
                                        extra={
                                            "model": self.model_name,
                                            "reason": (
                                                thinking_guard.stop_reason
                                                if thinking_guard
                                                else None
                                            ),
                                        },
                                    )
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
                try:
                    normalizer.finalize_for_counters()
                except Exception:  # noqa: BLE001 — diagnostic-only.
                    pass
                record_counters_to_diagnostics(self, normalizer)
                self._complete_provider_request()
                # The finish reason rides the terminal chunk so the signal
                # stays request-scoped (a shared engine attribute leaked
                # reasoning-only verdicts across concurrent/later requests).
                if thinking_budget_aborted:
                    logger.info(
                        "Thinking budget aborted.",
                        extra={"event": _EVENT, "model": self.model_name, "reason": "char_limit"},
                    )
                    stream_finish_reason = FINISH_REASON_THINKING_BUDGET
                else:
                    stream_finish_reason = _resolve_vllm_stream_finish_reason(
                        saw_terminal=(
                            saw_sentinel or normalizer.saw_terminal_evidence
                        ),
                        inband_error=inband_error,
                        reasoning_only=normalizer.reasoning_only_detected,
                    )
                    if stream_finish_reason in (
                        FINISH_REASON_INCOMPLETE,
                        FINISH_REASON_PROVIDER_ERROR,
                    ):
                        log_vllm_stream_terminal_gap(
                            self,
                            finish_reason=stream_finish_reason,
                            inband_error=inband_error,
                        )
                yield StreamingEvent(
                    kind="done",
                    finish_reason=stream_finish_reason,
                    usage=stream_usage,
                )
        except httpx.ConnectError as exc:
            self._complete_provider_request()
            raise EngineConnectionError(
                f"Could not connect to {self._DISPLAY_NAME} at {self._base_url}: {exc}"
            ) from exc
        except httpx.HTTPStatusError as exc:
            self._complete_provider_request()
            raise GenerationError(
                f"{self._DISPLAY_NAME} streaming request failed with "
                f"status {exc.response.status_code}"
            ) from exc
        except (EngineConnectionError, ModelNotLoadedError, GenerationError):
            self._complete_provider_request()
            raise
        except Exception as exc:
            self._complete_provider_request()
            _raise_if_cancelled(cancel_handle)
            raise GenerationError(f"{self._DISPLAY_NAME} streaming failed: {exc}") from exc

    def stream_with_tools(  # noqa: PLR0913, PLR0917 - BaseEngine transport contract.
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
    ) -> Generator[StreamChunk, None, GenerationResult]:
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
        normalizer = ProviderStreamNormalizer(provider="vllm")
        content_parts: list[str] = []
        thinking_parts: list[str] = []
        tool_calls: list[ToolCallRequest] = []
        usage: GenerationUsage | None = None
        reasoning_parser = self._create_request_reasoning_parser()
        needs_guard = self._reasoning_output_enabled() or reasoning_parser is not None
        thinking_guard = (
            ThinkingRepetitionGuard(
                max_chars=resolve_thinking_budget_chars(self, max_tokens)
            )
            if needs_guard
            else None
        )
        try:
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
            with self._service.stream_response(
                "POST",
                "/chat/completions",
                json=payload,
                timeout=request_timeout,
            ) as response:
                _raise_if_cancelled(cancel_handle)
                response.raise_for_status()
                usage, saw_sentinel, thinking_budget_aborted = yield from _stream_tool_response(
                    self,
                    response,
                    cancel_handle=cancel_handle,
                    normalizer=normalizer,
                    content_parts=content_parts,
                    thinking_parts=thinking_parts,
                    tool_calls=tool_calls,
                    parser=reasoning_parser,
                    guard=thinking_guard,
                )
            _collect_normalized_tool_calls(list(normalizer.finalize()), tool_calls)
            record_counters_to_diagnostics(self, normalizer)
            if thinking_budget_aborted:
                logger.info(
                    "Thinking budget aborted.",
                    extra={"event": _EVENT, "model": self.model_name, "reason": "char_limit"},
                )
                finish_reason = FINISH_REASON_THINKING_BUDGET
            else:
                finish_reason = _resolve_vllm_stream_finish_reason(
                    saw_terminal=saw_sentinel or normalizer.saw_terminal_evidence,
                    inband_error="",
                    reasoning_only=normalizer.reasoning_only_detected,
                    terminal_finish_reason=normalizer.terminal_finish_reason,
                    has_tool_calls=bool(tool_calls),
                )
            yield StreamingEvent(kind="done", finish_reason=finish_reason)
            return GenerationResult(
                content="".join(content_parts).strip(),
                tool_calls=tuple(tool_calls),
                finish_reason=finish_reason,
                usage=usage,
                thinking_text="".join(thinking_parts).strip(),
            )
        except Exception as error:
            _raise_if_cancelled(cancel_handle)
            if isinstance(error, (GenerationError, EngineConnectionError)):
                raise
            raise GenerationError(
                f"{self._DISPLAY_NAME} tool streaming failed: {type(error).__name__}"
            ) from error
        finally:
            self._complete_provider_request()

    def _build_tool_stream_payload(  # noqa: PLR0913 - mirrors stream contract.
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
        payload_messages = payload.get("messages")
        self._record_provider_request(
            think_enabled=self._reasoning_output_enabled(),
            num_predict=max_tokens,
            temperature=float(payload.get("temperature") or temperature),
            message_count=(
                len(payload_messages) if isinstance(payload_messages, list) else 0
            ),
            tool_count=len(tool_defs),
            tool_capable=bool(tool_defs),
            tool_payload_bytes=len(json.dumps(tool_defs)) if tool_defs else 0,
            provider_sampler=payload,
        )
        return payload

    def generate_with_tools(  # noqa: PLR0917 - BaseEngine transport contract.
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
    ) -> GenerationResult:
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
        tool_defs = _build_tools_payload(tools)
        if tool_defs:
            payload["tools"] = tool_defs
        tool_payload_bytes = len(json.dumps(tool_defs)) if tool_defs else 0
        payload_messages = payload.get("messages")
        message_count = len(payload_messages) if isinstance(payload_messages, list) else 0
        self._record_provider_request(
            think_enabled=self._reasoning_output_enabled(),
            num_predict=max_tokens,
            temperature=float(payload.get("temperature") or temperature),
            message_count=message_count,
            tool_count=len(tool_defs),
            tool_capable=bool(tool_defs),
            tool_payload_bytes=tool_payload_bytes,
            provider_sampler=payload,
        )

        try:
            body = self._service.post_json("/chat/completions", payload)
            self._record_first_chunk()
            self._record_provider_usage(body)

            usage = _parse_usage(
                body,
                model_name=self.model_name,
                provider=self._PROVIDER_LABEL,
            )
            choices = body.get("choices")
            if not isinstance(choices, list) or not choices:
                return GenerationResult(content="", finish_reason="stop", usage=usage)

            first = choices[0] if isinstance(choices[0], dict) else {}
            message = first.get("message", {})
            if not isinstance(message, dict):
                return GenerationResult(content="", finish_reason="stop", usage=usage)

            content = _normalize_content(message.get("content"))
            native_reasoning = extract_reasoning_delta(message)
            if native_reasoning and not self._reasoning_output_enabled():
                _log_native_reasoning_suppressed(self, native_reasoning)
                thinking_text = ""
            else:
                thinking_text = self._sanitize_thinking(native_reasoning)
            if not thinking_text:
                extracted = self._extract_request_reasoning(
                    content,
                    parser_mode="content_fallback",
                )
                if extracted is not None:
                    content = extracted.visible_text
                    thinking_text = self._sanitize_thinking(extracted.reasoning_text)
            content = self._sanitize_content(content).strip()
            if content:
                self._record_visible_output(content)
            tool_calls = _parse_tool_calls(message.get("tool_calls"), request_id=self._request_id())
            return GenerationResult(
                content=content,
                tool_calls=tuple(tool_calls),
                finish_reason=("tool_calls" if tool_calls else _normalize_vllm_finish_reason(
                    first.get("finish_reason")
                )),
                usage=usage,
                thinking_text=thinking_text.strip(),
            )
        finally:
            self._complete_provider_request()

    def _build_payload(
        self,
        *,
        prompt: str,
        max_tokens: int,
        temperature: float,
        reasoning_effort: str | None,
        prompt_cache_enabled: bool,
        system: str,
        messages: list[EngineMessage] | None,
        response_format: Any,
    ) -> dict[str, Any]:
        _ = prompt_cache_enabled
        effective_temperature = self._effective_temperature(temperature)
        payload: dict[str, Any] = {
            "model": self.model_name,
            "messages": _build_messages(prompt=prompt, system=system, messages=messages),
            "max_tokens": max_tokens,
            "temperature": effective_temperature,
        }
        effective_top_k = self._effective_top_k()
        if effective_top_k is not None:
            payload["top_k"] = effective_top_k
        effective_top_p = self._effective_top_p()
        if effective_top_p is not None:
            payload["top_p"] = effective_top_p
        effective_min_p = self._effective_min_p()
        if effective_min_p is not None:
            payload["min_p"] = effective_min_p
        effective_presence_penalty = self._effective_presence_penalty()
        if effective_presence_penalty is not None:
            payload["presence_penalty"] = effective_presence_penalty
        effective_repeat_penalty = self._effective_repeat_penalty()
        if effective_repeat_penalty is not None:
            is_llama_cpp = self._PROVIDER_LABEL == "openai-compatible"
            penalty_key = "repeat_penalty" if is_llama_cpp else "repetition_penalty"
            payload[penalty_key] = effective_repeat_penalty
        if isinstance(reasoning_effort, str) and reasoning_effort.strip():
            payload["reasoning_effort"] = reasoning_effort.strip().lower()
        if response_format is not None and getattr(response_format, "is_json", False):
            payload["response_format"] = {"type": "json_object"}
        return payload
