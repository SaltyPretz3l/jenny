"""Native Ollama engine using the Ollama REST API directly."""

from __future__ import annotations

import json
import socket
import threading
import time
import urllib.error
import urllib.request
from typing import Any

from sidecar.ai.config import _DEFAULT_MAX_OUTPUT_TOKENS
from sidecar.ai.engines.base import BaseEngine, ModelModality
from sidecar.ai.engines.http_utils import read_json_response
from sidecar.ai.engines.ollama_generation import _OllamaGenerationMixin
from sidecar.ai.engines.ollama_metadata import (
    detect_thinking as _detect_thinking_helper,
)
from sidecar.ai.engines.ollama_metadata import (
    detect_vision as _detect_vision_helper,
)
from sidecar.ai.engines.ollama_metadata import (
    extract_context_length as _extract_context_length_helper,
)
from sidecar.ai.engines.ollama_metadata import (
    extract_max_output_tokens as _extract_max_output_tokens_helper,
)
from sidecar.ai.engines.ollama_metadata import (
    refresh_tool_capability as _refresh_tool_capability_helper,
)
from sidecar.ai.engines.ollama_metadata import (
    resolve_template_diagnostics_payload as _resolve_template_diagnostics_helper,
)
from sidecar.ai.engines.ollama_shared import (
    _DEFAULT_REQUEST_TIMEOUT,
    _HEALTH_TIMEOUT,
    _MAX_REQUEST_CONTEXT_LENGTH,
    _PULL_TIMEOUT,
    _UNLOAD_TIMEOUT,
    ProgressCallback,
    fetch_ollama_model_info,
    logger,
    pull_ollama_model,
    report_model_state,
    supports_ollama_reasoning_levels,
)
from sidecar.ai.engines.ollama_telemetry import (
    ResidencyKey,
    _OllamaTelemetryMixin,
    claim_residency,
    forget_residency,
    release_residency,
)
from sidecar.runtime.diagnostics import emit_startup_audit_mark
from sidecar.runtime.local_engine.contracts import (
    normalize_local_runtime_source,
)
from sidecar.runtime.local_engine.messages import (
    merge_consecutive_system_messages as _merge_consecutive_system_messages,  # noqa: F401
)
from sidecar.runtime.local_engine.request_context import (
    clear_request_context as _clear_shared_request_context,
)
from sidecar.runtime.local_engine.request_context import (
    current_app_profile_behavior as _shared_current_app_profile_behavior,
)
from sidecar.runtime.local_engine.request_context import (
    current_request_context as _shared_current_request_context,
)
from sidecar.runtime.local_engine.request_context import (
    debug_option_enabled as _shared_debug_option_enabled,
)
from sidecar.runtime.local_engine.request_context import (
    install_request_context as _install_shared_request_context,
)
from sidecar.runtime.local_engine.request_context import (
    request_id as _shared_request_id,
)
from sidecar.runtime.ollama_support import (
    EngineConnectionError,
    GenerationError,
    ModelNotLoadedError,
    resolve_ollama_base_url,
)


# Hard cap on how many /api/ps entries list_resident_models() will surface.
# A pathological/compromised Ollama daemon reporting an unbounded models list
# must not let this fan out into an unbounded number of model-fit
# observations recorded downstream (services/model-fit-observer.js records
# one per resident entry it matches against).
_MAX_RESIDENT_MODELS = 64


def _coerce_str(value: Any, max_len: int) -> str:
    if not isinstance(value, str):
        return ""
    return value.strip()[:max_len]


def _coerce_nonneg_int(value: Any) -> int:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return 0
    if value != value or value in (float("inf"), float("-inf")):  # NaN guard
        return 0
    return max(0, int(value))


def _coerce_optional_nonneg_int(value: Any) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if value != value or value in (float("inf"), float("-inf")):
        return None
    coerced = int(value)
    return coerced if coerced >= 0 else None


