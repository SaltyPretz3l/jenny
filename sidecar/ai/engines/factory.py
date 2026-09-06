"""Engine factory for runtime selection with safe fallback behavior."""

from __future__ import annotations

import ipaddress
import logging
import socket
from collections.abc import Callable
from dataclasses import dataclass
from time import perf_counter
from typing import Any
from urllib.parse import urlparse

from sidecar.ai.config import RuntimeConfig, codex_cli_unavailable_reason
from sidecar.ai.engines.base import BaseEngine
from sidecar.ai.engines.mock import MockEngine
from sidecar.ai.engines.plugin_host import PluginHostEngine
from sidecar.runtime.diagnostics import emit_startup_audit_mark, log_event

logger = logging.getLogger(__name__)

_DEFAULT_MOCK_MODEL = "mock-v1"
_DEFAULT_VLLM_MODEL = "Qwen/Qwen3.5-9B"
_DEFAULT_CHATGPT_MODEL = "gpt-5.5"
_PROVIDER_ENGINE_EXPORTS = frozenset(
    {
        "CodexCliEngine",
        "OllamaEngine",
        "OpenAICompatibleEngine",
        "ReplayEngine",
        "ResponsesDescriptorEngine",
        "VLLMEngine",
    }
)


# The engine classes are no longer module-scope names here -- each
# _create_*_selection imports the one class it needs. But 13 tests in
# tests/sidecar/ai/engines/test_factory.py patch them by string, e.g.
# monkeypatch.setattr("sidecar.ai.engines.factory.OllamaEngine", _StubOllama),
# and monkeypatch reads the current value first so it can restore it. Without
# this __getattr__ that read raises AttributeError and those tests break. It
# resolves through provider_registry, so it stays lazy.
def __getattr__(name: str) -> Any:
    if name not in _PROVIDER_ENGINE_EXPORTS:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    from sidecar.ai.engines import provider_registry  # noqa: PLC0415

    return getattr(provider_registry, name)


@dataclass(frozen=True)
class EngineSelection:
    engine: BaseEngine
    engine_type: str
    model: str
    fallback_from: str | None = None
    fallback_reason: str | None = None


def _attach_capability_profile_store(engine: BaseEngine, store: Any | None) -> None:
    """Attach the capability-profile store BEFORE the engine loads its model.

    ``load_model`` is the sole writer of provider capability profiles, so the
    store must be attached first.

    Typed ``Any`` deliberately: this module is at the ``sidecar.ai.*`` import
    fan-out cap (``check_import_fanout.py``), and the setter is already
    duck-typed via ``hasattr`` for engines that do not record profiles.
    """
    if store is None:
        return
    setter = getattr(engine, "set_provider_capability_profile_store", None)
    if callable(setter):
        setter(store)


def _build_mock(
    model: str | None = None,
    *,
    fallback_from: str | None = None,
    fallback_reason: str | None = None,
    capability_profile_store: Any | None = None,
) -> EngineSelection:
    resolved_model = str(model or _DEFAULT_MOCK_MODEL).strip() or _DEFAULT_MOCK_MODEL
    engine = MockEngine()
    try:
        _attach_capability_profile_store(engine, capability_profile_store)
        engine.load_model(resolved_model)
        return EngineSelection(
            engine=engine,
            engine_type="mock",
            model=resolved_model,
            fallback_from=fallback_from,
            fallback_reason=fallback_reason,
        )
    except BaseException:
        _close_failed_engine(engine)
        raise


def _close_failed_engine(engine: BaseEngine | None) -> None:
    if engine is None:
        return
    try:
        engine.unload_model()
    except Exception:  # noqa: BLE001
        pass
    try:
        engine.close()
    except Exception:  # noqa: BLE001
        pass


def _init_or_fallback(
    engine_type: str,
    display_name: str,
    build: Callable[[], tuple[BaseEngine, str, Callable[[], None]]],
    *,
    include_exc_detail: bool = True,
    capability_profile_store: Any | None = None,
) -> EngineSelection:
    engine: BaseEngine | None = None
    try:
        engine, model, initialize = build()
        # Between construction and load: see _attach_capability_profile_store.
        # This is the single chokepoint every engine type passes through.
        _attach_capability_profile_store(engine, capability_profile_store)
        initialize()
        return EngineSelection(
            engine=engine,
            engine_type=engine_type,
            model=model,
        )
    except Exception as exc:  # noqa: BLE001
        _close_failed_engine(engine)
        reason = f"{display_name} engine failed to initialize: {type(exc).__name__}"
        if include_exc_detail:
            reason += f": {exc}"
        log_event(
            logger,
            logging.WARNING,
            component="ai.engines.factory",
            event="ai.engines.factory.init_failed",
            message=f"{display_name} engine initialization failed; falling back to MockEngine",
            status="failure",
            data={"engine_type": engine_type, "error_type": type(exc).__name__},
        )
        return _build_mock(
            fallback_from=engine_type,
            fallback_reason=reason,
            capability_profile_store=capability_profile_store,
        )


