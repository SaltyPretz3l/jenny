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

import json
from typing import Any

from sidecar.ai.engines.base import EngineMessage
from sidecar.ai.engines.model_name import (
    is_bonsai2_model,
    is_ornith15_model,
    uses_qwen38_chat_contract,
)
from sidecar.ai.engines.vllm_engine import VLLMEngine

_OPENAI_COMPAT_DEFAULT_BASE_URL = "http://127.0.0.1:8033/v1"

# Output room left after the prompt: the same chars/4 estimate, 512-token
# margin and 1,024-token floor as Ollama's ``_remaining_context_tokens``. The
# floor matches TokenBudget's minimum reservation. An attached image counts a
# fixed share instead of its base64 length.
_PROMPT_ESTIMATE_MARGIN_TOKENS = 512
_MIN_OUTPUT_ROOM_TOKENS = 1_024
_IMAGE_PROMPT_TOKENS_ESTIMATE = 1_024

_QWEN38_LLAMA_EFFORT_MAP = {
    "default": "medium",
    "minimal": "low",
    "low": "low",
    "medium": "medium",
    "high": "xhigh",
    "xhigh": "xhigh",
    "max": "xhigh",
}
# Bonsai 2's card: `low` is unsupported and behaves close to `xhigh`. The cheap
# efforts background callers send (`minimal`, `low`) turn thinking off instead
# of becoming a thinking turn, and `low` is never sent.
_BONSAI2_THINKING_OFF_EFFORTS = frozenset({"none", "minimal", "low"})
_BONSAI2_LLAMA_EFFORT_MAP = {
    "default": "medium",
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

    def get_inference_budget_context_length(self) -> int | None:
        # This subclass may inflate output for reasoning beyond its served hint.
        # Do not inherit plain vLLM's enforceable-ceiling claim.
        return None

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

    def set_profile_output_limits(
        self,
        *,
        max_output_tokens: int | None,
        thinking_headroom: int | None,
    ) -> None:
        """Adopt the app profile's limits, which resolve after the model loads."""
        self._profile_max_output_tokens = _positive_int(max_output_tokens)
        self._profile_thinking_headroom = _positive_int(thinking_headroom) or 0

    def get_configured_context_length(self) -> int | None:
        # /props reports the window requests are actually served with; Electron's
        # value is the fallback when the probe fails. Keep this getter subclass-only:
        # resolve_context_window_hint treats its presence as stamping a real request
        # window, which holds for llama-server but not a generic vLLM endpoint.
        return _positive_int(self._served_context_length) or self._configured_context_length

    @staticmethod
    def _detect_thinking(model_name: str) -> bool:
        # Every Qwen3.8-contract name gets `enable_thinking`, including separator
        # variants (`Ternary_Bonsai_2_27B`) the prefix lists miss; keep their
        # reasoning output visible. Ornith 1.5 reasons natively too (dogfood
        # TR-018): unrecognised, its reasoning was dropped and no guard ran.
        return (
            VLLMEngine._detect_thinking(model_name)
            or uses_qwen38_chat_contract(model_name)
            or is_ornith15_model(model_name)
        )

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
        if not uses_qwen38_chat_contract(self.model_name) or _thinking_disabled(
            self.model_name, requested
        ):
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
        requested = str(reasoning_effort or "default").strip().lower() or "default"
        if not uses_qwen38_chat_contract(self.model_name):
            if requested == "none" and is_ornith15_model(self.model_name):
                # Ornith 1.5's template reads no effort level, only
                # enable_thinking; false renders an empty think block. The
                # top-level effort alone left None (and the wind-down legs that
                # send it) thinking at full length (dogfood FG-010).
                payload["chat_template_kwargs"] = {"enable_thinking": False}
            return payload

        template_kwargs: dict[str, Any] = {}
        if _thinking_disabled(self.model_name, requested):
            template_kwargs["enable_thinking"] = False
            payload["reasoning_effort"] = "none"
            thinking = False
        else:
            resolved = _resolve_llama_effort(self.model_name, requested)
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
            # Fitted to the prompt's leftover room once the payload is final.
            payload["max_tokens"] = int(max_tokens) + self._profile_thinking_headroom
        payload["chat_template_kwargs"] = template_kwargs
        return payload

    def _fit_output_to_window(self, payload: dict[str, Any]) -> int:
        """Clamp the wire ``max_tokens`` to the room the prompt leaves.

        llama-server rejects a request whose prompt plus ``max_tokens`` exceeds
        its slot, and final + thinking headroom can equal the whole window.
        """
        requested = int(payload.get("max_tokens") or 0)
        window = self.get_configured_context_length()
        if window is None or requested <= 0:
            return requested
        room = window - _estimate_prompt_tokens(payload) - _PROMPT_ESTIMATE_MARGIN_TOKENS
        fitted = min(requested, max(room, _MIN_OUTPUT_ROOM_TOKENS), window)
        payload["max_tokens"] = fitted
        return fitted

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


def _thinking_disabled(model_name: str | None, requested: str) -> bool:
    """Return whether ``requested`` turns the Qwen3.8-contract template's thinking off."""
    if is_bonsai2_model(model_name):
        return requested in _BONSAI2_THINKING_OFF_EFFORTS
    return requested == "none"


def _resolve_llama_effort(model_name: str | None, requested: str) -> str:
    """Map a Jenny effort onto the levels this Qwen3.8-contract template accepts."""
    if is_bonsai2_model(model_name):
        family, effort_map = "Bonsai 2", _BONSAI2_LLAMA_EFFORT_MAP
    else:
        family, effort_map = "Qwen3.8", _QWEN38_LLAMA_EFFORT_MAP
    resolved = effort_map.get(requested)
    if resolved is None:
        raise ValueError(f"Unsupported {family} reasoning effort: {requested}")
    return resolved


def _estimate_prompt_tokens(payload: dict[str, Any]) -> int:
    """chars/4 estimate of the messages and tool schemas the server will template."""
    chars = len(json.dumps(payload.get("tools") or [], ensure_ascii=False, default=str))
    images = 0
    for message in payload.get("messages") or ():
        if not isinstance(message, dict):
            continue
        for key, value in message.items():
            if key != "content" or not isinstance(value, list):
                chars += len(json.dumps(value, ensure_ascii=False, default=str))
                continue
            for block in value:
                if isinstance(block, dict) and block.get("type") == "image_url":
                    images += 1
                else:
                    chars += len(json.dumps(block, ensure_ascii=False, default=str))
    return chars // 4 + images * _IMAGE_PROMPT_TOKENS_ESTIMATE


def _positive_int(value: int | None) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        return None
    return value


__all__ = ["OpenAICompatibleEngine"]
