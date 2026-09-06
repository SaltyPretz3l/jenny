"""Unmanaged OpenAI-compatible HTTP engine.

Thin subclass of :class:`~sidecar.ai.engines.vllm_engine.VLLMEngine` that
reuses the same HTTP request/streaming/tool-calling/reasoning pipeline
but points at a user-run server exposing the OpenAI REST shape
(``/v1/chat/completions``, ``/v1/models``). Typical use: a local
``llama-server`` (from llama.cpp) serving a GGUF quant, or any other
drop-in OpenAI-compatible process the user manages themselves.

The engine is deliberately protocol-scoped — "OpenAI-compatible" here
refers only to the HTTP schema, NOT to any cloud provider integration.
No cloud credentials, no Anthropic/OpenAI API keys, no telemetry.
"""

from __future__ import annotations

from typing import Any

from sidecar.ai.engines.base import EngineMessage
from sidecar.ai.engines.model_name import is_qwen38_model
from sidecar.ai.engines.vllm_engine import VLLMEngine

_OPENAI_COMPAT_DEFAULT_BASE_URL = "http://127.0.0.1:8033/v1"

_QWEN38_LLAMA_EFFORT_MAP = {
    "default": "medium",
    "minimal": "low",
    "low": "low",
    "medium": "medium",
    "high": "xhigh",
    "xhigh": "xhigh",
    "max": "xhigh",
}


class OpenAICompatibleEngine(VLLMEngine):
    """OpenAI-compatible local HTTP engine (e.g. llama-server, vLLM, TGI)."""

    _PROVIDER_LABEL = "openai-compatible"
    _DEFAULT_BASE_URL = _OPENAI_COMPAT_DEFAULT_BASE_URL
    _ENGINE_TYPE = "openai-compatible"
    _DISPLAY_NAME = "OpenAI-compatible server"
    _START_COMMAND_HINT = "your OpenAI-compatible server (e.g. llama-server, vllm, tgi)"

    def __init__(
        self,
        *,
        host: str | None = None,
        api_key: str | None = None,
        configured_context_length: int | None = None,
        profile_max_output_tokens: int | None = None,
        profile_thinking_headroom: int | None = None,
    ) -> None:
        headers = {"Authorization": f"Bearer {api_key}"} if api_key else None
        super().__init__(host=host, headers=headers)
        self._configured_context_length = _positive_int(configured_context_length)
        self._profile_max_output_tokens = _positive_int(profile_max_output_tokens)
        self._profile_thinking_headroom = _positive_int(profile_thinking_headroom) or 0

    def get_configured_context_length(self) -> int | None:
        # /props reports the window requests are actually served with; Electron's
        # value is the fallback when the probe fails. Keep this getter subclass-only:
        # resolve_context_window_hint treats its presence as stamping a real request
        # window, which holds for llama-server but not a generic vLLM endpoint.
        return _positive_int(self._served_context_length) or self._configured_context_length

    def get_model_max_output_tokens(self) -> int | None:
        return self._profile_max_output_tokens

    def get_request_output_reservation(
        self,
        reasoning_effort: str | None = None,
    ) -> int | None:
        final_tokens = self.get_model_max_output_tokens()
        if final_tokens is None:
            return None
        requested = str(reasoning_effort or "default").strip().lower() or "default"
        if requested == "none" or not is_qwen38_model(self.model_name):
            return final_tokens
        return final_tokens + self._profile_thinking_headroom

    def _build_payload(  # noqa: PLR0913 - inherited provider payload contract.
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
        payload = super()._build_payload(
            prompt=prompt,
            max_tokens=max_tokens,
            temperature=temperature,
            reasoning_effort=reasoning_effort,
            prompt_cache_enabled=prompt_cache_enabled,
            system=system,
            messages=messages,
            response_format=response_format,
        )
        if not is_qwen38_model(self.model_name):
            return payload

        requested = str(reasoning_effort or "default").strip().lower() or "default"
        template_kwargs: dict[str, Any] = {}
        if requested == "none":
            template_kwargs["enable_thinking"] = False
            payload["reasoning_effort"] = "none"
            thinking = False
        else:
            resolved = _QWEN38_LLAMA_EFFORT_MAP.get(requested)
            if resolved is None:
                raise ValueError(f"Unsupported Qwen3.8 reasoning effort: {requested}")
            template_kwargs.update(
                {
                    "enable_thinking": True,
                    "reasoning_effort": resolved,
                }
            )
            payload["reasoning_effort"] = resolved
            thinking = True
        sampler = self._effective_sampler(temperature, thinking=thinking)
        for key in (
            "temperature",
            "top_k",
            "top_p",
            "min_p",
            "presence_penalty",
            "repeat_penalty",
        ):
            value = sampler.get(key)
            if value is not None:
                payload[key] = value
        if thinking and self._profile_thinking_headroom:
            combined_max = int(max_tokens) + self._profile_thinking_headroom
            if self._configured_context_length is not None:
                combined_max = min(combined_max, self._configured_context_length)
            payload["max_tokens"] = combined_max
        payload["chat_template_kwargs"] = template_kwargs
        return payload

    def _build_not_reachable_message(self) -> str:
        return (
            f"{self._DISPLAY_NAME} is not reachable at {self._base_url}. "
            f"Ensure {self._START_COMMAND_HINT} is running and accessible."
        )

    def _build_not_serving_message(self, requested: str, available: str) -> str:
        return (
            f"{self._DISPLAY_NAME} at {self._base_url} is not serving model "
            f"'{requested}'. Available models: {available}. "
            f"Restart {self._START_COMMAND_HINT} with the desired model."
        )


def _positive_int(value: int | None) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        return None
    return value


__all__ = ["OpenAICompatibleEngine"]