def _is_local_address(value: str) -> bool:
    try:
        address = ipaddress.ip_address(value)
    except ValueError:
        return False
    return address.is_loopback or address.is_private or address.is_link_local


def _parse_api_hostname(api_url: str) -> tuple[str, int | None] | None:
    token = str(api_url or "").strip()
    if not token:
        return None
    candidate = token if "://" in token else f"http://{token}"
    try:
        parsed = urlparse(candidate)
        hostname = parsed.hostname
        port = parsed.port
    except ValueError:
        return ("", None)
    if not hostname:
        return ("", None)
    return hostname.strip().lower(), port


def _host_resolves_only_to_local_addresses(hostname: str, port: int | None) -> bool:
    if hostname in {"localhost"} or hostname.endswith(".localhost"):
        return True
    if _is_local_address(hostname):
        return True
    try:
        resolved = socket.getaddrinfo(hostname, port, type=socket.SOCK_STREAM)
    except OSError:
        return False
    addresses = [str(sockaddr[0]) for *_prefix, sockaddr in resolved if sockaddr]
    return bool(addresses) and all(_is_local_address(address) for address in addresses)


def _validate_openai_compatible_local_host(api_url: str | None) -> str | None:
    if not api_url:
        return None
    parsed_host = _parse_api_hostname(api_url)
    if parsed_host is None:
        return None
    hostname, port = parsed_host
    if hostname and _host_resolves_only_to_local_addresses(hostname, port):
        return None
    display_host = hostname or str(api_url).strip()
    return (
        "OpenAI-compatible engine host must be local-only; "
        f"'{display_host}' does not resolve only to localhost/private/link-local addresses."
    )


def _create_openai_compatible_selection(
    config: RuntimeConfig,
    *,
    capability_profile_store: Any | None = None,
) -> EngineSelection:
    # Prefer a value patched into this module's globals over the lazily
    # imported class: monkeypatch.setattr writes into factory.__dict__, and the
    # engine-stub tests rely on that patch winning. Same idiom in every sibling
    # _create_*_selection below -- do not "simplify" it away.
    from sidecar.ai.engines.provider_registry import (  # noqa: PLC0415
        OpenAICompatibleEngine,
    )

    engine_class = globals().get("OpenAICompatibleEngine", OpenAICompatibleEngine)
    resolved_model = str(config.model or "").strip()
    host = config.api_url if config.api_url else None
    local_host_error = _validate_openai_compatible_local_host(host)
    if local_host_error is not None:
        log_event(
            logger,
            logging.WARNING,
            component="ai.engines.factory",
            event="ai.engines.factory.openai_compatible_nonlocal_host",
            message="OpenAI-compatible engine host rejected by local-only policy",
            status="failure",
            data={"engine_type": "openai-compatible", "api_url": host},
        )
        return _build_mock(
            fallback_from="openai-compatible",
            fallback_reason=local_host_error,
            capability_profile_store=capability_profile_store,
        )

    def build() -> tuple[BaseEngine, str, Callable[[], None]]:
        engine = engine_class(
            host=host,
            api_key=config.openai_compatible_api_key,
            configured_context_length=config.context_length,
            profile_max_output_tokens=config.resolved_app_profile_max_output_tokens,
            profile_thinking_headroom=config.resolved_app_profile_thinking_token_headroom,
        )

        def initialize() -> None:
            if resolved_model:
                engine.load_model(resolved_model)

        return engine, resolved_model, initialize

    return _init_or_fallback(
        "openai-compatible",
        "OpenAI-compatible",
        build,
        capability_profile_store=capability_profile_store,
    )


