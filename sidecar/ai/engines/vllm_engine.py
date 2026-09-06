# ruff: noqa: PLC0415, PLR0913
"""vLLM inference engine using the OpenAI-compatible HTTP API."""

from __future__ import annotations

import logging
from typing import Any

from sidecar.ai.engines.base import BaseEngine, ModelModality
from sidecar.ai.engines.local_server_props import (
    context_length_from_props,
    probe_server_modalities,
    vision_from_props,
)
from sidecar.ai.engines.model_name import (
    THINKING_MODEL_PREFIXES,
    VLLM_VISION_MODEL_PREFIXES,
    canonical_model_token,
    model_token_matches,
)
from sidecar.ai.engines.provider_http import ProviderHttpService
from sidecar.ai.engines.vllm_engine_generation import _VLLMGenerationMixin
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
    reasoning_output_enabled as _shared_reasoning_output_enabled,
)
from sidecar.runtime.local_engine.request_context import (
    clear_request_context as _clear_shared_request_context,
)
from sidecar.runtime.local_engine.request_context import (
    current_app_profile_behavior as _shared_current_app_profile_behavior,
)
from sidecar.runtime.local_engine.request_context import current_diagnostics_store
from sidecar.runtime.local_engine.request_context import (
    current_request_context as _shared_current_request_context,
)
from sidecar.runtime.local_engine.request_context import (
    effective_min_p as _shared_effective_min_p,
)
from sidecar.runtime.local_engine.request_context import (
    effective_presence_penalty as _shared_effective_presence_penalty,
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
from sidecar.runtime.local_engine.request_context import (
    install_request_context as _install_shared_request_context,
)
from sidecar.runtime.vllm_engine_support import (
    DelimitedReasoningParser,
    EngineConnectionError,
    ModelNotLoadedError,
    ReasoningExtraction,
    strip_known_reasoning_blocks,
    strip_known_reasoning_markers,
)

logger = logging.getLogger(__name__)

# IPv4 literal; see catalog.py for the Windows IPv6 rationale.
_VLLM_DEFAULT_BASE_URL = "http://127.0.0.1:8000/v1"
_HEALTH_TIMEOUT_SECONDS = 3.0
_REQUEST_TIMEOUT_SECONDS = 120.0


def _resolve_base_url(host: str | None, *, default: str = _VLLM_DEFAULT_BASE_URL) -> str:
    normalized = str(host or "").strip().rstrip("/")
    if not normalized:
        return default
    if not normalized.endswith("/v1"):
        normalized = f"{normalized}/v1"
    return normalized


def _model_matches(requested: str, served: str) -> bool:
    """Check whether the requested model name matches the served model."""
    req = requested.strip().lower()
    srv = served.strip().lower()
    if req == srv:
        return True
    if srv.endswith(f"/{req}"):
        return True
    if req.endswith(f"/{srv}"):
        return True
    return canonical_model_token(requested) == canonical_model_token(served)


class VLLMEngine(_VLLMGenerationMixin, BaseEngine):
    """vLLM inference engine using the OpenAI-compatible REST API."""

    # Provider identity — subclasses may override to reuse this engine's
    # wiring against a different OpenAI-compatible HTTP backend.
    _PROVIDER_LABEL: str = "vllm"
    _DEFAULT_BASE_URL: str = _VLLM_DEFAULT_BASE_URL
    _ENGINE_TYPE: str = "vllm"
    _DISPLAY_NAME: str = "vLLM"
    _START_COMMAND_HINT: str = "vllm serve <model>"

    def __init__(
        self,
        *,
        host: str | None = None,
        headers: dict[str, str] | None = None,
    ) -> None:
        self._base_url = _resolve_base_url(host, default=self._DEFAULT_BASE_URL)
        self._headers = dict(headers or {})
        self._service = ProviderHttpService(
            provider=self._PROVIDER_LABEL,
            base_url=self._base_url,
            headers=self._headers,
            timeout_seconds=_REQUEST_TIMEOUT_SECONDS,
        )
        self._ready = False
        self.model_name: str | None = None
        self._context_length: int | None = None
        self._served_context_length: int | None = None
        self._thinking = False
        self._vision = False
        self._turn_diagnostics_store: Any | None = None
        self._local_runtime_capability_sources: dict[str, str] = {
            "text": "engine_default",
            "tool_calling": "engine_default",
            "thinking": "unsupported",
            "vision": "unsupported",
        }

    # -- properties --------------------------------------------------------

    @property
    def supported_modalities(self) -> set[ModelModality]:
        mods: set[ModelModality] = {ModelModality.TEXT}
        if self._vision:
            mods.add(ModelModality.VISION)
        return mods

    @property
    def supports_tool_calling(self) -> bool:
        return True

    @property
    def capabilities(self) -> dict[str, bool]:
        caps = super().capabilities
        caps["thinking"] = self._thinking
        return caps

    def set_turn_diagnostics_store(self, store: Any | None) -> None:
        self._turn_diagnostics_store = store

    def set_provider_capability_profile_store(self, store: Any | None) -> None:
        self._provider_capability_profile_store = store

    def begin_request_context(
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
            tracked_flags=("first_chunk_logged", "reasoning_parser_logged"),
        )

    def clear_request_context(self, *, request_id: str | None = None) -> None:
        _clear_shared_request_context(self, request_id=request_id)

    # -- model lifecycle ---------------------------------------------------

    def load_model(self, model_path: str) -> None:
        name = str(model_path or "").strip()
        if not name:
            raise ValueError("model_path must not be empty")
        try:
            models = self._query_models()
            if models is None:
                raise EngineConnectionError(self._build_not_reachable_message())

            served = [str(m.get("id", "")) for m in models if isinstance(m, dict)]
            matched = next((s for s in served if _model_matches(name, s)), None)
            if matched is None:
                available = ", ".join(served) if served else "(none)"
                raise EngineConnectionError(self._build_not_serving_message(name, available))

            self.model_name = matched
            self._context_length = self._extract_context_length(models, matched)
            self._thinking = self._detect_thinking(matched)
            props = probe_server_modalities(base_url=self._base_url, headers=self._headers)
            props_vision = vision_from_props(props)
            self._served_context_length = context_length_from_props(props)
            self._vision = (
                props_vision if props_vision is not None else self._detect_vision(matched)
            )
            self._local_runtime_capability_sources = {
                "text": "engine_default",
                "tool_calling": "engine_default",
                "thinking": "model_name" if self._thinking else "unsupported",
                "vision": "server_props" if props_vision is not None else "model_name",
            }
            self._ready = True
            logger.info("%s: model '%s' ready.", type(self).__name__, matched)
        except Exception as exc:
            self._record_capability_probe_failure(name, exc)
            raise
        self._record_capability_probe_success(matched)

    def _record_capability_probe_success(self, model_name: str) -> None:
        store = getattr(self, "_provider_capability_profile_store", None)
        if store is None:
            return
        try:
            from sidecar.runtime.provider_capability_profile import (
                PROBE_STATUS_READY,
                ProviderCapabilityFeatures,
                ProviderCapabilityObserved,
                derive_endpoint_id,
            )

            store.record_probe_result(
                endpoint_id=derive_endpoint_id(self._ENGINE_TYPE, self._base_url),
                model_id=model_name,
                features=ProviderCapabilityFeatures(
                    chat_supported=True,
                    streaming_supported=True,
                    native_tools_supported=False,
                    thinking_or_reasoning_supported=bool(self._thinking),
                ),
                observed=ProviderCapabilityObserved(
                    max_context_advertised=self._context_length,
                ),
                probe_status=PROBE_STATUS_READY,
            )
        except Exception:  # noqa: BLE001
            pass

    def _record_capability_probe_failure(
        self, model_name: str, error: BaseException
    ) -> None:
        store = getattr(self, "_provider_capability_profile_store", None)
        if store is None:
            return
        try:
            from sidecar.runtime.provider_capability_profile import derive_endpoint_id

            store.mark_failed(
                endpoint_id=derive_endpoint_id(self._ENGINE_TYPE, self._base_url),
                model_id=model_name or "unknown",
                reason=f"{type(error).__name__}: {str(error)[:120]}",
            )
        except Exception:  # noqa: BLE001
            pass

    # -- error message builders (subclasses may override) ------------------

    def _build_not_reachable_message(self) -> str:
        return (
            f"{self._DISPLAY_NAME} server is not reachable. Start it with "
            f"'{self._START_COMMAND_HINT}' or ensure it is already running."
        )

    def _build_not_serving_message(self, requested: str, available: str) -> str:
        return (
            f"{self._DISPLAY_NAME} is not serving model '{requested}'. "
            f"Available models: {available}. "
            f"Restart {self._DISPLAY_NAME} with: {self._START_COMMAND_HINT}"
        )

    def unload_model(self, _name: str | None = None) -> None:
        self.model_name = None
        self._ready = False
        self._context_length = None
        self._served_context_length = None
        self._thinking = False
        self._vision = False
        self._local_runtime_capability_sources = {
            "text": "engine_default",
            "tool_calling": "engine_default",
            "thinking": "unsupported",
            "vision": "unsupported",
        }

    def close(self) -> None:
        # Transport teardown is independent of model state so unload_model
        # leaves the engine instance reusable; the container calls close()
        # at engine-discard sites to deterministically release the
        # underlying httpx.Client and its keep-alive sockets.
        self._service.close()

    def get_model_context_length(self) -> int | None:
        return self._context_length

    # -- internal helpers --------------------------------------------------

    def _current_request_context(self) -> dict[str, Any] | None:
        return _shared_current_request_context(self)

    def _current_app_profile_behavior(self) -> dict[str, Any]:
        return _shared_current_app_profile_behavior(self)

    def _request_id(self) -> str:
        context = self._current_request_context()
        if not isinstance(context, dict):
            return ""
        return str(context.get("request_id") or "").strip()

    def _reasoning_output_enabled(self) -> bool:
        return _shared_reasoning_output_enabled(
            native_thinking=self._thinking,
            app_profile_behavior=self._current_app_profile_behavior(),
        )

    def _effective_temperature(self, requested_temperature: float) -> float:
        return _shared_effective_temperature(self, requested_temperature)

    def _effective_top_k(self) -> int | None:
        return _shared_effective_top_k(self)

    def _effective_top_p(self) -> float | None:
        return _shared_effective_top_p(self)

    def _effective_min_p(self) -> float | None:
        return _shared_effective_min_p(self)

    def _effective_presence_penalty(self) -> float | None:
        return _shared_effective_presence_penalty(self)

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
            engine_type=self._ENGINE_TYPE,
            model_name=self.model_name,
        )

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
    ) -> None:
        request_id = self._request_id()
        if not request_id:
            return
        context = self._current_request_context()
        trace_id = str(context.get("trace_id") or "") if isinstance(context, dict) else ""
        logger.info(
            "%s request started.",
            self._DISPLAY_NAME,
            extra={
                "request_id": request_id,
                "trace_id": trace_id or request_id,
                "model": self.model_name,
                "think_enabled": think_enabled,
                "num_predict": num_predict,
                "temperature": temperature,
                "message_count": message_count,
                "tool_count": tool_count,
                "tool_capable": tool_capable,
                "tool_payload_bytes": tool_payload_bytes,
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
        store.record_provider_usage(
            request_id=request_id,
            prompt_eval_count=usage.get("prompt_tokens"),
            eval_count=usage.get("completion_tokens"),
            cached_tokens=cached_tokens,
            provider_label=self._PROVIDER_LABEL,
        )

    def _complete_provider_request(self) -> None:
        request_id = self._request_id()
        store = current_diagnostics_store(self)
        if store is None or not request_id or not hasattr(store, "complete_provider_request"):
            return
        store.complete_provider_request(request_id=request_id)

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
            engine_type=self._ENGINE_TYPE,
            model_name=self.model_name,
            app_profile_behavior=self._current_app_profile_behavior(),
            parser_mode=parser_mode,
            reasoning_chars=reasoning_chars,
            visible_chars=visible_chars,
        )

    @staticmethod
    def _sanitize_content(text: str) -> str:
        return strip_known_reasoning_markers(strip_known_reasoning_blocks(str(text or "")))

    def _assert_ready(self) -> None:
        if not self._ready or not self.model_name:
            raise ModelNotLoadedError()

    def _query_models(self) -> list[dict[str, Any]] | None:
        """Probe ``/models``, or ``None`` when the server is unreachable.

        Routed through the shared ``ProviderHttpService`` rather than a bare
        ``httpx.get``: the ad-hoc call created a throwaway client per probe AND
        read an UNBOUNDED response body, so a hostile or broken ``/models``
        endpoint could stream the sidecar out of memory. The service applies the
        bounded-body contract and reuses the pooled client; the short probe
        timeout rides the new per-call override.
        """
        try:
            body = self._service.get_json("/models", timeout=_HEALTH_TIMEOUT_SECONDS)
            data = body.get("data")
            return data if isinstance(data, list) else []
        except Exception:  # noqa: BLE001
            return None

    @staticmethod
    def _extract_context_length(
        models: list[dict[str, Any]],
        model_id: str,
    ) -> int | None:
        for entry in models:
            if not isinstance(entry, dict):
                continue
            if str(entry.get("id", "")) != model_id:
                continue
            max_model_len = entry.get("max_model_len")
            if max_model_len is not None:
                try:
                    return int(max_model_len)
                except (ValueError, TypeError):
                    pass
        return None

    @staticmethod
    def _detect_thinking(model_name: str) -> bool:
        # Match the bare family after any namespace prefix (e.g. "Qwen/Qwen3.5-9B").
        return model_token_matches(
            canonical_model_token(model_name),
            marker="thinking",
            prefixes=THINKING_MODEL_PREFIXES,
        )

    @staticmethod
    def _detect_vision(model_name: str) -> bool:
        normalized = str(model_name or "").strip().lower()
        if not normalized:
            return False
        candidates = [normalized]
        tail = canonical_model_token(model_name)
        if tail != normalized:
            candidates.append(tail)
        for candidate in candidates:
            if model_token_matches(
                candidate,
                marker="vision",
                prefixes=VLLM_VISION_MODEL_PREFIXES,
            ):
                return True
            tokens = [token for token in candidate.replace("_", "-").split("-") if token]
            if "vl" in tokens:
                return True
        return False

    @staticmethod
    def _sanitize_thinking(text: str) -> str:
        return strip_known_reasoning_markers(str(text or ""))

    def __repr__(self) -> str:
        return f"{type(self).__name__}(base_url={self._base_url!r}, model={self.model_name!r})"
