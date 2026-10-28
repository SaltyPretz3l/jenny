"""Anthropic Messages engine for a user's own Console API key (row 78, P3a).

Raw httpx through ``ProviderHttpService``: no SDK, no subscription sign-in, no
credential file. The descriptor and the model limits arrive already resolved by
Electron and are re-admitted here (``provider_descriptor_v6``); the engine never
probes the provider, counts tokens through it, or sends a sampler field (this API
version rejects them). The key lives only in the pooled client's headers and is
never part of a message or repr. Request shaping is ``api_provider_anthropic_wire``;
SSE parsing is ``api_provider_anthropic_stream``.
"""

from __future__ import annotations

from collections.abc import Callable, Generator
from typing import Any

from sidecar.ai.engines.api_provider_anthropic_stream import (
    AnthropicHttpService,
    check_cancelled,
    run_messages_stream,
)
from sidecar.ai.engines.api_provider_anthropic_wire import (
    ThinkingReplayCache,
    build_request,
    output_cap,
    static_headers,
    thinking_effort,
)
from sidecar.ai.engines.base import (
    BaseEngine,
    EngineMessage,
    ModelModality,
    clamp_timeout_to_deadline,
)
from sidecar.ai.engines.provider_call_finalize import ProviderCallFinalizer
from sidecar.ai.engines.provider_descriptor_v6 import (
    AUTH_HEADER,
    TRANSPORT_ANTHROPIC_MESSAGES,
    ProviderDescriptorError,
    host_resolves_only_to_local_addresses,
    resolved_auth_headers,
    validate_model_id,
    validate_model_limits,
    validate_provider_descriptor,
)
from sidecar.ai.tools.models import GenerationResult, StreamChunk, StreamingEvent
from sidecar.runtime.local_engine.request_context import (
    clear_request_context as _clear_shared_request_context,
)
from sidecar.runtime.local_engine.request_context import (
    consume_provider_call_purpose,
    current_diagnostics_store,
)
from sidecar.runtime.local_engine.request_context import (
    install_request_context as _install_shared_request_context,
)
from sidecar.runtime.local_engine.request_context import request_id as active_request_id

_MODEL_PREFIX = "api-provider"
_REQUEST_TIMEOUT_SECONDS = 300.0
_ENGINE_NOT_READY = "api-provider engine has no model loaded"


def _drain(stream: Generator[StreamChunk, None, GenerationResult]) -> GenerationResult:
    while True:
        try:
            next(stream)
        except StopIteration as stop:
            return stop.value  # type: ignore[no-any-return]