def _create_replay_selection(
    config: RuntimeConfig,
    *,
    capability_profile_store: Any | None = None,
) -> EngineSelection:
    from sidecar.ai.engines.provider_registry import ReplayEngine  # noqa: PLC0415

    engine_class = globals().get("ReplayEngine", ReplayEngine)
    resolved_model = str(config.model or "replay-default").strip() or "replay-default"

    def build() -> tuple[BaseEngine, str, Callable[[], None]]:
        engine = engine_class(
            script_path=config.replay_script_path,
            delay_ms=config.replay_delay_ms,
        )
        return engine, resolved_model, lambda: engine.load_model(resolved_model)

    return _init_or_fallback(
        "replay",
        "Replay",
        build,
        capability_profile_store=capability_profile_store,
    )


def _create_codex_cli_selection(
    config: RuntimeConfig,
    *,
    capability_profile_store: Any | None = None,
) -> EngineSelection:
    from sidecar.ai.engines.provider_registry import CodexCliEngine  # noqa: PLC0415

    engine_class = globals().get("CodexCliEngine", CodexCliEngine)
    unavailable_reason = codex_cli_unavailable_reason(config)
    if unavailable_reason:
        return _build_mock(
            fallback_from="codex-cli",
            fallback_reason=unavailable_reason,
            capability_profile_store=capability_profile_store,
        )
    resolved_model = str(config.model or "codex-cli/default").strip() or "codex-cli/default"

    def build() -> tuple[BaseEngine, str, Callable[[], None]]:
        engine = engine_class(
            command=config.codex_cli_command,
            runtime_root=config.codex_cli_runtime_root,
            request_timeout_seconds=config.codex_cli_request_timeout_seconds,
        )
        return engine, resolved_model, lambda: engine.load_model(resolved_model)

    return _init_or_fallback(
        "codex-cli",
        "Codex CLI",
        build,
        capability_profile_store=capability_profile_store,
    )


def _create_chatgpt_selection(
    config: RuntimeConfig,
    *,
    provider_descriptor: dict[str, Any] | None = None,
    provider_authority_check: Callable[[], bool] | None = None,
    capability_profile_store: Any | None = None,
) -> EngineSelection:
    from sidecar.ai.engines.provider_registry import (  # noqa: PLC0415
        ResponsesDescriptorEngine,
    )

    engine_class = globals().get("ResponsesDescriptorEngine", ResponsesDescriptorEngine)
    access_token = str(config.chatgpt_access_token or "").strip()
    if not access_token:
        return _build_mock(
            fallback_from="chatgpt",
            fallback_reason="chatgpt engine unavailable: not signed in",
            capability_profile_store=capability_profile_store,
        )
    resolved_model = str(config.model or _DEFAULT_CHATGPT_MODEL).strip() or _DEFAULT_CHATGPT_MODEL
    # Reasoning items are replayed once per admitted function_call, so the cache must
    # cover a whole turn's tool budget or long turns lose their oldest replay items.
    # Read as plain RuntimeConfig attributes rather than via iteration_limits: this
    # module is at the sidecar.ai.* import fan-out cap (check_import_fanout.py).
    # Taking the max of both profiles is correct under either without coupling the
    # factory to is_cloud_loop_profile_enabled; chatgpt is always a cloud engine.
    max_reasoning_items = max(
        int(getattr(config, "cloud_max_tools_per_turn", 0) or 0),
        int(getattr(config, "max_tools_per_turn", 0) or 0),
    )

    def build() -> tuple[BaseEngine, str, Callable[[], None]]:
        engine = engine_class(
            descriptor=provider_descriptor or {},
            model=resolved_model,
            access_token=access_token,
            account_id=config.chatgpt_account_id,
            max_reasoning_items=max_reasoning_items,
            authority_check=provider_authority_check,
        )
        return engine, resolved_model, lambda: engine.load_model(resolved_model)

    # Keep the exception repr out of the reason: ChatGPT errors can echo
    # request/auth detail that must not reach fallback diagnostics.
    return _init_or_fallback(
        "chatgpt",
        "ChatGPT",
        build,
        include_exc_detail=False,
        capability_profile_store=capability_profile_store,
    )


