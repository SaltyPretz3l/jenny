"""OpenAI Chat Completions engine for a user's own API-key provider (row 78, S1).

A thin cloud subclass of :class:`~sidecar.ai.engines.vllm_engine.VLLMEngine`: it
reuses the vLLM SSE, tool-call and reasoning pipeline but none of the local
server behaviour. The descriptor and the model limits arrive already resolved
by Electron and are re-admitted here (``provider_descriptor_v6``); this engine
never probes ``/models`` or ``/props``, never counts tokens through the
provider, and never fits output to a window it did not measure. The key lives
only in the pooled client's headers and is never part of a message or repr.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from sidecar.ai.engines.api_provider_http import raise_for_provider_status
from sidecar.ai.engines.base import EngineMessage
from sidecar.ai.engines.provider_descriptor_v6 import (
    TRANSPORT_CHAT_COMPLETIONS,
    ProviderDescriptorError,
    host_resolves_only_to_local_addresses,
    resolved_auth_headers,
    validate_model_id,
    validate_model_limits,
    validate_provider_descriptor,
)
from sidecar.ai.engines.provider_http import ProviderHttpService
from sidecar.ai.engines.vllm_engine import _REQUEST_TIMEOUT_SECONDS, VLLMEngine
from sidecar.runtime.vllm_engine_support import _build_messages

_MODEL_PREFIX = "api-provider"
_MAX_OUTPUT_CEILING = 32_768
_EFFORT_LEVELS = {
    "minimal": "minimal",
    "low": "low",
    "medium": "medium",
    "high": "high",
    "xhigh": "high",
    "max": "high",
}


class ApiProviderChatEngine(VLLMEngine):
    """Cloud engine for any OpenAI-Chat-Completions-compatible hosted service."""

    _PROVIDER_LABEL = "api-provider"
    _ENGINE_TYPE = "api-provider"
    MODEL_RESIDENCY = "remote"

    def __init__(
        self,
        *,
        descriptor: dict[str, Any],
        api_key: str | None,
        limits: dict[str, Any],
        resolve_local: Callable[[str, int | None], bool] = host_resolves_only_to_local_addresses,
    ) -> None:
        admitted = validate_provider_descriptor(descriptor, resolve_local=resolve_local)
        if admitted["transport"] != TRANSPORT_CHAT_COMPLETIONS:
            raise ProviderDescriptorError("provider transport unavailable")
        admitted_limits = validate_model_limits(limits)
        headers = resolved_auth_headers(admitted, api_key)
        endpoint = str(admitted["endpoint"])
        # VLLMEngine appends ``/v1``; a provider endpoint is used verbatim (Gemini's
        # ends in ``/v1beta/openai``), so the base URL and pooled client are replaced.
        super().__init__(host=endpoint, headers=headers)
        self._service.close()
        self._base_url = endpoint
        self._service = ProviderHttpService(
            provider=self._PROVIDER_LABEL,
            base_url=endpoint,
            headers=headers,
            timeout_seconds=_REQUEST_TIMEOUT_SECONDS,
        )
        self._DISPLAY_NAME = str(admitted["label"])
        self._provider_id = str(admitted["provider_id"])
        self._token_limit_field = str(admitted["token_limit_field"])
        self._limits = admitted_limits
        self._wire_model: str | None = None

    # -- capabilities -----------------------------------------------------

    @property
    def supports_tool_calling(self) -> bool:
        return bool(self._limits["tools"])

    # -- model lifecycle --------------------------------------------------

    def load_model(self, model_path: str) -> None:
        """Bind the namespaced model id. No network I/O: the limits are already resolved."""
        name = str(model_path or "")
        prefix = f"{_MODEL_PREFIX}/{self._provider_id}/"
        if not name.startswith(prefix):
            raise ValueError("model id does not belong to this provider")
        wire_model = validate_model_id(name[len(prefix) :])
        limits = self._limits
        sources = limits["sources"]
        self.model_name = name
        self._wire_model = wire_model
        self._context_length = int(limits["context_length"])
        self._thinking = bool(limits["reasoning"])
        self._vision = bool(limits["vision"])
        self._local_runtime_capability_sources = {
            "text": "engine_default",
            "tool_calling": str(sources["tools"]),
            "thinking": str(sources["reasoning"]) if self._thinking else "unsupported",
            "vision": str(sources["vision"]) if self._vision else "unsupported",
        }
        self._ready = True

    def unload_model(self, _name: str | None = None) -> None:
        super().unload_model(_name)
        self._wire_model = None

    def get_model_context_length(self) -> int | None:
        return self._context_length

    get_inference_budget_context_length = get_model_context_length

    def get_model_max_output_tokens(self) -> int | None:
        if self._context_length is None:
            return None
        return min(
            int(self._limits["max_output_tokens"]),
            _MAX_OUTPUT_CEILING,
            self._context_length // 2,
        )

    # -- request shaping --------------------------------------------------

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
        # Provider defaults for every sampler (as the ChatGPT engine does), so the
        # temperature and prompt-cache arguments are deliberately unused.
        _ = (temperature, prompt_cache_enabled)
        payload: dict[str, Any] = {
            "model": self._wire_model,
            "messages": _build_messages(prompt=prompt, system=system, messages=messages),
            self._token_limit_field: max_tokens,
        }
        effort = _EFFORT_LEVELS.get(str(reasoning_effort or "").strip().lower())
        if effort is not None and self._limits["reasoning"]:
            payload["reasoning_effort"] = effort
        if (
            response_format is not None
            and getattr(response_format, "is_json", False)
            and not getattr(self, "_json_response_format_unsupported", False)
        ):
            payload["response_format"] = self._json_response_format(response_format)
        return payload

    def _fit_output_to_window(self, payload: dict[str, Any]) -> int:
        return int(payload.get(self._token_limit_field) or 0)

    # -- status mapping ---------------------------------------------------

    def _raise_for_stream_status(self, response: Any) -> None:
        """Typed provider errors for the initial status; the provider body never escapes."""
        raise_for_provider_status(response, label=self._DISPLAY_NAME)

    def __repr__(self) -> str:
        return (
            f"{type(self).__name__}(provider={self._provider_id!r}, "
            f"model={self.model_name!r})"
        )
