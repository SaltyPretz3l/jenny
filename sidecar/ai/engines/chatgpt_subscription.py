"""ChatGPT-subscription engine using the Responses SSE endpoint."""

from __future__ import annotations

import json
import threading
from collections import OrderedDict
from collections.abc import Generator
from typing import Any, Mapping

import httpx

from sidecar.ai.engines.base import (
    BaseEngine,
    EngineMessage,
    ModelModality,
    clamp_timeout_to_deadline,
)
from sidecar.ai.engines.provider_http import ProviderHttpError, ProviderHttpService
from sidecar.ai.engines.responses_descriptor_stream import (
    build_responses_payload,
    raise_for_initial_status,
    raise_if_cancelled,
    register_close_cancel_callback,
    stream_response_events,
)
from sidecar.ai.error_codes import CMP_CLOUD_NETWORK_ERROR
from sidecar.ai.exceptions import GenerationError
from sidecar.ai.tools.models import GenerationResult, StreamChunk
from sidecar.runtime.chat_models import TerminalChatStateError
from sidecar.runtime.local_engine.request_context import (
    clear_request_context as _clear_shared_request_context,
)
from sidecar.runtime.local_engine.request_context import (
    current_diagnostics_store,
    current_request_context,
)
from sidecar.runtime.local_engine.request_context import (
    install_request_context as _install_shared_request_context,
)
from sidecar.runtime.local_engine.request_context import request_id as active_request_id
from sidecar.runtime.plan_usage_snapshot import record_plan_usage_snapshot

_DEFAULT_BASE_URL = "https://chatgpt.com/backend-api/codex"
_DEFAULT_TIMEOUT_SECONDS = 300.0
_DEFAULT_MODEL = "gpt-5.5"
# Reasoning items are replayed per function_call within the active tool loop, so the
# cache must hold at least as many entries as one turn is allowed to produce -- the
# cloud profile admits up to cloud_max_tools_per_turn (default 200) calls, and a
# cache smaller than that silently drops the oldest calls' reasoning items partway
# through a long turn. The factory sizes it from the admitted budget; this is only
# the floor used by direct construction.
#
# Eviction is FIFO by FIRST capture, not LRU: dict.update() on an existing key does
# not reorder, so a re-captured call_id keeps its original position. Within a tool
# loop insertion order == call order == replay order, so FIFO and LRU evict the same
# entry in every realistic stream, and FIFO keeps the request-build path
# (_insert_reasoning_items) read-only and re-entrancy-safe.
#
# A count bound alone is not enough at 200-500: reasoning items are opaque
# encrypted_content blobs of unbounded size, so an aggregate byte ceiling evicts too.
#
# The cache is per-engine-instance and is deliberately NOT persisted across process
# restart or engine reconfiguration: persisting would write provider-issued
# encrypted_content into a durable store and require a schema + migration, and buys
# nothing because _insert_reasoning_items already ships calls with no captured item.
_DEFAULT_MAX_CACHED_REASONING_ITEMS = 32
_MAX_REASONING_ITEMS_CEILING = 512
_MAX_CACHED_REASONING_BYTES = 8 * 1024 * 1024
_NOMINAL_REASONING_ITEM_BYTES = 4096
_DEFAULT_REASONING_REQUEST_KEY = "__default__"

# Catalog provenance. The first-party Codex release rust-v0.146.0 (peeled commit
# e363b08c9175ac1cbe5893615dd2cb9ddf95043b), codex-rs/models-manager/models.json,
# captured 2026-07-31, lists 272k for all three 5.6 models. The Codex app model
# cache captured 2026-08-12 lists GPT-5.3-Codex-Spark at 128k. These files are
# COMPARISON EVIDENCE for first-party Codex clients, NOT a contract for the private
# chatgpt.com/backend-api/codex endpoint -- we have no owner traffic against it.
# These values are therefore a conservative floor: every consumer treats the window
# as a ceiling, so a value that is too low only compacts earlier, while one that is
# too high causes hard request failures. A value may only be RAISED from an
# owner-captured response.
_DEFAULT_CHATGPT_CONTEXT_LENGTH = 272_000