def _create_ollama_selection(
    config: RuntimeConfig,
    progress_callback: Callable[[dict[str, Any]], None] | None,
    *,
    capability_profile_store: Any | None = None,
) -> EngineSelection:
    from sidecar.ai.engines.provider_registry import OllamaEngine  # noqa: PLC0415

    engine_class = globals().get("OllamaEngine", OllamaEngine)
    resolved_model = str(config.model or "").strip()

    def build() -> tuple[BaseEngine, str, Callable[[], None]]:
        engine = engine_class(
            host=config.api_url if config.api_url else None,
            request_timeout_seconds=config.ollama_request_timeout_seconds,
            configured_context_length=config.context_length,
            profile_max_output_tokens=config.resolved_app_profile_max_output_tokens,
            profile_thinking_headroom=config.resolved_app_profile_thinking_token_headroom,
        )

        def initialize() -> None:
            if not resolved_model:
                return
            model_load_started_at = perf_counter()
            emit_startup_audit_mark(
                logger,
                "model-load-start",
                data={"engine_type": "ollama", "model": resolved_model},
            )
            if progress_callback is None:
                engine.load_model(resolved_model)
            else:
                engine.load_model(
                    resolved_model,
                    progress_callback=progress_callback,
                )
            emit_startup_audit_mark(
                logger,
                "model-load-end",
                duration_ms=(perf_counter() - model_load_started_at) * 1000,
                data={"engine_type": "ollama", "model": resolved_model},
            )

        return engine, resolved_model, initialize

    return _init_or_fallback(
        "ollama",
        "Ollama",
        build,
        capability_profile_store=capability_profile_store,
    )


def _create_vllm_selection(
    config: RuntimeConfig,
    *,
    capability_profile_store: Any | None = None,
) -> EngineSelection:
    from sidecar.ai.engines.provider_registry import VLLMEngine  # noqa: PLC0415

    engine_class = globals().get("VLLMEngine", VLLMEngine)
    resolved_model = str(config.model or _DEFAULT_VLLM_MODEL).strip() or _DEFAULT_VLLM_MODEL

    def build() -> tuple[BaseEngine, str, Callable[[], None]]:
        engine = engine_class(host=config.api_url if config.api_url else None)
        return engine, resolved_model, lambda: engine.load_model(resolved_model)

    return _init_or_fallback(
        "vllm",
        "vLLM",
        build,
        capability_profile_store=capability_profile_store,
    )


def create_engine(  # noqa: PLR0913 - central engine wiring owns bounded injected seams.
    config: RuntimeConfig,
    *,
    progress_callback: Callable[[dict[str, Any]], None] | None = None,
    capability_profile_store: Any | None = None,
    provider_descriptor: dict[str, Any] | None = None,
    provider_authority_check: Callable[[], bool] | None = None,
    plugin_host_binding: dict[str, Any] | None = None,
    plugin_host_invoke: Callable[[dict[str, Any]], Any] | None = None,
    plugin_host_authority_check: Callable[[], bool] | None = None,
) -> EngineSelection:
    """Create and load the active engine for a runtime configuration.

    ``capability_profile_store`` is attached to the engine BEFORE its model
    loads, because ``load_model`` is the sole writer of capability profiles.
    Callers that omit it get the previous behaviour (no profiles recorded).
    """
    requested_type = str(config.engine_type or "mock").strip().lower() or "mock"
    if requested_type == "mock":
        return _build_mock(
            config.model,
            capability_profile_store=capability_profile_store,
        )

    if requested_type == "plugin_host":
        engine = PluginHostEngine(
            plugin_host_binding,
            plugin_host_invoke,
            plugin_host_authority_check,
        )
        engine.load_model(config.model)
        return EngineSelection(engine=engine, engine_type="plugin_host", model=engine.model_name)

    if requested_type == "replay":
        return _create_replay_selection(
            config,
            capability_profile_store=capability_profile_store,
        )

    if requested_type == "ollama":
        return _create_ollama_selection(
            config,
            progress_callback,
            capability_profile_store=capability_profile_store,
        )

    if requested_type == "vllm":
        return _create_vllm_selection(
            config,
            capability_profile_store=capability_profile_store,
        )

    if requested_type == "openai-compatible":
        return _create_openai_compatible_selection(
            config,
            capability_profile_store=capability_profile_store,
        )

    if requested_type == "codex-cli":
        return _create_codex_cli_selection(
            config,
            capability_profile_store=capability_profile_store,
        )

    if requested_type == "chatgpt":
        return _create_chatgpt_selection(
            config,
            provider_descriptor=provider_descriptor,
            provider_authority_check=provider_authority_check,
            capability_profile_store=capability_profile_store,
        )

    log_event(
        logger,
        logging.WARNING,
        component="ai.engines.factory",
        event="ai.engines.factory.unknown_type",
        message=f"Unknown engine type '{requested_type}'; falling back to MockEngine",
        status="failure",
        data={"engine_type": requested_type},
    )
    return _build_mock(
        fallback_from=requested_type,
        fallback_reason=f"Unknown engine type '{requested_type}'",
        capability_profile_store=capability_profile_store,
    )


__all__ = ["EngineSelection", "create_engine"]
