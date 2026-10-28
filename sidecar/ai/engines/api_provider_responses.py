"""OpenAI Responses engine for a user's own API-key provider (row 78, P3b).

A thin subclass of :class:`~sidecar.ai.engines.chatgpt_subscription.ChatGPTSubscriptionEngine`:
it reuses the Responses request builder, the SSE folding, the in-band failure
mapping and the stateless reasoning-replay cache, and changes only what differs
from the ChatGPT backend. The request carries the user's bearer key and nothing
that identifies Jenny as the Codex client (no ``originator``, no account
header), the model id is the provider's wire id, and the output cap and
reasoning fields follow the limits Electron resolved. ``store`` stays false and
the encrypted reasoning is requested, so tool loops replay statelessly. The
descriptor and limits are re-admitted here (``provider_descriptor_v6``); the
engine never probes ``/models`` and never puts the key in a message or repr.
"""

from __future__ import annotations

import dataclasses
from collections.abc import Callable, Generator
from typing import Any

from sidecar.ai.engines.api_provider_http import (
    API_PROVIDER_LABEL,
    ProviderHttpError,
    raise_for_provider_status,
)
from sidecar.ai.engines.base import ModelModality
from sidecar.ai.engines.chatgpt_subscription import ChatGPTSubscriptionEngine
from sidecar.ai.engines.provider_descriptor_v6 import (
    AUTH_BEARER,
    TRANSPORT_RESPONSES,
    ProviderDescriptorError,
    host_resolves_only_to_local_addresses,
    resolved_auth_headers,
    validate_model_id,
    validate_model_limits,
    validate_provider_descriptor,
)
from sidecar.ai.exceptions import GenerationError
from sidecar.ai.tools.models import GenerationResult, StreamChunk

_MODEL_PREFIX = "api-provider"
_MAX_OUTPUT_CEILING = 32_768
# The public API rejects a smaller ``max_output_tokens``.
_MIN_OUTPUT_TOKENS = 16
_EFFORT_LEVELS = {
    "minimal": "minimal",
    "low": "low",
    "medium": "medium",
    "high": "high",
    "xhigh": "high",
    "max": "high",
}
_TOOL_FIELDS = ("tools", "tool_choice", "parallel_tool_calls")