class ApiProviderAnthropicEngine(BaseEngine):
    """Cloud engine for the Anthropic Messages API reached with a user's own API key."""

    _ENGINE_TYPE = "api-provider"
    MODEL_RESIDENCY = "remote"
    # ``usage`` input is input + cache read + cache creation: the whole prompt.
    reports_full_prompt_input_tokens = True

    def __init__(
        self,
        *,
        descriptor: dict[str, Any],
        api_key: str | None,
        limits: dict[str, Any],
        resolve_local: Callable[[str, int | None], bool] = host_resolves_only_to_local_addresses,
    ) -> None:
        admitted = validate_provider_descriptor(descriptor, resolve_local=resolve_local)
        if (
            admitted["transport"] != TRANSPORT_ANTHROPIC_MESSAGES
            or admitted["auth_profile"] != AUTH_HEADER
        ):
            raise ProviderDescriptorError("provider transport unavailable")
        self._limits = validate_model_limits(limits)
        headers = {**resolved_auth_headers(admitted, api_key), **static_headers()}
        self._base_url = str(admitted["endpoint"])
        self._service = AnthropicHttpService(
            provider="api-provider",
            base_url=self._base_url,
            headers=headers,
            timeout_seconds=_REQUEST_TIMEOUT_SECONDS,
        )
        self._DISPLAY_NAME = str(admitted["label"])
        self._provider_id = str(admitted["provider_id"])
        self.model_name: str | None = None
        self._wire_model: str | None = None
        self._context_length: int | None = None
        self._ready = False
        self._replay = ThinkingReplayCache()
        self._turn_diagnostics_store: Any | None = None
        self._local_runtime_capability_sources: dict[str, str] = {}

    # -- capabilities -----------------------------------------------------

    @property
    def supported_modalities(self) -> set[ModelModality]:
        modalities = {ModelModality.TEXT}
        if self._limits["vision"]:
            modalities.add(ModelModality.VISION)
        return modalities

    @property
    def capabilities(self) -> dict[str, bool]:
        return {**super().capabilities, "thinking": bool(self._limits["reasoning"])}

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
        self.model_name = name
        self._wire_model = wire_model
        self._context_length = int(self._limits["context_length"])
        reasoning = bool(self._limits["reasoning"])
        vision = bool(self._limits["vision"])
        self._local_runtime_capability_sources = {
            "text": "engine_default",
            "tool_calling": str(sources["tools"]),
            "thinking": str(sources["reasoning"]) if reasoning else "unsupported",
            "vision": str(sources["vision"]) if vision else "unsupported",
        }
        self._ready = True

    def unload_model(self, _name: str | None = None) -> None:
        self.model_name = None
        self._wire_model = None
        self._context_length = None
        self._ready = False

    def get_model_context_length(self) -> int | None:
        return self._context_length

    get_inference_budget_context_length = get_model_context_length

    def get_model_max_output_tokens(self) -> int | None:
        if self._context_length is None:
            return None
        return output_cap(self._limits, self._context_length)

    def close(self) -> None:
        self._replay.clear()
        self._service.close()

    def __repr__(self) -> str:
        return (
            f"{type(self).__name__}(provider={self._provider_id!r}, "
            f"model={self.model_name!r})"
        )

    # -- request-scoped state ----------------------------------------------

    def set_turn_diagnostics_store(self, store: Any | None) -> None:
        self._turn_diagnostics_store = store

    def begin_request_context(  # noqa: PLR0913 - shared request-context contract.
        self,
        *,
        request_id: str,
        trace_id: str | None = None,
        diagnostics_store: Any | None = None,
        debug_options: dict[str, Any] | None = None,
        mode: str | None = None,
        agent_id: str | None = None,
        agent_depth: int = 0,
        app_profile_behavior: dict[str, Any] | None = None,
    ) -> None:
        _install_shared_request_context(
            self,
            request_id=request_id,
            trace_id=trace_id,
            diagnostics_store=diagnostics_store,
            debug_options=debug_options,
            mode=mode,
            agent_id=agent_id,
            agent_depth=agent_depth,
            app_profile_behavior=app_profile_behavior,
        )

    def clear_request_context(self, *, request_id: str | None = None) -> None:
        # Signed thinking blocks live exactly as long as the request that produced them.
        self._replay.release(str(request_id or "").strip() or active_request_id(self))
        _clear_shared_request_context(self, request_id=request_id)

    def release_request_state(self, request_id: str) -> None:
        self._replay.release(str(request_id or "").strip())

    # -- diagnostics ------------------------------------------------------

    def _record(self, method: str, **kwargs: Any) -> None:
        store = current_diagnostics_store(self)
        request_id = active_request_id(self)
        if store is None or not request_id:
            return
        try:
            getattr(store, method)(request_id=request_id, **kwargs)
        except Exception:  # noqa: BLE001 - diagnostics never break inference.
            pass

    def _complete_provider_request(
        self, *, outcome: str = "completed", finish_reason: str | None = None
    ) -> None:
        self._record("complete_provider_request", outcome=outcome, finish_reason=finish_reason)

    def _record_usage(self, result: GenerationResult) -> None:
        usage = result.usage
        if usage is None:
            return
        self._record(
            "record_provider_usage",
            prompt_eval_count=usage.input_tokens,
            eval_count=usage.output_tokens,
            cached_tokens=usage.raw_usage.get("cache_read_input_tokens"),
            provider_label="api-provider",
        )

    # -- generation -------------------------------------------------------

    def stream_with_tools(  # noqa: PLR0913 - BaseEngine transport contract.
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
        # Provider defaults for every sampler (this API version rejects them), the
        # cache layout is fixed, and the Messages API has no JSON-mode switch.
        _ = (temperature, prompt_cache_enabled, response_format)
        check_cancelled(cancel_handle)
        if not self._ready or self._wire_model is None:
            raise RuntimeError(_ENGINE_NOT_READY)
        thinking, effort = thinking_effort(
            reasoning_effort, supported=bool(self._limits["reasoning"])
        )
        request_key = active_request_id(self)
        cap = self.get_model_max_output_tokens() or max(1, int(max_tokens))
        payload, extra_headers = build_request(
            model=self._wire_model,
            max_tokens=min(int(max_tokens), cap) if int(max_tokens) > 0 else cap,
            system=system,
            prompt=prompt,
            messages=messages,
            tools=tools,
            thinking=thinking,
            effort=effort,
            vision=bool(self._limits["vision"]),
            replay=self._replay.snapshot(request_key),
        )
        self._record(
            "record_provider_request",
            think_enabled=thinking,
            num_predict=payload["max_tokens"],
            temperature=0.0,
            message_count=len(payload["messages"]),
            tool_count=len(payload.get("tools", ())),
            tool_capable=bool(self._limits["tools"]),
            purpose=consume_provider_call_purpose(self) or "turn",
            provider_reasoning_effort=effort,
        )
        finalizer = ProviderCallFinalizer(self)
        try:
            outcome = yield from run_messages_stream(
                self._service,
                payload=payload,
                headers=extra_headers,
                timeout=clamp_timeout_to_deadline(_REQUEST_TIMEOUT_SECONDS, wall_clock_deadline),
                label=self._DISPLAY_NAME,
                model=str(self.model_name),
                emit_thinking=bool(self._limits["reasoning"]),
                cancel_handle=cancel_handle,
                on_first_chunk=lambda: self._record("record_first_chunk"),
            )
            result = outcome.result
            if outcome.replay_blocks and request_key:
                self._replay.store(
                    request_key, [call.call_id for call in result.tool_calls], outcome.replay_blocks
                )
            if result.content:
                self._record("record_visible_output", text=result.content)
            self._record_usage(result)
            finalizer.finish_reason = result.finish_reason
            finalizer.finalize(cancel_handle=cancel_handle)
            yield StreamingEvent(
                kind="done", finish_reason=result.finish_reason, usage=result.usage
            )
            return result
        finally:
            finalizer.finalize(cancel_handle=cancel_handle)

    def stream(  # noqa: PLR0913 - BaseEngine transport contract.
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
        yield from self.stream_with_tools(
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
            wall_clock_deadline=wall_clock_deadline,
        )

    def generate(  # noqa: PLR0913 - BaseEngine transport contract.
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
        return self.generate_with_tools(
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
        ).content

    def generate_with_tools(  # noqa: PLR0913 - BaseEngine transport contract.
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
        return _drain(
            self.stream_with_tools(
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
            )
        )
