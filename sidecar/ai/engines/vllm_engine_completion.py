# ruff: noqa: PLR0913
"""Non-streaming completion and request payloads for the vLLM engine.

Split from ``vllm_engine_generation.py`` (row 105). ``_VLLMGenerationMixin`` (the
streaming paths) subclasses this mixin, so ``VLLMEngine``'s bases are unchanged.
"""

from __future__ import annotations

import json
import logging
from typing import TYPE_CHECKING, Any

from sidecar.ai.engines.base import EngineMessage
from sidecar.ai.engines.provider_call_finalize import ProviderCallFinalizer
from sidecar.ai.engines.provider_metrics import (
    configure_metrics_request,
    observe_nonstream,
    observe_nonstream_body,
)
from sidecar.ai.engines.vllm_sse_stream import _normalize_vllm_finish_reason, _parse_usage
from sidecar.ai.engines.vllm_tool_stream import (
    _log_native_reasoning_suppressed,
    _raise_if_cancelled,
)
from sidecar.runtime.vllm_engine_support import (
    GenerationResult,
    _build_messages,
    _build_tools_payload,
    _normalize_content,
    _parse_tool_calls,
    extract_reasoning_delta,
    mark_history_boundary,
)

if TYPE_CHECKING:
    from sidecar.ai.engines.provider_http import ProviderHttpService
    from sidecar.runtime.vllm_engine_support import (
        DelimitedReasoningParser,
        ReasoningExtraction,
    )

# Records keep the generation module's logger name (this code moved out of it).
logger = logging.getLogger("sidecar.ai.engines.vllm_engine_generation")
_HTTP_BAD_REQUEST = 400


def _is_response_format_rejection(error: Exception) -> bool:
    """True when a 400 says the server does not support ``response_format`` at all.

    NInfer answers ``response_format_not_supported`` ("only {"type":"text"} is
    available") for json_object and json_schema alike. A 400 that merely mentions
    the field (a bad schema, a validation echo) is not a capability answer.
    """
    if getattr(error, "status_code", None) != _HTTP_BAD_REQUEST:
        return False
    text = f"{getattr(error, 'body', '')} {error}".lower()
    if "response_format_not_supported" in text:
        return True
    return "response_format" in text and ("not supported" in text or "unsupported" in text)


