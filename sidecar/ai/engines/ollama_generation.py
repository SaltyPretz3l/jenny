"""Text generation, tool-calling, vision, and reasoning mixin for the Ollama engine."""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from collections.abc import Generator
from typing import TYPE_CHECKING, Any

from sidecar.ai.engines.base import EngineMessage
from sidecar.ai.engines.ollama_metadata import (
    build_tools_payload_cached as _build_tools_payload_cached_helper,
)
from sidecar.ai.engines.ollama_metadata import (
    model_size_billions as _model_size_billions_helper,
)
from sidecar.ai.engines.ollama_runtime import (
    generate as _ollama_generate,
)
from sidecar.ai.engines.ollama_runtime import (
    generate_with_tools_impl as _ollama_generate_with_tools_impl,
)
from sidecar.ai.engines.ollama_runtime import (
    plain_generate_result as _ollama_plain_generate_result,
)
from sidecar.ai.engines.ollama_runtime import (
    stream as _ollama_stream,
)
from sidecar.ai.engines.ollama_runtime import (
    stream_with_tools as _ollama_stream_with_tools,
)
from sidecar.ai.engines.ollama_shared import (
    _BAD_REQUEST_STATUS,
    _HTTP_STATUS_RE,
    logger,
    supports_ollama_reasoning_levels,
)
from sidecar.ai.engines.vision_input import (
    VisionImage,
    VisionInput,
    VisionInputError,
    normalize_vision_inputs,
)
from sidecar.ai.tools.inband_parser import extract_inband_tool_calls_detailed
from sidecar.runtime.local_engine.messages import (
    contains_primary_system_message as _contains_primary_system_message,
)
from sidecar.runtime.local_engine.messages import (
    demote_non_leading_system_messages as _demote_non_leading_system_messages,
)
from sidecar.runtime.local_engine.messages import (
    merge_consecutive_system_messages as _merge_consecutive_system_messages,
)
from sidecar.runtime.local_engine.reasoning import (
    create_request_reasoning_parser as _create_shared_reasoning_parser,
)
from sidecar.runtime.local_engine.reasoning import (
    extract_request_reasoning as _extract_shared_reasoning,
)
from sidecar.runtime.local_engine.reasoning import (
    log_reasoning_parser_fallback as _log_shared_reasoning_parser_fallback,
)
from sidecar.runtime.local_engine.reasoning import (
    sanitize_thinking_text as _sanitize_shared_thinking_text,
)
from sidecar.runtime.local_engine.request_context import (
    effective_min_p as _shared_effective_min_p,
)
from sidecar.runtime.local_engine.request_context import (
    effective_repeat_penalty as _shared_effective_repeat_penalty,
)
from sidecar.runtime.local_engine.request_context import (
    effective_sampler as _shared_effective_sampler,
)
from sidecar.runtime.local_engine.request_context import (
    effective_temperature as _shared_effective_temperature,
)
from sidecar.runtime.local_engine.request_context import (
    effective_top_k as _shared_effective_top_k,
)
from sidecar.runtime.local_engine.request_context import (
    effective_top_p as _shared_effective_top_p,
)
from sidecar.runtime.ollama_support import (
    DelimitedReasoningParser,
    EngineConnectionError,
    GenerationError,
    GenerationResult,
    ModelNotLoadedError,
    ReasoningExtraction,
    ResponseFormat,
    StreamChunk,
    UnsupportedModalityError,
)