class ApiProviderResponsesEngine(ChatGPTSubscriptionEngine):
    """Cloud engine for the OpenAI Responses API with a user's own key."""

    _ENGINE_TYPE = "api-provider"
    _PROVIDER_LABEL = API_PROVIDER_LABEL
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
        if admitted["transport"] != TRANSPORT_RESPONSES or admitted["auth_profile"] != AUTH_BEARER:
            raise ProviderDescriptorError("provider transport unavailable")
        admitted_limits = validate_model_limits(limits)
        headers = {
            **resolved_auth_headers(admitted, api_key),
            "Accept": "text/event-stream",
            "Content-Type": "application/json",
        }
        endpoint = str(admitted["endpoint"])
        super().__init__(
            model="",
            access_token="",
            account_id=None,
            base_url=endpoint,
            headers_override=headers,
        )
        # Same pooled client, retitled so diagnostics name the provider, not ChatGPT.
        self._service.close()
        self._service = type(self._service)(
            provider=API_PROVIDER_LABEL,
            base_url=endpoint,
            headers=headers,
            timeout_seconds=self._timeout_seconds,
        )
        self.model_name = ""
        self._PROVIDER_DISPLAY = str(admitted["label"])
        self._provider_id = str(admitted["provider_id"])
        self._limits = admitted_limits
        self._wire_model: str | None = None

    # -- capabilities -----------------------------------------------------

    @property
    def supported_modalities(self) -> set[ModelModality]:
        modalities = {ModelModality.TEXT}
        if self._limits["vision"]:
            modalities.add(ModelModality.VISION)
        return modalities

    @property
    def capabilities(self) -> dict[str, bool]:
        modalities = self.supported_modalities
        return {
            "text": ModelModality.TEXT in modalities,
            "vision": ModelModality.VISION in modalities,
            "thinking": bool(self._limits["reasoning"]),
        }

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
        sources = self._limits["sources"]
        reasoning = bool(self._limits["reasoning"])
        vision = bool(self._limits["vision"])
        self.model_name = name
        self._wire_model = wire_model
        self._local_runtime_capability_sources = {
            "text": "engine_default",
            "tool_calling": str(sources["tools"]),
            "thinking": str(sources["reasoning"]) if reasoning else "unsupported",
            "vision": str(sources["vision"]) if vision else "unsupported",
        }

    def unload_model(self, _name: str | None = None) -> None:
        self.model_name = ""
        self._wire_model = None

    def get_model_context_length(self) -> int:
        return int(self._limits["context_length"])

    get_inference_budget_context_length = get_model_context_length

    def get_model_max_output_tokens(self) -> int:
        return min(
            int(self._limits["max_output_tokens"]),
            _MAX_OUTPUT_CEILING,
            self.get_model_context_length() // 2,
        )

    # -- request shaping --------------------------------------------------

    def _finalize_payload(
        self,
        payload: dict[str, Any],
        *,
        max_tokens: int,
        reasoning_effort: str | None,
    ) -> dict[str, Any]:
        """Adapt the shared Responses body to the public API and the resolved limits."""
        payload["model"] = self._wire_model
        if not payload.get("tools"):
            for field in _TOOL_FIELDS:
                payload.pop(field, None)
        if not payload.get("instructions"):
            payload.pop("instructions", None)
        if self._limits["reasoning"]:
            reasoning = {"summary": "auto"}
            effort = _EFFORT_LEVELS.get(str(reasoning_effort or "").strip().lower())
            if effort is not None:
                reasoning["effort"] = effort
            payload["reasoning"] = reasoning
        else:
            payload.pop("reasoning", None)
            payload.pop("include", None)
        limit = self.get_model_max_output_tokens()
        requested = int(max_tokens or 0)
        cap = min(requested, limit) if requested > 0 else limit
        payload["max_output_tokens"] = max(_MIN_OUTPUT_TOKENS, cap)
        return payload

    def stream_with_tools(
        self, *args: Any, **kwargs: Any
    ) -> Generator[StreamChunk, None, GenerationResult]:
        if self._wire_model is None:
            raise GenerationError("provider model not loaded")
        try:
            result = yield from super().stream_with_tools(*args, **kwargs)
        except ProviderHttpError as error:
            raise self._rebranded_http_error(error) from error
        except GenerationError as error:
            raise self._rebranded_generation_error(error) from error
        usage = result.usage
        if usage is None:
            return result
        # The shared folding labels usage as ChatGPT; this one is the user's provider.
        usage = dataclasses.replace(usage, provider=API_PROVIDER_LABEL, model=self.model_name)
        return dataclasses.replace(result, usage=usage)

    # -- status mapping ---------------------------------------------------

    def _rebranded_generation_error(self, error: GenerationError) -> GenerationError:
        """Same code, retryability and preservation; only the provider name in the text changes."""
        rebranded = GenerationError(self._rebranded(error.message), retryable=error.retryable)
        rebranded.code = error.code
        rebranded.preserved = error.preserved
        rebranded.args = (f"[{error.code}] {rebranded.message}",)
        return rebranded

    def _rebranded(self, message: str) -> str:
        """The shared stream names ChatGPT in its error text; name the user's provider."""
        return message.replace("ChatGPT", self._PROVIDER_DISPLAY)

    def _rebranded_http_error(self, error: ProviderHttpError) -> ProviderHttpError:
        if error.provider == API_PROVIDER_LABEL:
            return error
        return ProviderHttpError(
            provider=API_PROVIDER_LABEL,
            status_code=error.status_code,
            code=error.code,
            message=self._rebranded(str(error)),
            retryable=error.retryable,
            classification=error.classification,
            body=error.body,
            retry_after_seconds=error.retry_after_seconds,
        )

    def _raise_for_initial_status(self, response: Any) -> None:
        """Typed provider errors for the initial status; the provider body never escapes."""
        raise_for_provider_status(response, label=self._PROVIDER_DISPLAY)

    def __repr__(self) -> str:
        return (
            f"{type(self).__name__}(provider={self._provider_id!r}, "
            f"model={self.model_name!r})"
        )


__all__ = ["ApiProviderResponsesEngine"]