CHATGPT_MODEL_CONTEXT_LENGTHS: dict[str, int] = {
    "gpt-5.6-sol": 272_000,
    "gpt-5.6-terra": 272_000,
    "gpt-5.6-luna": 272_000,
    "gpt-5.3-codex-spark": 128_000,
    "gpt-5.5": 272_000,
    "gpt-5.4": 272_000,
    "gpt-5.4-mini": 272_000,
    "gpt-5.2": 272_000,
}

# First-party Codex model-catalog evidence captured through 2026-08-12. ``ultra``
# is omitted because Codex defines it as reasoning plus automatic delegation and
# Jenny's sub-agent architecture is explicitly not part of this implementation.
CHATGPT_MODEL_REASONING_PROFILES: dict[str, dict[str, Any]] = {
    "gpt-5.6-sol": {
        "default_reasoning_effort": "low",
        "reasoning_efforts": ["low", "medium", "high", "xhigh", "max"],
    },
    "gpt-5.6-terra": {
        "default_reasoning_effort": "medium",
        "reasoning_efforts": ["low", "medium", "high", "xhigh", "max"],
    },
    "gpt-5.6-luna": {
        "default_reasoning_effort": "medium",
        "reasoning_efforts": ["low", "medium", "high", "xhigh", "max"],
    },
    "gpt-5.3-codex-spark": {
        "default_reasoning_effort": "high",
        "reasoning_efforts": ["low", "medium", "high", "xhigh"],
    },
    "gpt-5.5": {
        "default_reasoning_effort": "medium",
        "reasoning_efforts": ["low", "medium", "high", "xhigh"],
    },
    "gpt-5.4": {
        "default_reasoning_effort": "medium",
        "reasoning_efforts": ["low", "medium", "high", "xhigh"],
    },
    "gpt-5.4-mini": {
        "default_reasoning_effort": "medium",
        "reasoning_efforts": ["low", "medium", "high", "xhigh"],
    },
    "gpt-5.2": {
        "default_reasoning_effort": "medium",
        "reasoning_efforts": ["low", "medium", "high", "xhigh"],
    },
}


def _reasoning_item_size(item: dict[str, Any]) -> int:
    """Approximate an opaque reasoning item's footprint, measured once at insert."""

    try:
        return len(json.dumps(item, separators=(",", ":"), default=str))
    except (TypeError, ValueError, RecursionError):
        return _NOMINAL_REASONING_ITEM_BYTES


def _drain_stream(
    stream: Generator[StreamChunk, None, GenerationResult],
) -> GenerationResult:
    while True:
        try:
            next(stream)
        except StopIteration as stop:
            return stop.value