class _OllamaGenerationMixin:
    # Attributes/methods provided by the concrete OllamaEngine hub
    # (sidecar/ai/engines/ollama.py); declared here only for mypy across the
    # mixin split. No runtime effect (bare annotations / TYPE_CHECKING stubs).
    # ``_tool_call_http_400_streak`` is annotated here (not just inherited)
    # because this mixin reassigns it, which otherwise yields a [has-type]
    # error.
    # ``_tool_calls_enabled`` is annotated here (not just inherited) because
    # this mixin reassigns it, which otherwise yields a [has-type] error.
    model_name: str | None
    _vision: bool
    _thinking: bool
    _tool_calls_enabled: bool
    _tool_call_http_400_streak: int
    _request_timeout_seconds: float
    _context_length: int | None
    _thinking_capability_source: str

    if TYPE_CHECKING:

        def _post(
            self,
            endpoint: str,
            data: dict[str, Any],
            timeout: float | None = None,
        ) -> dict[str, Any]: ...
        def _assert_ready(self) -> None: ...
        def _ensure_local_runtime_capability_sources(self) -> dict[str, str]: ...
        def _apply_configured_num_ctx(self, options: dict[str, Any]) -> dict[str, Any]: ...
        def _get_request_context_length(self) -> int | None: ...
        def _current_app_profile_behavior(self) -> dict[str, Any]: ...
        def _current_request_context(self) -> dict[str, Any] | None: ...
        def _debug_option_enabled(self, key: str) -> bool: ...
        def get_configured_context_length(self) -> int | None: ...
        def get_model_max_output_tokens(self) -> int | None: ...
        def _timeout_message(self, operation: str) -> str: ...
        def _describe_url_error(self, error: urllib.error.URLError, operation: str) -> str: ...
        @staticmethod
        def _is_timeout_error(error: Exception) -> bool: ...
        @classmethod
        def _is_timeout_url_error(cls, error: urllib.error.URLError) -> bool: ...

    def generate_inline_completion(
        self,
        model: str,
        prefix: str,
        suffix: str = "",
        *,
        use_gpu: bool = False,
        max_tokens: int = 96,
        timeout: int | None = None,
    ) -> str:
        """Fill-in-the-middle code completion via Ollama's /api/generate.

        Sends the cursor `prefix` plus the `suffix` (the text after the cursor)
        so an FIM-capable model — e.g. ``qwen2.5-coder:*-base`` — fills between
        them; a non-FIM model simply ignores the suffix and continues from the
        prefix (a graceful, lower-quality fallback). ``model`` may differ from
        this engine's bound chat model: the same Ollama daemon serves both. When
        ``use_gpu`` is False the FIM model is CPU-pinned (``num_gpu=0``) so it
        coexists with the hot chat model instead of evicting it on a single GPU.

        Returns the completion text (possibly empty). Raises on a connection/HTTP
        failure so the caller can degrade to "no suggestion this round".
        """
        name = str(model or self.model_name or "").strip()
        if not name:
            return ""
        try:
            predict = int(max_tokens)
        except (TypeError, ValueError):
            predict = 96
        predict = max(1, min(predict, 512))
        options: dict[str, Any] = {"num_predict": predict, "temperature": 0.15}
        if not use_gpu:
            options["num_gpu"] = 0
        data = {
            "model": name,
            "prompt": str(prefix or ""),
            "suffix": str(suffix or ""),
            "stream": False,
            # Hold the FIM model hot between keystrokes so completions stay fast.
            "keep_alive": "10m",
            "options": options,
        }
        response = self._post("/api/generate", data, timeout=timeout)
        if not isinstance(response, dict):
            return ""
        return str(response.get("response", "") or "")

    def generate(
        self,
        prompt: str,
        max_tokens: int = 16384,
        temperature: float = 0.7,
        reasoning_effort: str | None = None,
        prompt_cache_enabled: bool = False,
        system: str = "",
        messages: list[EngineMessage] | None = None,
        response_format: ResponseFormat | None = None,
    ) -> str:
        return _ollama_generate(
            self,
            prompt=prompt,
            max_tokens=max_tokens,
            temperature=temperature,
            reasoning_effort=reasoning_effort,
            prompt_cache_enabled=prompt_cache_enabled,
            system=system,
            messages=messages,
            response_format=response_format,
        )

    def stream(
        self,
        prompt: str,
        max_tokens: int = 16384,
        temperature: float = 0.7,
        reasoning_effort: str | None = None,
        prompt_cache_enabled: bool = False,
        system: str = "",
        messages: list[EngineMessage] | None = None,
        response_format: ResponseFormat | None = None,
        cancel_handle: Any = None,
    ) -> Generator[StreamChunk, None, None]:
        yield from _ollama_stream(
            self,
            prompt=prompt,
            max_tokens=max_tokens,
            temperature=temperature,
            reasoning_effort=reasoning_effort,
            prompt_cache_enabled=prompt_cache_enabled,
            system=system,
            messages=messages,
            response_format=response_format,
            cancel_handle=cancel_handle,
        )

    def generate_with_tools(
        self,
        prompt: str,
        tools: list[dict[str, Any]],
        max_tokens: int = 16384,
        temperature: float = 0.7,
        reasoning_effort: str | None = None,
        prompt_cache_enabled: bool = False,
        system: str = "",
        messages: list[EngineMessage] | None = None,
        response_format: ResponseFormat | None = None,
    ) -> GenerationResult:
        if not self._tool_calls_enabled:
            return self._fallback_plain_generate_result(
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

        try:
            result = self._generate_with_tools_impl(
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
        except EngineConnectionError as error:
            if self._extract_http_status(error) != _BAD_REQUEST_STATUS:
                raise
            self._note_tool_call_http_400(streaming=False)
            return self._fallback_plain_generate_result(
                prompt=prompt,
                tools=tools,
                max_tokens=max_tokens,
                temperature=temperature,
                reasoning_effort=reasoning_effort,
                prompt_cache_enabled=prompt_cache_enabled,
                system=system,
                messages=messages,
                response_format=response_format,
                degraded=True,
            )
        self._tool_call_http_400_streak = 0
        return result

    def _generate_with_tools_impl(
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
        response_format: ResponseFormat | None,
    ) -> GenerationResult:
        return _ollama_generate_with_tools_impl(
            self,
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

    def stream_with_tools(
        self,
        prompt: str,
        tools: list[dict[str, Any]],
        max_tokens: int = 16384,
        temperature: float = 0.7,
        reasoning_effort: str | None = None,
        prompt_cache_enabled: bool = False,
        system: str = "",
        messages: list[EngineMessage] | None = None,
        response_format: ResponseFormat | None = None,
        cancel_handle: Any = None,
        wall_clock_deadline: float | None = None,
    ) -> Generator[StreamChunk, None, GenerationResult]:
        if not self._tool_calls_enabled:
            return (
                yield from self._fallback_plain_stream_result(
                    prompt=prompt,
                    tools=tools,
                    max_tokens=max_tokens,
                    temperature=temperature,
                    reasoning_effort=reasoning_effort,
                    prompt_cache_enabled=prompt_cache_enabled,
                    system=system,
                    messages=messages,
                    response_format=response_format,
                    cancel_handle=cancel_handle,
                    wall_clock_deadline=wall_clock_deadline,
                )
            )

        try:
            result = yield from _ollama_stream_with_tools(
                self,
                prompt=prompt,
                tools=tools,
                max_tokens=max_tokens,
                temperature=temperature,
                reasoning_effort=reasoning_effort,
                prompt_cache_enabled=prompt_cache_enabled,
                system=system,
                messages=messages,
                response_format=response_format,
                cancel_handle=cancel_handle,
                wall_clock_deadline=wall_clock_deadline,
            )
        except EngineConnectionError as error:
            if self._extract_http_status(error) != _BAD_REQUEST_STATUS:
                raise
            self._note_tool_call_http_400(streaming=True)
            return (
                yield from self._fallback_plain_stream_result(
                    prompt=prompt,
                    tools=tools,
                    max_tokens=max_tokens,
                    temperature=temperature,
                    reasoning_effort=reasoning_effort,
                    prompt_cache_enabled=prompt_cache_enabled,
                    system=system,
                    messages=messages,
                    response_format=response_format,
                    degraded=True,
                    cancel_handle=cancel_handle,
                    wall_clock_deadline=wall_clock_deadline,
                )
            )
        self._tool_call_http_400_streak = 0
        return result

    def _build_tools_payload_cached(
        self,
        tools: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        return _build_tools_payload_cached_helper(self, tools)

    def generate_with_vision(
        self,
        prompt: str,
        images: list[VisionInput],
        max_tokens: int = 256,
        temperature: float = 0.7,
    ) -> GenerationResult:
        if not self._vision:
            raise UnsupportedModalityError("vision", model=self.model_name or "")
        self._assert_ready()

        try:
            encoded = [image.as_base64() for image in normalize_vision_inputs(images)]
        except VisionInputError as error:
            raise GenerationError(str(error)) from error

        data: dict[str, Any] = {
            "model": self.model_name,
            "prompt": prompt,
            "images": encoded,
            "stream": False,
        }
        data["options"] = self._build_options(
            max_tokens,
            temperature,
            prompt_tokens_estimate=self._estimate_request_prompt_tokens(data),
        )
        # Vision OCR/triage wants the visible answer, not a hidden reasoning pass.
        # Thinking-capable models (e.g. the gemma4-vision alias) route output to the
        # `thinking` field and leave `response` empty unless thinking is disabled.
        # Mirror the chat path: only send `think` for models that support it.
        if self._thinking:
            data["think"] = False
        try:
            resp = self._post("/api/generate", data)
            text = str(resp.get("response", "")).strip()
            if not text:
                # Defensive: a thinking-capable model that still routed output to
                # the reasoning channel would otherwise return an empty string.
                text = str(resp.get("thinking", "")).strip()
            done_reason = str(resp.get("done_reason", "") or "").strip().lower()
            return GenerationResult(
                content=text,
                finish_reason="length" if done_reason == "length" else "stop",
            )
        except urllib.error.URLError as exc:
            if self._is_timeout_url_error(exc):
                raise GenerationError(self._timeout_message("Vision generation")) from exc
            raise EngineConnectionError(self._describe_url_error(exc, "vision generation")) from exc
        except (EngineConnectionError, ModelNotLoadedError, UnsupportedModalityError):
            raise
        except Exception as exc:
            if self._is_timeout_error(exc):
                raise GenerationError(self._timeout_message("Vision generation")) from exc
            raise GenerationError(f"Vision generation failed: {exc}") from exc

    def _effective_temperature(self, requested_temperature: float) -> float:
        return _shared_effective_temperature(self, requested_temperature)

    def _effective_top_k(self) -> int | None:
        return _shared_effective_top_k(self)

    def _effective_top_p(self) -> float | None:
        return _shared_effective_top_p(self)

    def _effective_min_p(self) -> float | None:
        return _shared_effective_min_p(self)

    def _effective_repeat_penalty(self) -> float | None:
        return _shared_effective_repeat_penalty(self)

    def _effective_sampler(
        self,
        requested_temperature: float,
        *,
        thinking: bool,
    ) -> dict[str, float | int | None]:
        return _shared_effective_sampler(
            self,
            requested_temperature,
            thinking=thinking,
        )

    def _create_request_reasoning_parser(self) -> DelimitedReasoningParser | None:
        return _create_shared_reasoning_parser(self._current_app_profile_behavior())

    def _extract_request_reasoning(
        self,
        text: str,
        *,
        parser_mode: str,
    ) -> ReasoningExtraction | None:
        return _extract_shared_reasoning(
            text,
            app_profile_behavior=self._current_app_profile_behavior(),
            parser_mode=parser_mode,
            logger=logger,
            context=self._current_request_context(),
            engine_type="ollama",
            model_name=self.model_name,
        )

    def _log_reasoning_parser_fallback(
        self,
        *,
        parser_mode: str,
        reasoning_chars: int,
        visible_chars: int,
    ) -> None:
        _log_shared_reasoning_parser_fallback(
            logger=logger,
            context=self._current_request_context(),
            engine_type="ollama",
            model_name=self.model_name,
            app_profile_behavior=self._current_app_profile_behavior(),
            parser_mode=parser_mode,
            reasoning_chars=reasoning_chars,
            visible_chars=visible_chars,
        )

    @staticmethod
    def _build_messages(
        prompt: str,
        system: str,
        messages: list[EngineMessage] | None,
    ) -> list[dict[str, Any]]:
        if messages:
            normalized: list[dict[str, Any]] = []
            for item in messages:
                role = str(item.get("role", "") or "").strip().lower()
                if not role:
                    continue
                content = str(item.get("content", "") or "").strip()
                raw_tool_calls = item.get("tool_calls") if role == "assistant" else None
                has_tool_calls = isinstance(raw_tool_calls, list) and bool(raw_tool_calls)
                if not content and not has_tool_calls:
                    continue
                if role == "tool":
                    # Keep native tool results as role=tool; only demote
                    # in-band synthetic calls to user messages.
                    call_id = str(item.get("tool_call_id") or "")
                    if call_id.startswith("inband_"):
                        mapped_role = "user"
                    else:
                        mapped_role = "tool"
                elif role in {"system", "user", "assistant"}:
                    mapped_role = role
                else:
                    mapped_role = "user"
                entry: dict[str, Any] = {"role": mapped_role, "content": content}
                raw_images = item.get("images")
                if isinstance(raw_images, list) and (
                    images := [
                        image.as_base64()
                        for image in raw_images
                        if isinstance(image, VisionImage)
                    ]
                ):
                    entry["images"] = images
                # Preserve tool_calls on assistant messages for multi-turn
                if mapped_role == "assistant" and "tool_calls" in item:
                    raw_calls = item["tool_calls"]
                    if isinstance(raw_calls, list) and raw_calls:
                        ollama_calls = []
                        for tc in raw_calls:
                            if isinstance(tc, dict):
                                function_part = tc.get("function")
                                function_dict = (
                                    function_part if isinstance(function_part, dict) else {}
                                )
                                name = function_dict.get("name") or tc.get("name")
                                args = function_dict.get("arguments") or tc.get("arguments", {})
                                if name:
                                    ollama_calls.append(
                                        {"function": {"name": name, "arguments": args}}
                                    )
                        if ollama_calls:
                            entry["tool_calls"] = ollama_calls
                # Preserve tool_call_id on tool messages
                if mapped_role == "tool":
                    for key in ("tool_call_id", "name"):
                        if key in item:
                            entry[key] = item[key]
                normalized.append(entry)
            chat_messages: list[dict[str, Any]] = []
            # Prepend the router-supplied primary system prompt unless the
            # exact prompt already rides in `messages` — other system rows
            # (runtime overlays, a compaction summary) must not suppress it;
            # see contains_primary_system_message. Adjacent system rows are
            # merged below, keeping the primary first.
            if system and not _contains_primary_system_message(normalized, system):
                chat_messages.append({"role": "system", "content": system})
            chat_messages.extend(normalized)
            if chat_messages:
                return _merge_consecutive_system_messages(
                    _demote_non_leading_system_messages(chat_messages)
                )
        chat: list[dict[str, Any]] = []
        if system:
            chat.append({"role": "system", "content": system})
        chat.append({"role": "user", "content": prompt})
        # No demotion here: this no-history fallback builds at most
        # [system, user], so a non-leading system is impossible. Demotion is
        # applied only on the conversation path above, matching the vLLM builder.
        return _merge_consecutive_system_messages(chat)

    @staticmethod
    def _estimate_request_prompt_tokens(data: dict[str, Any]) -> int:
        messages = json.dumps(data.get("messages") or data.get("prompt") or "", ensure_ascii=False)
        tools = json.dumps(data.get("tools") or [], ensure_ascii=False)
        return len(messages) // 4 + len(tools) // 4

    def _remaining_context_tokens(self, prompt_tokens_estimate: int | None) -> int | None:
        effective_ctx = self._get_request_context_length() or self._context_length
        if effective_ctx is None or prompt_tokens_estimate is None:
            return None
        return max(effective_ctx - int(prompt_tokens_estimate) - 512, 1024)

    def _thinking_token_headroom(self, *, remaining_tokens: int | None = None) -> int:
        behavior_headroom = self._current_app_profile_behavior().get("thinking_token_headroom")
        if isinstance(behavior_headroom, int) and behavior_headroom > 0:
            headroom = behavior_headroom
        else:
            profile_headroom = getattr(self, "_profile_thinking_headroom", None)
            if isinstance(profile_headroom, int) and profile_headroom > 0:
                headroom = profile_headroom
            else:
                if self._context_length is not None and self._context_length <= 8192:
                    base = 4096
                else:
                    model_size_b = self._model_size_billions()
                    base = 4096 if model_size_b is not None and model_size_b <= 8.0 else 16384
                # Scale against the window this request is actually served, never the
                # native maximum, which may vastly exceed the configured num_ctx.
                context_length = self._get_request_context_length()
                scaled_headroom = context_length // 4 if context_length else 0
                headroom = scaled_headroom if scaled_headroom > base else base
        if remaining_tokens is None:
            return headroom
        final_reserve = min(self.get_model_max_output_tokens() or 16384, remaining_tokens // 4)
        return max(min(headroom, remaining_tokens - final_reserve), 0)

    def _model_size_billions(self) -> float | None:
        return _model_size_billions_helper(self.model_name)

    def _effective_num_predict(
        self,
        max_tokens: int,
        *,
        thinking: bool,
        remaining_tokens: int | None = None,
    ) -> int:
        num_predict = max_tokens
        if thinking:
            # Ollama shares num_predict across thinking + response.  Inflate
            # the budget so thinking tokens don't consume the response quota.
            headroom = (
                self._thinking_token_headroom(remaining_tokens=remaining_tokens)
                if remaining_tokens is not None
                else self._thinking_token_headroom()
            )
            num_predict = max_tokens + headroom
            effective_ctx = self._get_request_context_length() or self._context_length
            if effective_ctx:
                num_predict = min(num_predict, effective_ctx)
                num_predict = min(num_predict, max(effective_ctx // 2, 32768))
        if remaining_tokens is not None:
            num_predict = min(num_predict, remaining_tokens)
        return num_predict

    def _thinking_budget_tokens(self, max_tokens: int) -> int:
        """Thinking-token room actually available this request: the headroom that
        survives _build_options' num_predict clamps, so no guard is ever sized
        above what the provider will generate."""
        return max(self._effective_num_predict(max_tokens, thinking=True) - max_tokens, 0)

    def _build_options(
        self,
        max_tokens: int,
        temperature: float,
        *,
        thinking: bool = False,
        top_k: int | None = None,
        top_p: float | None = None,
        min_p: float | None = None,
        presence_penalty: float | None = None,
        repeat_penalty: float | None = None,
        prompt_tokens_estimate: int | None = None,
    ) -> dict[str, Any]:
        remaining = self._remaining_context_tokens(prompt_tokens_estimate)
        num_predict = self._effective_num_predict(
            max_tokens,
            thinking=thinking,
            remaining_tokens=remaining,
        )
        options: dict[str, Any] = {"num_predict": num_predict, "temperature": temperature}
        self._apply_configured_num_ctx(options)
        if top_k is not None and top_k > 0:
            options["top_k"] = top_k
        if top_p is not None and 0.0 <= top_p <= 1.0:
            options["top_p"] = top_p
        if min_p is not None and 0.0 <= min_p <= 1.0:
            options["min_p"] = min_p
        if presence_penalty is not None and -2.0 <= presence_penalty <= 2.0:
            options["presence_penalty"] = presence_penalty
        if thinking:
            # App-profile repetition guidance wins (Qwen-style thinking models
            # prescribe repeat_penalty=1.0 - penalties push them into weirder
            # loops, not out of them); 1.15/256 stays as the no-profile
            # fallback for unprofiled models.
            options["repeat_penalty"] = repeat_penalty if repeat_penalty is not None else 1.15
            options["repeat_last_n"] = 256
        elif repeat_penalty is not None:
            options["repeat_penalty"] = repeat_penalty
        return options

    def _build_think_value(self, reasoning_effort: str | None) -> bool | str | None:
        if not self._thinking:
            return None
        if self._debug_option_enabled("disable_thinking"):
            logger.info(
                "Ollama thinking disabled for request-scoped diagnostics override.",
                extra={"model": self.model_name},
            )
            return None
        normalized = str(reasoning_effort or "").strip().lower()
        if supports_ollama_reasoning_levels(self.model_name) or (
            self._current_app_profile_behavior().get("family") == "qwen38"
        ):
            return self._build_qwen38_think_value(normalized)
        if normalized == "none":
            return False
        if normalized not in {"", "default"}:
            # Owner decision 2026-08-31 (CMP-AI-0005): graded efforts exist only
            # for the qwen3.8 family, and a stale level carried over from such a
            # session must degrade to automatic thinking instead of failing the
            # turn. Electron clamps upstream, so this WARN firing means one of
            # those clamps regressed.
            logger.warning(
                "Ollama model %s supports only Automatic or None thinking; "
                "ignoring reasoning effort '%s'.",
                self.model_name,
                normalized,
                extra={"model": self.model_name},
            )
            normalized = "default"
        model_token = str(self.model_name or "").strip().lower().rsplit("/", 1)[-1]
        if model_token.startswith(("qwen3.5", "qwen3.6", "qwen36")):
            return True
        logger.info(
            "Ollama thinking enabled for model '%s' (effort '%s').",
            self.model_name,
            normalized or "default",
            extra={
                "model": self.model_name,
                "thinking_source": self._thinking_capability_source,
            },
        )
        return True

    def _build_qwen38_think_value(self, normalized: str) -> bool | str:
        effort = {
            "": "medium",
            "default": "medium",
            "minimal": "low",
            "low": "low",
            "medium": "medium",
            "high": "high",
            "xhigh": "max",
            "max": "max",
        }.get(normalized)
        if normalized == "none":
            return False
        if effort is None:
            raise GenerationError(
                f"Ollama reasoning effort {normalized!r} is not supported by {self.model_name}."
            )
        logger.info(
            "Ollama thinking enabled for model '%s' (effort '%s').",
            self.model_name,
            effort,
            extra={
                "model": self.model_name,
                "thinking_source": self._thinking_capability_source,
            },
        )
        return effort

    @staticmethod
    def _sanitize_thinking(text: str) -> str:
        return _sanitize_shared_thinking_text(text)

    def _plain_generate_result(
        self,
        *,
        prompt: str,
        max_tokens: int,
        temperature: float,
        reasoning_effort: str | None,
        prompt_cache_enabled: bool,
        system: str,
        messages: list[EngineMessage] | None,
        response_format: ResponseFormat | None,
    ) -> GenerationResult:
        return _ollama_plain_generate_result(
            self,
            prompt=prompt,
            max_tokens=max_tokens,
            temperature=temperature,
            reasoning_effort=reasoning_effort,
            prompt_cache_enabled=prompt_cache_enabled,
            system=system,
            messages=messages,
            response_format=response_format,
        )

    def _note_tool_call_http_400(self, *, streaming: bool) -> None:
        """Degrade only this request after HTTP 400; retry native tools next request."""
        self._tool_call_http_400_streak += 1
        logger.warning(
            "Ollama returned HTTP 400 for %stool-calling (model=%s, consecutive=%d); "
            "falling back to plain generation for this request only.%s",
            "streaming " if streaming else "",
            self.model_name,
            self._tool_call_http_400_streak,
            (
                " This model's template appears to reject tool schemas."
                if self._tool_call_http_400_streak >= 3
                else ""
            ),
        )

    def _fallback_plain_generate_result(
        self,
        *,
        prompt: str,
        tools: list[dict[str, Any]] | None = None,
        max_tokens: int,
        temperature: float,
        reasoning_effort: str | None,
        prompt_cache_enabled: bool,
        system: str,
        messages: list[EngineMessage] | None,
        response_format: ResponseFormat | None,
        degraded: bool = False,
        request_timeout_seconds: float | None = None,
    ) -> GenerationResult:
        try:
            content = (
                self.generate(
                    prompt=prompt,
                    max_tokens=max_tokens,
                    temperature=temperature,
                    reasoning_effort=reasoning_effort,
                    prompt_cache_enabled=prompt_cache_enabled,
                    system=system,
                    messages=messages,
                    response_format=response_format,
                )
                if request_timeout_seconds is None
                else _ollama_generate(
                    self,
                    prompt=prompt,
                    max_tokens=max_tokens,
                    temperature=temperature,
                    reasoning_effort=reasoning_effort,
                    prompt_cache_enabled=prompt_cache_enabled,
                    system=system,
                    messages=messages,
                    response_format=response_format,
                    request_timeout_seconds=request_timeout_seconds,
                )
            )
        except EngineConnectionError as exc:
            raise GenerationError(
                f"Ollama request failed with HTTP {self._extract_http_status(exc) or 'error'} "
                f"without tool-calling: {exc}"
            ) from exc
        except Exception as exc:
            raise GenerationError(f"Ollama request failed without tool-calling: {exc}") from exc
        return self._build_fallback_plain_result(
            content,
            tools=tools,
            degraded=degraded,
        )

    def _fallback_plain_stream_result(  # noqa: PLR0913 - stream contract.
        self,
        *,
        prompt: str,
        tools: list[dict[str, Any]] | None,
        max_tokens: int,
        temperature: float,
        reasoning_effort: str | None,
        prompt_cache_enabled: bool,
        system: str,
        messages: list[EngineMessage] | None,
        response_format: ResponseFormat | None,
        cancel_handle: Any,
        wall_clock_deadline: float | None,
        degraded: bool = False,
    ) -> Generator[StreamChunk, None, GenerationResult]:
        content_parts: list[str] = []
        stream = _ollama_stream(
            self,
            prompt=prompt,
            max_tokens=max_tokens,
            temperature=temperature,
            reasoning_effort=reasoning_effort,
            prompt_cache_enabled=prompt_cache_enabled,
            system=system,
            messages=messages,
            response_format=response_format,
            cancel_handle=cancel_handle,
            wall_clock_deadline=wall_clock_deadline,
        )
        for chunk in stream:
            kind = getattr(chunk, "kind", "")
            if kind == "content":
                content_parts.append(str(getattr(chunk, "text", "") or ""))
            elif kind != "done":
                yield chunk
        result = self._build_fallback_plain_result(
            "".join(content_parts),
            tools=tools,
            degraded=degraded,
        )
        if result.content:
            yield result.content
        return result

    @staticmethod
    def _build_fallback_plain_result(
        content: Any,
        *,
        tools: list[dict[str, Any]] | None,
        degraded: bool,
    ) -> GenerationResult:
        final_content = str(content or "").strip()
        parse_failed = False
        if final_content and tools:
            known_names = frozenset(
                str((tool.get("function") or tool).get("name") or tool.get("name", ""))
                for tool in tools
                if isinstance(tool, dict)
            )
            extraction = extract_inband_tool_calls_detailed(
                final_content,
                known_names,
            )
            parse_failed = extraction.failed_attempt
            if extraction.calls:
                return GenerationResult(
                    content=extraction.remaining_text,
                    tool_calls=extraction.calls,
                    finish_reason="tool_calls",
                    degraded_tool_transport=degraded,
                )
        return GenerationResult(
            content=final_content,
            finish_reason="stop",
            degraded_tool_transport=degraded,
            inband_tool_call_parse_failed=parse_failed,
        )

    @staticmethod
    def _extract_http_status(error: EngineConnectionError) -> int | None:
        current: BaseException | None = error
        while current is not None:
            if isinstance(current, urllib.error.HTTPError):
                return int(current.code)
            current = current.__cause__
        match = _HTTP_STATUS_RE.search(str(error))
        return int(match.group("status")) if match else None