class _VLLMCompletionMixin:
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
            final_output_tokens: int | None = None,
            thinking_headroom_tokens: int = 0,
        ) -> None: ...

        def _record_first_chunk(self) -> None: ...

        def _record_provider_usage(self, body: dict[str, Any] | None) -> None: ...

        def _current_time_to_first_token_ms(self) -> float: ...

        def _record_visible_output(self, text: str) -> None: ...

        def _complete_provider_request(
            self, *, outcome: str = "completed", finish_reason: str | None = None
        ) -> None: ...

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

        # Defined on _VLLMGenerationMixin (the route-token opt-in).
        def _completion_header_kwargs(self) -> dict[str, Any]: ...

    def generate(  # BaseEngine transport contract.
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
    ) -> str:
        _raise_if_cancelled(cancel_handle)
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
            cancel_handle=cancel_handle,
        )
        return result.content

    @observe_nonstream
    def generate_with_tools(  # BaseEngine transport contract.
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
    ) -> GenerationResult:
        # ``cancel_handle`` is an optional widening of BaseEngine's contract,
        # used by the cancellable ``generate`` above.
        _raise_if_cancelled(cancel_handle)
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
        num_predict = self._fit_output_to_window(payload)
        payload_messages = payload.get("messages")
        message_count = len(payload_messages) if isinstance(payload_messages, list) else 0
        self._record_provider_request(
            think_enabled=self._reasoning_output_enabled(),
            num_predict=num_predict,
            temperature=float(payload.get("temperature") or temperature),
            message_count=message_count,
            tool_count=len(tool_defs),
            tool_capable=bool(tool_defs),
            tool_payload_bytes=tool_payload_bytes,
            provider_sampler=payload,
            final_output_tokens=max_tokens,
            thinking_headroom_tokens=max(num_predict - max_tokens, 0),
        )

        finalizer = ProviderCallFinalizer(self)
        try:
            # The pooled client is never closed (see stream_with_tools).
            try:
                body = self._post_completion(payload, cancel_handle=cancel_handle)
            except Exception as error:  # noqa: BLE001 - narrowed below
                if "response_format" not in payload or not _is_response_format_rejection(error):
                    raise
                self._disable_json_response_format()
                payload.pop("response_format", None)
                body = self._post_completion(payload, cancel_handle=cancel_handle)
            observe_nonstream_body(body)
            self._record_first_chunk()
            self._record_provider_usage(body)
            result = self._parse_tool_completion(body)
            # An HTTP 200 body without a usable choice (an in-band error or a malformed reply)
            # keeps today's empty result but is a failed call, not a completed one.
            choices = body.get("choices") if isinstance(body, dict) else None
            if isinstance(choices, list) and choices and isinstance(choices[0], dict):
                finalizer.finish_reason = result.finish_reason
            return result
        finally:
            finalizer.finalize()

    def _post_completion(self, payload: dict[str, Any], *, cancel_handle: Any) -> Any:
        # A non-streaming completion sends no headers until it finishes, so a
        # cancellable call needs a connection a cancel can sever before headers.
        headers = self._completion_header_kwargs()
        if cancel_handle is None:
            return self._service.post_json("/chat/completions", payload, **headers)
        return self._service.post_json_interruptible(
            "/chat/completions", payload, cancel_handle=cancel_handle, **headers
        )

    def _parse_tool_completion(self, body: dict[str, Any]) -> GenerationResult:
        usage = _parse_usage(
            body,
            model_name=self.model_name,
            provider=self._PROVIDER_LABEL,
            time_to_first_token_ms=self._current_time_to_first_token_ms(),
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

    def _fit_output_to_window(self, payload: dict[str, Any]) -> int:
        """Return the finished payload's wire ``max_tokens``.

        Called once the prompt and tools are attached. Plain vLLM enforces its
        own ceiling; subclasses that know their served window fit it here.
        """
        return int(payload.get("max_tokens") or 0)

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
        if (
            response_format is not None
            and getattr(response_format, "is_json", False)
            and not getattr(self, "_json_response_format_unsupported", False)
        ):
            payload["response_format"] = self._json_response_format(response_format)
        mark_history_boundary(self, payload)
        configure_metrics_request(self, payload)
        return payload

    def _disable_json_response_format(self) -> None:
        """Remember that this server rejects JSON mode (NInfer serves text only).

        The JSON callers (memory reflection, suggestions, tool-call retry) ask for
        JSON in their prompts as well, so they keep working on plain text.
        """
        if getattr(self, "_json_response_format_unsupported", False):
            return
        self._json_response_format_unsupported = True
        # INFO, not WARN: an expected capability fallback the callers absorb.
        logger.info(
            "%s rejected response_format; JSON mode disabled for this server",
            self._DISPLAY_NAME,
            extra={
                "event": "ai.engines.json_response_format_unsupported",
                "provider": self._PROVIDER_LABEL,
                "model": self.model_name,
            },
        )

    def _json_response_format(self, response_format: Any) -> dict[str, Any]:
        """``json_object``, or llama.cpp's strict ``json_schema`` when opted in.

        Only the managed llama-server opts in (``json_schema_response_format``);
        other OpenAI-compatible servers sharing the label stay on json_object.
        """
        schema = getattr(response_format, "json_schema", None)
        if (
            getattr(self, "_json_schema_response_format", False) is True
            and self._PROVIDER_LABEL == "openai-compatible"
            and isinstance(schema, dict)
            and schema
        ):
            title = schema.get("title")
            name = title.strip() if isinstance(title, str) and title.strip() else "response"
            return {
                "type": "json_schema",
                "json_schema": {"name": name, "schema": schema, "strict": True},
            }
        return {"type": "json_object"}