class ChatGPTSubscriptionEngine(BaseEngine):
    """Direct ChatGPT-plan transport with Jenny-owned function-tool execution."""

    _ENGINE_TYPE = "chatgpt"

    def __init__(  # noqa: PLR0913
        self,
        model: str,
        access_token: str,
        account_id: str | None,
        base_url: str | None,
        timeout_seconds: float = _DEFAULT_TIMEOUT_SECONDS,
        max_reasoning_items: int = _DEFAULT_MAX_CACHED_REASONING_ITEMS,
        request_profile: str = "openai_responses_v1",
        stream_profile: str = "openai_responses_sse_v1",
        headers_override: Mapping[str, str] | None = None,
    ) -> None:
        resolved_model = str(model or "").strip() or _DEFAULT_MODEL
        token = str(access_token or "").strip()
        headers = dict(headers_override) if headers_override is not None else {
            "Authorization": f"Bearer {token}",
            "originator": "jenny",
            "User-Agent": "jenny",
            "Accept": "text/event-stream",
            "Content-Type": "application/json",
        }
        normalized_account_id = str(account_id or "").strip()
        if normalized_account_id and headers_override is None:
            headers["ChatGPT-Account-ID"] = normalized_account_id
        self._base_url = str(base_url or "").strip().rstrip("/") or _DEFAULT_BASE_URL
        self._timeout_seconds = max(0.05, float(timeout_seconds))
        self._service = ProviderHttpService(
            provider="chatgpt",
            base_url=self._base_url,
            headers=headers,
            timeout_seconds=self._timeout_seconds,
        )
        self.model_name = resolved_model
        self._request_profile = request_profile
        self._stream_profile = stream_profile
        # Never below the floor, so every direct construction keeps today's behavior.
        self._max_reasoning_items = max(
            _DEFAULT_MAX_CACHED_REASONING_ITEMS,
            min(int(max_reasoning_items or 0), _MAX_REASONING_ITEMS_CEILING),
        )
        self._reasoning_by_call_id: dict[str, dict[str, Any]] = {}
        self._reasoning_item_bytes: dict[str, int] = {}
        self._reasoning_by_request_id: dict[str, dict[str, dict[str, Any]]] = {
            _DEFAULT_REASONING_REQUEST_KEY: self._reasoning_by_call_id
        }
        self._reasoning_item_bytes_by_request_id: dict[str, dict[str, int]] = {
            _DEFAULT_REASONING_REQUEST_KEY: self._reasoning_item_bytes
        }
        self._reasoning_order: OrderedDict[tuple[str, str], None] = OrderedDict()
        self._reasoning_total_bytes = 0
        self._reasoning_lock = threading.RLock()
        self._turn_diagnostics_store: Any | None = None
        self._local_runtime_capability_sources: dict[str, str] = {
            "text": "engine_default",
            "tool_calling": "engine_default",
            "vision": "provider_contract",
        }

    @property
    def supported_modalities(self) -> set[ModelModality]:
        return {ModelModality.TEXT, ModelModality.VISION}

    @property
    def supports_tool_calling(self) -> bool:
        return True

    def load_model(self, model_path: str) -> None:
        """Record the remote model slug without performing startup I/O."""
        self.model_name = str(model_path or "").strip() or _DEFAULT_MODEL

    def _cache_reasoning_items(
        self,
        captured: dict[str, dict[str, Any]],
        *,
        request_id: str | None = None,
    ) -> None:
        if not captured:
            return
        request_key = self._reasoning_request_key(request_id)
        with self._reasoning_lock:
            bucket = self._reasoning_by_request_id.setdefault(request_key, {})
            byte_bucket = self._reasoning_item_bytes_by_request_id.setdefault(request_key, {})
            for call_id, item in captured.items():
                previous = byte_bucket.get(call_id)
                if previous is not None:
                    self._reasoning_total_bytes -= previous
                size = _reasoning_item_size(item)
                bucket[call_id] = item
                byte_bucket[call_id] = size
                self._reasoning_total_bytes += size
                self._reasoning_order.setdefault((request_key, call_id), None)
            self._evict_reasoning_items_locked()

    def _reasoning_snapshot(self, request_id: str | None = None) -> dict[str, dict[str, Any]]:
        request_key = self._reasoning_request_key(request_id)
        with self._reasoning_lock:
            return dict(self._reasoning_by_request_id.get(request_key, {}))

    def _reasoning_request_key(self, request_id: str | None = None) -> str:
        explicit_request_id = str(request_id or "").strip()
        if explicit_request_id:
            return explicit_request_id
        context = current_request_context(self) or {}
        if int(context.get("agent_depth") or 0) > 0:
            return active_request_id(self) or _DEFAULT_REASONING_REQUEST_KEY
        return _DEFAULT_REASONING_REQUEST_KEY

    def _evict_reasoning_items_locked(self) -> None:
        while self._reasoning_order and (
            len(self._reasoning_order) > self._max_reasoning_items
            or self._reasoning_total_bytes > _MAX_CACHED_REASONING_BYTES
        ):
            (request_key, call_id), _ = self._reasoning_order.popitem(last=False)
            bucket = self._reasoning_by_request_id.get(request_key, {})
            byte_bucket = self._reasoning_item_bytes_by_request_id.get(request_key, {})
            bucket.pop(call_id, None)
            self._reasoning_total_bytes -= byte_bucket.pop(call_id, 0)
            if request_key != _DEFAULT_REASONING_REQUEST_KEY and not bucket:
                self._reasoning_by_request_id.pop(request_key, None)
                self._reasoning_item_bytes_by_request_id.pop(request_key, None)
        if not self._reasoning_order:
            self._reasoning_total_bytes = 0

    def release_request_state(self, request_id: str) -> None:
        request_key = str(request_id or "").strip()
        if not request_key or request_key == _DEFAULT_REASONING_REQUEST_KEY:
            return
        with self._reasoning_lock:
            byte_bucket = self._reasoning_item_bytes_by_request_id.pop(request_key, {})
            self._reasoning_by_request_id.pop(request_key, None)
            self._reasoning_total_bytes -= sum(byte_bucket.values())
            for key in tuple(self._reasoning_order):
                if key[0] == request_key:
                    self._reasoning_order.pop(key, None)
            self._reasoning_total_bytes = max(0, self._reasoning_total_bytes)

    def get_model_context_length(self) -> int:
        return CHATGPT_MODEL_CONTEXT_LENGTHS.get(
            self.model_name, _DEFAULT_CHATGPT_CONTEXT_LENGTH
        )

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
        _clear_shared_request_context(self, request_id=request_id)

    def _record_completion_shape(self, diagnostics: dict[str, Any]) -> None:
        try:
            store = current_diagnostics_store(self)
            request_id = active_request_id(self)
            if (
                store is not None
                and request_id
                and hasattr(store, "record_provider_completion_shape")
            ):
                store.record_provider_completion_shape(
                    request_id=request_id,
                    diagnostics=diagnostics,
                )
        except Exception:  # noqa: BLE001 - diagnostics never break inference.
            pass

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
        _ = (max_tokens, temperature, prompt_cache_enabled, response_format)
        raise_if_cancelled(cancel_handle)
        request_key = self._reasoning_request_key()
        payload = build_responses_payload(
            request_profile=self._request_profile,
            model=self.model_name,
            prompt=prompt,
            system=system,
            messages=messages,
            tools=tools,
            reasoning_effort=reasoning_effort,
            reasoning_by_call_id=self._reasoning_snapshot(request_key),
        )
        request_timeout = clamp_timeout_to_deadline(
            self._timeout_seconds,
            wall_clock_deadline,
        )
        reasoning_sink: dict[str, dict[str, Any]] = {}
        completion_diagnostics: dict[str, Any] = {}
        try:
            with self._service.stream_response(
                "POST",
                "/responses",
                json=payload,
                timeout=request_timeout,
            ) as response:
                record_plan_usage_snapshot(self, response)
                unregister_cancel = register_close_cancel_callback(cancel_handle, response)
                try:
                    raise_if_cancelled(cancel_handle)
                    raise_for_initial_status(response)
                    result = yield from stream_response_events(
                        response,
                        stream_profile=self._stream_profile,
                        model=self.model_name,
                        cancel_handle=cancel_handle,
                        reasoning_sink=reasoning_sink,
                        completion_diagnostics_sink=completion_diagnostics,
                    )
                    self._cache_reasoning_items(reasoning_sink, request_id=request_key)
                    self._record_completion_shape(completion_diagnostics)
                    return result
                finally:
                    unregister_cancel()
        except (ProviderHttpError, GenerationError, TerminalChatStateError):
            raise
        except (httpx.TimeoutException, httpx.TransportError) as error:
            raise_if_cancelled(cancel_handle)
            raise ProviderHttpError(
                provider="chatgpt",
                status_code=None,
                code=CMP_CLOUD_NETWORK_ERROR,
                message=f"ChatGPT transport failed: {type(error).__name__}",
                retryable=True,
                classification=(
                    "api_timeout"
                    if isinstance(error, httpx.TimeoutException)
                    else "connection_error"
                ),
            ) from error
        except Exception as error:
            raise_if_cancelled(cancel_handle)
            raise GenerationError(
                f"ChatGPT streaming failed: {type(error).__name__}"
            ) from error

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
    ) -> GenerationResult:
        return _drain_stream(
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
            )
        )

    def unload_model(self, _name: str | None = None) -> None:
        self.model_name = _DEFAULT_MODEL

    def close(self) -> None:
        with self._reasoning_lock:
            self._reasoning_by_call_id.clear()
            self._reasoning_item_bytes.clear()
            self._reasoning_by_request_id = {
                _DEFAULT_REASONING_REQUEST_KEY: self._reasoning_by_call_id
            }
            self._reasoning_item_bytes_by_request_id = {
                _DEFAULT_REASONING_REQUEST_KEY: self._reasoning_item_bytes
            }
            self._reasoning_order.clear()
            self._reasoning_total_bytes = 0
        self._service.close()

__all__ = [
    "CHATGPT_MODEL_CONTEXT_LENGTHS",
    "CHATGPT_MODEL_REASONING_PROFILES",
    "ChatGPTSubscriptionEngine",
]