class OllamaEngine(_OllamaGenerationMixin, _OllamaTelemetryMixin, BaseEngine):
    """Ollama inference engine using the REST API at /api/chat and /api/generate."""

    def __init__(
        self,
        *,
        host: str | None = None,
        request_timeout_seconds: int = _DEFAULT_REQUEST_TIMEOUT,
        configured_context_length: int | None = None,
        profile_max_output_tokens: int | None = None,
        profile_thinking_headroom: int | None = None,
    ) -> None:
        self.host = resolve_ollama_base_url(host)
        self._request_timeout_seconds = max(
            int(request_timeout_seconds or _DEFAULT_REQUEST_TIMEOUT),
            30,
        )
        self.model_name: str | None = None
        self._ready = False
        self._vision = False
        self._thinking = False
        self._tool_calls_enabled = True
        self._tool_call_http_400_streak = 0
        self._context_length: int | None = None
        self._configured_context_length: int | None = None
        self._max_output_tokens: int | None = None
        self._profile_max_output_tokens = (
            int(profile_max_output_tokens)
            if isinstance(profile_max_output_tokens, int) and profile_max_output_tokens > 0
            else None
        )
        self._profile_thinking_headroom = (
            int(profile_thinking_headroom)
            if isinstance(profile_thinking_headroom, int) and profile_thinking_headroom > 0
            else None
        )
        self._thinking_capability_source = "unsupported"
        self._template_diagnostics: dict[str, object] = {}
        self._turn_diagnostics_store: Any | None = None
        # The shared-daemon residency triple this instance currently holds, or
        # None when it holds none. See sidecar/ai/engines/ollama_residency.py:
        # the DAEMON owns the weights, so closing this instance must not evict a
        # runner a sibling generation is still using.
        self._residency_claim: ResidencyKey | None = None
        self._warmup_lock = threading.Lock()
        self._warmup_generation = 0
        self._warmup_model: str | None = None
        self._cached_tools_state: tuple[tuple[str, ...], list[dict[str, Any]]] | None = None
        self._local_runtime_capability_sources: dict[str, str] = {
            "text": "engine_default",
            "vision": "unsupported",
            "tool_calling": "engine_default",
            "thinking": "unsupported",
        }
        self.set_configured_context_length(configured_context_length)

    def _ensure_local_runtime_capability_sources(self) -> dict[str, str]:
        sources = getattr(self, "_local_runtime_capability_sources", None)
        if isinstance(sources, dict):
            return sources
        sources = {
            "text": "engine_default",
            "vision": "unsupported",
            "tool_calling": "engine_default",
            "thinking": normalize_local_runtime_source(
                getattr(self, "_thinking_capability_source", "unsupported")
            ),
        }
        self._local_runtime_capability_sources = sources
        return sources

    @property
    def supported_modalities(self) -> set[ModelModality]:
        mods: set[ModelModality] = {ModelModality.TEXT}
        if self._vision:
            mods.add(ModelModality.VISION)
        return mods

    @property
    def capabilities(self) -> dict[str, bool]:
        caps = super().capabilities
        caps["thinking"] = self._thinking
        return caps

    @property
    def supports_tool_calling(self) -> bool:
        return self._tool_calls_enabled

    @property
    def supports_inband_tool_calling(self) -> bool:
        return True

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
            tracked_flags=(
                "first_chunk_logged",
                "first_visible_logged",
                "reasoning_parser_logged",
            ),
        )

    def clear_request_context(self, *, request_id: str | None = None) -> None:
        _clear_shared_request_context(self, request_id=request_id)

    def load_model(
        self,
        model_path: str,
        *,
        progress_callback: ProgressCallback | None = None,
    ) -> None:
        name = str(model_path or "").strip()
        if not name:
            raise ValueError("model_path must not be empty")
        try:
            self.model_name = name
            self._tool_calls_enabled = True
            self._tool_call_http_400_streak = 0

            # Tri-state, so a catalog probe we could not complete is never
            # mistaken for "the model is not installed" -- that mistake started
            # an unconfirmed multi-GB `POST /api/pull` and mis-attributed the
            # real (connectivity) failure.
            catalog_state, catalog_error = self._probe_catalog(name)
            if catalog_state == "unavailable":
                if isinstance(catalog_error, urllib.error.URLError):
                    raise EngineConnectionError(
                        self._describe_url_error(catalog_error, "model catalog lookup")
                    )
                raise EngineConnectionError(
                    "Ollama is not running. Please start it with 'ollama serve' "
                    "or ensure the Ollama application is running."
                )

            if catalog_state == "absent":
                logger.info("Model '%s' not found locally, pulling...", name)
                self._pull_model(name, progress_callback=progress_callback)

            report_model_state(
                progress_callback,
                state="model_loading",
                model=name,
                status="Inspecting model capabilities",
            )

            info = self.get_model_info(name)
            self._vision, vision_source = _detect_vision_helper(name, info)
            self._thinking, self._thinking_capability_source = _detect_thinking_helper(name, info)
            self._context_length = _extract_context_length_helper(info)
            self._max_output_tokens = _extract_max_output_tokens_helper(info, self._context_length)
            self._tool_calls_enabled, tool_calling_source = _refresh_tool_capability_helper(
                name, info
            )
            self._template_diagnostics = _resolve_template_diagnostics_helper(name, info)
            self._local_runtime_capability_sources = {
                "text": "engine_default",
                "vision": vision_source,
                "tool_calling": tool_calling_source,
                "thinking": self._thinking_capability_source,
            }
            self._ready = True
            # Claim shared residency only once the model is genuinely bound --
            # a failed probe must not leave a phantom holder wedging eviction.
            self._claim_residency()
            report_model_state(
                progress_callback,
                state="model_ready",
                model=name,
                status="Model ready",
            )
            logger.info(
                "OllamaEngine: model '%s' ready (max_output_tokens=%s).",
                name,
                self._max_output_tokens,
            )
        except Exception as exc:
            self._record_capability_probe_failure(name, exc)
            raise
        self._record_capability_probe_success(name)
        # Kick off an asynchronous warmup so Ollama loads the weights while
        # the rest of the sidecar finishes booting. Without this, the first
        # chat request pays the full model-load cost (~50 s for a ~3 GB
        # q6_k quant), which the user sees as Jenny being frozen. The native
        # Ollama app avoids this because its daemon keeps the last-used
        # model hot across sessions; we replicate that by pre-touching the
        # model here and letting Ollama's keep_alive (default 5 min) hold
        # it in memory until the user types.
        self._warmup_model_async(name)

    def _warmup_coordination_lock(self) -> threading.Lock:
        lock = getattr(self, "_warmup_lock", None)
        if lock is None:
            lock = threading.Lock()
            self._warmup_lock = lock
            self._warmup_generation = 0
            self._warmup_model = None
        return lock

    def _warmup_model_async(self, name: str) -> threading.Thread:
        """Fire a minimal generate request in a background thread to force
        Ollama to load the model weights into memory immediately, in
        parallel with the rest of sidecar boot. Fire-and-forget; failures
        are logged at DEBUG since they are not user-facing. Returns the
        thread so tests can join it.
        """

        warmup_lock = self._warmup_coordination_lock()
        with warmup_lock:
            self._warmup_generation += 1
            generation = self._warmup_generation
            self._warmup_model = name

        def _run() -> None:
            started_at = time.monotonic()
            try:
                with warmup_lock:
                    if (
                        generation != self._warmup_generation
                        or self._warmup_model != name
                    ):
                        return
                    emit_startup_audit_mark(logger, "warmup-start", data={"model": name})
                    self._post(
                        "/api/generate",
                        {
                            "model": name,
                            "prompt": "",
                            "stream": False,
                            # Generate exactly one token so Ollama fully
                            # materializes the compute graph but we don't pay
                            # for real output. No keep_alive override — let
                            # Ollama's server default (typically 5 min) hold
                            # the model hot. num_ctx must match what chat
                            # requests will send: Ollama keys the loaded
                            # runner on n_ctx, so a warmup at the tag default
                            # forces a full second load when the first chat
                            # arrives with the configured context length.
                            "options": self._apply_configured_num_ctx({"num_predict": 1}),
                        },
                        timeout=self._request_timeout_seconds,
                    )
                duration_ms = int((time.monotonic() - started_at) * 1000)
                logger.info(
                    "OllamaEngine: warmup complete (model=%s, duration_ms=%d).",
                    name,
                    duration_ms,
                )
                emit_startup_audit_mark(
                    logger,
                    "warmup-end",
                    duration_ms=duration_ms,
                    data={"model": name},
                )
            except Exception as error:  # noqa: BLE001
                duration_ms = int((time.monotonic() - started_at) * 1000)
                logger.debug(
                    "OllamaEngine: warmup failed (model=%s, duration_ms=%d): %s",
                    name,
                    duration_ms,
                    error,
                )
                emit_startup_audit_mark(
                    logger,
                    "warmup-end",
                    status="failure",
                    duration_ms=duration_ms,
                    data={"model": name, "error_type": type(error).__name__},
                )

        thread = threading.Thread(
            target=_run,
            name=f"ollama-warmup-{name}",
            daemon=True,
        )
        thread.start()
        return thread

    def _claim_residency(self) -> None:
        """(Re)claim the shared daemon residency triple this engine now needs.

        Keyed on ``(host, model, num_ctx)``: Ollama spins a distinct runner per
        ``n_ctx`` (see ``_apply_configured_num_ctx``), so a pair-keyed count
        would over-retain across a context-length change.
        """
        new_claim = claim_residency(self.host, self.model_name, self._get_request_context_length())
        # getattr: test doubles build engines via ``object.__new__`` and set the
        # attribute set by hand, exactly like ``_local_runtime_capability_sources``.
        previous = getattr(self, "_residency_claim", None)
        self._residency_claim = new_claim
        if previous is not None and previous != new_claim:
            # Bookkeeping-only handoff: rebinding without an unload never
            # evicted the old runner before either, and Ollama's keep_alive
            # expires it. Dropping the stale count keeps the map bounded.
            release_residency(previous)

    def _release_residency_claim(self) -> bool:
        """Drop this instance's claim; True when it must issue ``keep_alive: 0``.

        An engine that never claimed (never loaded, or a test double) returns
        True so eviction stays exactly as eager as it was before refcounting.
        """
        claim = getattr(self, "_residency_claim", None)
        self._residency_claim = None
        return release_residency(claim)

    def unload_model(self, name: str | None = None) -> None:
        # ``name is None`` means "close THIS instance": the daemon residency is
        # shared across generations, so the eviction is refcounted and only the
        # LAST holder posts keep_alive:0. Passing an explicit tag means
        # "intentionally evict this model" (operator models.unload, shutdown, or
        # a DIFFERENT loaded model such as the inline-completion FIM model); that
        # bypasses the refcount so a user-visible eviction is never suppressed.
        target = str(name if name is not None else self.model_name or "").strip()
        if not target:
            if name is None:
                self._release_residency_claim()
                self._reset_loaded_state()
            return
        intentional_eviction = name is not None
        should_evict = True
        if intentional_eviction:
            claim = getattr(self, "_residency_claim", None)
            if claim is not None and claim[1] == target:
                # The runner really is going away; leaving other counts behind
                # would let a later release skip an eviction that is needed.
                forget_residency(claim)
                self._residency_claim = None
        else:
            should_evict = self._release_residency_claim()
        if should_evict:
            try:
                with self._warmup_coordination_lock():
                    if self._warmup_model == target:
                        self._warmup_generation += 1
                        self._warmup_model = None
                    self._post(
                        "/api/generate",
                        {
                            "model": target,
                            "prompt": "",
                            "stream": False,
                            "keep_alive": 0,
                        },
                        timeout=_UNLOAD_TIMEOUT,
                    )
            except urllib.error.URLError as exc:
                raise EngineConnectionError(
                    f"Could not connect to Ollama at {self.host} while unloading {target}: {exc}"
                ) from exc
            except Exception as exc:
                raise GenerationError(f"Model unload failed: {exc}") from exc
        # Only the bound chat model's loaded-state bookkeeping is this engine's to
        # clear; an explicit foreign tag does not change self.model_name's state.
        if name is None or target == str(self.model_name or "").strip():
            self._reset_loaded_state()

    def get_model_context_length(self) -> int | None:
        return self._context_length

    def get_configured_context_length(self) -> int | None:
        return self._configured_context_length

    def set_configured_context_length(self, context_length: int | None) -> None:
        # Use ``getattr`` because ``object.__new__`` test doubles may omit this attribute.
        previous = getattr(self, "_configured_context_length", None)
        self._configured_context_length = self._normalize_configured_context_length(context_length)
        # The residency key includes num_ctx, so a live claim must be re-keyed
        # or release would decrement a triple this engine never claimed.
        if (
            getattr(self, "_residency_claim", None) is not None
            and previous != self._configured_context_length
        ):
            self._claim_residency()

    def _apply_configured_num_ctx(self, options: dict[str, Any]) -> dict[str, Any]:
        # Single source of truth for request-level num_ctx. Every Ollama
        # request that can trigger a model (re)load — chat generation AND the
        # warmup probe — must go through this, because Ollama spins up a new
        # runner whenever a request's n_ctx differs from the loaded one.
        num_ctx = self._get_request_context_length()
        if num_ctx is not None:
            options["num_ctx"] = num_ctx
        return options

    def _get_request_context_length(self) -> int | None:
        configured = self.get_configured_context_length()
        native = self.get_model_context_length()
        if configured is not None and native is not None:
            return min(configured, native)
        return configured

    @staticmethod
    def _normalize_configured_context_length(context_length: int | None) -> int | None:
        if context_length is None:
            return None
        try:
            value = int(context_length)
        except (TypeError, ValueError):
            return None
        if value <= 0:
            return None
        if value > _MAX_REQUEST_CONTEXT_LENGTH:
            logger.warning(
                "Ollama configured context length capped for request options.",
                extra={
                    "requested_context_length": value,
                    "request_context_length": _MAX_REQUEST_CONTEXT_LENGTH,
                },
            )
            return _MAX_REQUEST_CONTEXT_LENGTH
        return value

    def _assert_ready(self) -> None:
        if not self._ready or not self.model_name:
            raise ModelNotLoadedError()

    def _reset_loaded_state(self) -> None:
        self.model_name = None
        self._ready = False
        self._vision = False
        self._thinking = False
        self._tool_calls_enabled = True
        self._tool_call_http_400_streak = 0
        self._context_length = None
        self._max_output_tokens = None
        self._thinking_capability_source = "unsupported"
        self._cached_tools_state = None
        self._local_runtime_capability_sources = {
            "text": "engine_default",
            "vision": "unsupported",
            "tool_calling": "engine_default",
            "thinking": "unsupported",
        }

    def _current_request_context(self) -> dict[str, Any] | None:
        return _shared_current_request_context(self)

    def _request_id(self) -> str:
        return _shared_request_id(self)

    def _debug_option_enabled(self, key: str) -> bool:
        return _shared_debug_option_enabled(self, key)

    def _current_app_profile_behavior(self) -> dict[str, Any]:
        return _shared_current_app_profile_behavior(self)

    def _post(
        self,
        endpoint: str,
        data: dict[str, Any],
        timeout: float | None = None,
    ) -> dict[str, Any]:
        url = f"{self.host}{endpoint}"
        req = urllib.request.Request(
            url,
            data=json.dumps(data).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        effective_timeout = (
            self._request_timeout_seconds if timeout is None else max(float(timeout), 0.05)
        )
        with urllib.request.urlopen(req, timeout=effective_timeout) as resp:
            return read_json_response(resp)

    def _get(self, endpoint: str, timeout: int | None = None) -> dict[str, Any]:
        url = f"{self.host}{endpoint}"
        req = urllib.request.Request(url, method="GET")
        effective_timeout = (
            self._request_timeout_seconds if timeout is None else max(int(timeout), 1)
        )
        with urllib.request.urlopen(req, timeout=effective_timeout) as resp:
            return read_json_response(resp)

    def list_loaded_models(self, timeout: int | None = None) -> list[dict[str, Any]]:
        """Return the models currently resident in the Ollama daemon (`/api/ps`).

        Each item is ``{"name": str, "expires_at": str|None}``. Raises on a
        connection/HTTP failure so the caller can degrade to "unknown".
        """
        payload = self._get("/api/ps", timeout=timeout if timeout is not None else _HEALTH_TIMEOUT)
        raw = payload.get("models") if isinstance(payload, dict) else None
        models: list[dict[str, Any]] = []
        if isinstance(raw, list):
            for entry in raw:
                if not isinstance(entry, dict):
                    continue
                name = str(entry.get("name") or entry.get("model") or "").strip()
                if name:
                    models.append({"name": name, "expires_at": entry.get("expires_at")})
        return models

    def list_resident_models(self, timeout: int | None = None) -> list[dict[str, Any]]:
        """Return the models currently resident in Ollama (`/api/ps`), enriched
        with their measured footprint for the "record on first load, then
        self-catalog" fit-observation feature.

        Each item is ``{"name", "digest", "size", "size_vram",
        "context_length", "parameter_size", "quantization_level",
        "expires_at"}``. Raises on a connection/HTTP failure so the caller can
        degrade to "unavailable" (mirrors list_loaded_models). Coercion is
        defensive: numeric fields reject bools and non-finite/negative values
        (clamped to 0), string fields are truncated to a safe length. Capped
        at `_MAX_RESIDENT_MODELS` entries regardless of how many the daemon
        reports.
        """
        payload = self._get("/api/ps", timeout=timeout if timeout is not None else _HEALTH_TIMEOUT)
        raw = payload.get("models") if isinstance(payload, dict) else None
        models: list[dict[str, Any]] = []
        if isinstance(raw, list):
            for entry in raw:
                if len(models) >= _MAX_RESIDENT_MODELS:
                    break
                if not isinstance(entry, dict):
                    continue
                name = str(entry.get("name") or entry.get("model") or "").strip()
                if not name:
                    continue
                raw_details = entry.get("details")
                details: dict[str, Any] = raw_details if isinstance(raw_details, dict) else {}
                models.append(
                    {
                        "name": name,
                        "digest": _coerce_str(entry.get("digest"), 128),
                        "size": _coerce_nonneg_int(entry.get("size")),
                        "size_vram": _coerce_nonneg_int(entry.get("size_vram")),
                        "context_length": _coerce_optional_nonneg_int(
                            entry.get("context_length")
                        ),
                        "parameter_size": _coerce_str(details.get("parameter_size"), 32),
                        "quantization_level": _coerce_str(details.get("quantization_level"), 32),
                        "expires_at": entry.get("expires_at"),
                    }
                )
        return models

    def _timeout_message(self, operation: str) -> str:
        return f"{operation} timed out after {self._request_timeout_seconds}s waiting for Ollama."

    @staticmethod
    def _is_timeout_error(error: Exception) -> bool:
        if isinstance(error, (TimeoutError, socket.timeout)):
            return True
        return "timed out" in str(error).strip().lower()

    @classmethod
    def _is_timeout_url_error(cls, error: urllib.error.URLError) -> bool:
        reason = getattr(error, "reason", None)
        if isinstance(reason, Exception):
            return cls._is_timeout_error(reason)
        return cls._is_timeout_error(error)

    def _describe_url_error(self, error: urllib.error.URLError, operation: str) -> str:
        """Build an accurate message for a urllib error from an Ollama request.

        An ``HTTPError`` means the connection *succeeded* but the server/runner
        returned an error status -- a 5xx is typically the model runner crashing
        mid-request (most often out of memory for the model/context size), not a
        connectivity problem. Only a non-HTTP ``URLError`` is a real "could not
        connect". Reporting a 500 as "could not connect" misdirects debugging,
        so distinguish the cases here.
        """
        if isinstance(error, urllib.error.HTTPError):
            status = int(getattr(error, "code", 0) or 0)
            if status >= 500:
                return (
                    f"Ollama returned HTTP {status} during {operation} at "
                    f"{self.host}. The model runner failed mid-request -- most "
                    "often out of memory (the model or context is too large for "
                    "the available VRAM/RAM) or an Ollama runtime crash. Free "
                    "memory, reduce the context length, or pick a smaller model, "
                    "then retry."
                )
            return (
                f"Ollama rejected the {operation} request with HTTP {status} at "
                f"{self.host}: {error}"
            )
        return f"Could not connect to Ollama at {self.host}: {error}"

    def _probe_catalog(self, name: str) -> tuple[str, Exception | None]:
        """Query ``/api/tags`` once and return ``present``, ``absent``, or
        ``unavailable`` so unknown connectivity never triggers a model pull."""
        try:
            url = f"{self.host}/api/tags"
            req = urllib.request.Request(url, method="GET")
            with urllib.request.urlopen(req, timeout=_HEALTH_TIMEOUT) as resp:
                data = read_json_response(resp)
        except Exception as error:  # noqa: BLE001
            return "unavailable", error
        target = name.lower()
        for model in data.get("models", []):
            entry = str(model.get("name", "")).lower()
            bare = entry.split(":")[0]
            if bare == target or entry == target or entry.startswith(f"{target}:"):
                return "present", None
        return "absent", None

    def _pull_model(
        self,
        name: str,
        *,
        progress_callback: ProgressCallback | None = None,
    ) -> None:
        logger.info("Pulling model '%s'...", name)
        try:
            pull_ollama_model(
                host=self.host,
                model=name,
                timeout_seconds=_PULL_TIMEOUT,
                progress_callback=progress_callback,
            )
            logger.info("Model '%s' pulled successfully.", name)
        except RuntimeError:
            raise
        except Exception as exc:
            raise RuntimeError(f"Failed to pull model '{name}': {exc}") from exc

    def get_model_info(self, model_name: str) -> dict[str, Any] | None:
        try:
            return fetch_ollama_model_info(
                host=self.host,
                model_id=model_name,
                timeout_seconds=self._request_timeout_seconds,
            )
        except Exception:  # noqa: BLE001
            logger.debug("Could not get model info for '%s'.", model_name, exc_info=True)
            return None

    @staticmethod
    def _detect_vision(name: str, info: dict[str, Any] | None) -> bool:
        return _detect_vision_helper(name, info)[0]

    def get_model_max_output_tokens(self) -> int | None:
        max_output_tokens = getattr(self, "_profile_max_output_tokens", None) or getattr(
            self,
            "_max_output_tokens",
            None,
        )
        if max_output_tokens is not None:
            return max_output_tokens
        # Context-proportional default is floor-wins and only activates above 64k.
        context_length = self._get_request_context_length()
        scaled_default = context_length // 4 if context_length else 0
        if scaled_default > _DEFAULT_MAX_OUTPUT_TOKENS:
            return scaled_default
        return None

    def get_request_output_reservation(self, reasoning_effort: str | None = None) -> int | None:
        final_tokens = self.get_model_max_output_tokens()
        if final_tokens is None:
            return None
        if not supports_ollama_reasoning_levels(self.model_name):
            return final_tokens
        normalized = str(reasoning_effort or "").strip().lower()
        reservation = final_tokens
        if normalized != "none":
            reservation += getattr(self, "_profile_thinking_headroom", None) or (
                self._thinking_token_headroom()
            )
        context_length = self._get_request_context_length()
        return min(reservation, context_length) if context_length else reservation

    def __repr__(self) -> str:
        return f"OllamaEngine(host={self.host!r}, model={self.model_name!r})"
