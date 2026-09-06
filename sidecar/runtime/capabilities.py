"""Initialize/model capability response helpers."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Callable

from sidecar.ai.container import BrainContainer
from sidecar.ai.context.builder import WorkspaceStatus
from sidecar.ai.engines.catalog import (
    discover_ollama_models,
    discover_openai_compatible_models,
    discover_vllm_models,
    resolve_ollama_base_url,
)
from sidecar.ai.engines.chatgpt_subscription import (
    CHATGPT_MODEL_CONTEXT_LENGTHS,
    CHATGPT_MODEL_REASONING_PROFILES,
)
from sidecar.ai.engines.ollama_model_info import (
    MAX_OLLAMA_MODEL_ID_CHARS,
    inspect_ollama_model,
)
from sidecar.ai.memory.unavailable import memory_store_status_payload
from sidecar.ai.tools.builtins.workspace_cleanup import cleanup_workspace_artifacts
from sidecar.runtime.local_engine.snapshot import (
    active_app_profile_payload as _shared_active_app_profile_payload,
)
from sidecar.runtime.local_engine.snapshot import (
    active_model_capabilities_payload as _shared_active_model_capabilities_payload,
)
from sidecar.runtime.local_engine.snapshot import (
    build_local_runtime_payload,
    derive_legacy_runtime_aliases,
)
from sidecar.runtime.provider_capabilities import (
    ProviderCapability,
    available_engine_types,
    build_provider_capabilities,
    entitled_chatgpt_models,
    is_engine_available,
    provider_capabilities_payload,
)
from sidecar.runtime.provider_capability_profile import (
    provider_capability_profiles_payload,
)
from sidecar.runtime.schema_versions import get_all_schema_versions
from sidecar.runtime.worker_secrets import BROKERED_SECRET_KEYS, SECRET_CONFIG_KEYS

SERVER_VERSION = "1.0.0"

_ARCHIVED_CLOUD_ENGINE_TYPES = frozenset({"anthropic", "openai", "gemini"})
_OLLAMA_CATALOG_METADATA_FIELDS = (
    "source",
    "cached_at",
    "expires_at",
    "last_error",
    "daemon_version",
)


def _cached_hardware_summary() -> dict[str, object] | None:
    """Return a hardware snapshot if already probed, else ``None``.

    Never triggers a probe — safe to call from ``initialize``.
    """
    try:
        from sidecar.runtime.hardware_profile import get_cached_hardware_summary  # noqa: PLC0415

        return get_cached_hardware_summary()
    except Exception:  # noqa: BLE001
        return None


def _workspace_status_payload(status: WorkspaceStatus) -> dict[str, Any]:
    return {
        "root": status.root,
        "exists": status.exists,
        "skills_loaded": status.skills_loaded,
        "bootstrap_loaded": status.bootstrap_loaded,
        "instruction_file_name": status.instruction_file_name,
        "instruction_file_present": status.instruction_file_present,
    }


def _tools_status_payload(router: Any) -> dict[str, dict[str, Any]]:
    raw_status = getattr(router, "tools_status", None)
    if isinstance(raw_status, dict):
        payload: dict[str, dict[str, Any]] = {}
        for name, value in raw_status.items():
            if not isinstance(name, str) or not name.strip():
                continue
            if isinstance(value, dict):
                payload[name] = {
                    "available": value.get("available") is True,
                    "reason": str(value.get("reason") or "").strip() or None,
                    "display_name": str(value.get("display_name") or name).strip() or name,
                    "source_kind": str(value.get("source_kind") or "").strip() or None,
                    "tool_family": str(value.get("tool_family") or "").strip() or None,
                    "server_name": str(value.get("server_name") or "").strip() or None,
                }
                continue
            payload[name] = {
                "available": bool(value),
                "reason": None,
                "display_name": name,
                "source_kind": None,
                "tool_family": None,
                "server_name": None,
            }
        if payload:
            return payload

    tools = getattr(router, "available_tools", [])
    if not isinstance(tools, list):
        return {}
    payload = {}
    for tool_name in tools:
        if not isinstance(tool_name, str) or not tool_name.strip():
            continue
        payload[tool_name] = {
            "available": True,
            "reason": None,
            "display_name": tool_name,
            "source_kind": None,
            "tool_family": None,
            "server_name": None,
        }
    return payload


def _configured_mcp_servers_payload(runtime_config: Any) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for config in getattr(runtime_config, "mcp_servers", ()) or ():
        name = str(getattr(config, "name", "") or "").strip()
        if not name:
            continue
        rows.append(
            {
                "name": name,
                "transport": str(getattr(config, "transport", "") or "").strip() or "stdio",
            }
        )
    return rows


def _tools_available_from_status(
    tools_status: dict[str, dict[str, Any]],
) -> list[str]:
    return [
        name
        for name, value in tools_status.items()
        if isinstance(value, dict) and value.get("available") is True
    ]


def _active_model_capabilities_payload(engine: Any) -> dict[str, bool]:
    return _shared_active_model_capabilities_payload(engine)


def _active_app_profile_payload(runtime_config: Any) -> dict[str, Any] | None:
    return _shared_active_app_profile_payload(runtime_config)


def _initialize_visible_provider_capabilities(
    provider_capabilities: dict[str, ProviderCapability],
) -> dict[str, ProviderCapability]:
    visible: dict[str, ProviderCapability] = {}
    for engine, capability in provider_capabilities.items():
        if capability.requires_secret and capability.secret_configured and not capability.available:
            visible[engine] = ProviderCapability(
                engine=capability.engine,
                available=True,
                requires_secret=capability.requires_secret,
                secret_configured=capability.secret_configured,
                reason=(
                    f"{capability.engine} engine is configured but disabled via "
                    "feature flag for execution"
                ),
                reasoning_effort_support=capability.reasoning_effort_support,
            )
            continue
        visible[engine] = capability
    return visible


def initialize_response(
    message_id: Any,
    params: Any,
    *,
    api_version: str,
    brain_container: BrainContainer,
    progress_callback: Callable[[dict[str, Any]], None] | None = None,
) -> dict[str, Any]:
    raw_config = _runtime_initialize_config(params)
    secrets = initialize_secrets(params)

    stack = (
        brain_container.configure(raw_config, secrets=secrets)
        if progress_callback is None
        else brain_container.configure(
            raw_config,
            secrets=secrets,
            progress_callback=progress_callback,
        )
    )
    try:
        ws_root = stack.config.tools_workspace_root
        cleanup_workspace_artifacts(Path(ws_root) if ws_root else None)
    except Exception:  # noqa: BLE001
        pass  # best-effort; never block initialization
    runtime_config = stack.config
    diagnostics = stack.mcp_client.diagnostics()
    workspace_status = stack.context_builder.workspace_status()
    provider_capabilities = build_provider_capabilities(runtime_config)
    initialize_provider_capabilities = _initialize_visible_provider_capabilities(
        provider_capabilities
    )
    active_model_capabilities = _active_model_capabilities_payload(stack.engine)
    tools_status = _tools_status_payload(stack.router)
    tools_available = _tools_available_from_status(tools_status)

    engine_fallback = None
    if stack.engine_fallback_from:
        engine_fallback = {
            "requested_engine": stack.engine_fallback_from,
            "reason": stack.engine_fallback_reason or "Engine initialization failed",
        }
    active_app_profile = _active_app_profile_payload(runtime_config)
    local_runtime = build_local_runtime_payload(
        runtime_config=runtime_config,
        engine=stack.engine,
        engine_fallback=engine_fallback,
    )
    compatibility_aliases = derive_legacy_runtime_aliases(
        local_runtime=local_runtime,
        active_app_profile=active_app_profile,
        active_model_capabilities=active_model_capabilities,
    )

    return {
        "jsonrpc": "2.0",
        "id": message_id,
        "api_version": api_version,
        "result": {
            "api_version": api_version,
            "server_version": SERVER_VERSION,
            "engines_available": available_engine_types(initialize_provider_capabilities),
            "provider_capabilities": provider_capabilities_payload(
                initialize_provider_capabilities
            ),
            "provider_capability_profiles": provider_capability_profiles_payload(
                getattr(stack, "provider_capability_profiles", None),
            ),
            "local_runtime": local_runtime,
            **compatibility_aliases,
            "tools_status": tools_status,
            "tools_available": tools_available,
            "mcp_servers_connected": list(diagnostics.connected),
            "mcp_servers": _configured_mcp_servers_payload(runtime_config),
            "mcp_servers_failed": [
                {"name": failure.name, "code": failure.code, "message": failure.message}
                for failure in diagnostics.failures
            ],
            "mcp_server_cooldowns": [
                {
                    "name": cooldown.name,
                    "remaining_seconds": cooldown.remaining_seconds,
                    "reason": cooldown.reason,
                }
                for cooldown in getattr(diagnostics, "cooldowns", ())
            ],
            "mcp_tools_available": tools_available,
            "modes_available": ["chat", "assist", "autonomous"],
            "active_mode": runtime_config.mode,
            "safety_mode": runtime_config.safety_mode,
            "assistant_identity": runtime_config.assistant_identity
            or {"agent_name": runtime_config.assistant_name},
            "feature_flags": runtime_config.feature_flags or {},
            "workspace_status": _workspace_status_payload(workspace_status),
            "skills_loaded": workspace_status.skills_loaded,
            "memory": {
                "db_path": str(stack.memory_store.db_path),
                **memory_store_status_payload(stack.memory_store),
            },
            "schema_versions": get_all_schema_versions(),
            "logging": {
                "schema_version": 1,
                "log_level": runtime_config.diagnostics_log_level,
                "capture_mode": runtime_config.diagnostics_capture_mode,
            },
            "hardware_summary": _cached_hardware_summary(),
        },
    }


def models_list_result(
    params: Any,
    *,
    models_for_engine: Callable[[str], list[str]],
) -> dict[str, Any]:
    engine_type = _normalized_engine_type(params)
    inspect_model_id, model_inspection = _inspection_request(params, engine_type)
    if engine_type in _ARCHIVED_CLOUD_ENGINE_TYPES:
        return _attach_model_inspection({
            "engine_type": engine_type,
            "models": [],
            "stale": False,
            "available": False,
            "reason": f"provider '{engine_type}' is archived",
        }, model_inspection)
    runtime_config = params.get("_runtime_config") if isinstance(params, dict) else None
    if engine_type == "plugin_host":
        models = params.get("_plugin_engine_models", ()) if isinstance(params, dict) else ()
        return _attach_model_inspection({
            "engine_type": engine_type,
            "models": [str(model) for model in models if isinstance(model, str)],
            "stale": False,
            "available": bool(models),
            "reason": None if models else "plugin host engine unavailable",
        }, model_inspection)
    if engine_type == "codex-cli":
        capabilities = (
            build_provider_capabilities(runtime_config) if runtime_config is not None else {}
        )
        capability = capabilities.get("codex-cli")
        models = _codex_cli_models(
            models_for_engine(engine_type),
            getattr(runtime_config, "codex_cli_models", ()) if runtime_config is not None else (),
        )
        model_entries = [
            {
                "id": model,
                "capabilities": {
                    "reasoning_effort": True,
                    "reasoning_efforts": [
                        "none", "minimal", "low", "medium", "high", "xhigh"
                    ],
                    "default_reasoning_effort": "default",
                },
            }
            for model in models
        ]
        return _attach_model_inspection({
            "engine_type": engine_type,
            "models": model_entries,
            "stale": False,
            "available": bool(capability.available) if capability is not None else False,
            "reason": (
                str(capability.reason or "")
                if capability is not None
                else "provider 'codex-cli' is unavailable"
            ),
        }, model_inspection)
    if engine_type == "chatgpt":
        capabilities = (
            build_provider_capabilities(runtime_config) if runtime_config is not None else {}
        )
        capability = capabilities.get("chatgpt")
        entitled_models = entitled_chatgpt_models(
            list(CHATGPT_MODEL_CONTEXT_LENGTHS.keys()), capability=capability
        )
        model_entries = [
            {
                "id": model,
                "capabilities": {
                    "vision": True,
                    "reasoning_effort": True,
                    **CHATGPT_MODEL_REASONING_PROFILES.get(model, {}),
                },
            }
            for model in entitled_models
        ]
        return _attach_model_inspection({
            "engine_type": engine_type,
            # A documented no-op today: without entitlement data the full catalog
            # is returned unchanged, including when signed out.
            "models": model_entries,
            "stale": False,
            "available": bool(capability.available) if capability is not None else False,
            "reason": (
                str(capability.reason or "")
                if capability is not None
                else "provider 'chatgpt' is unavailable"
            ),
        }, model_inspection)
    if isinstance(params, dict):
        if runtime_config is not None:
            capabilities = build_provider_capabilities(runtime_config)
            if not is_engine_available(capabilities, engine_type):
                unavailable_inspection = model_inspection
                if inspect_model_id and unavailable_inspection is None:
                    unavailable_inspection = _unavailable_inspection(
                        inspect_model_id, "provider_unavailable"
                    )
                return _attach_model_inspection({
                    "engine_type": engine_type,
                    "models": [],
                    "stale": False,
                    "available": False,
                    "reason": f"provider '{engine_type}' is unavailable",
                }, unavailable_inspection)

    if engine_type == "ollama":
        api_url = _runtime_api_url_for_engine(runtime_config, engine_type)
        discovery = discover_ollama_models(
            api_url=api_url,
            models_dir=getattr(runtime_config, "ollama_models_dir", None),
            state_root=getattr(runtime_config, "electron_state_root", None),
        )
        result = {
            "engine_type": engine_type,
            "models": discovery.models,
            "stale": discovery.stale,
            "available": discovery.available,
            "reason": discovery.reason,
        }
        _add_catalog_metadata(result, discovery)
        model_inspection = _resolve_ollama_inspection(
            inspect_model_id=inspect_model_id,
            existing=model_inspection,
            api_url=api_url,
        )
        return _attach_model_inspection(result, model_inspection)

    if engine_type == "vllm":
        discovery = discover_vllm_models(
            api_url=_runtime_api_url_for_engine(runtime_config, engine_type),
        )
        return _attach_model_inspection({
            "engine_type": engine_type,
            "models": discovery.models,
            "stale": False,
            "available": discovery.available,
            "reason": discovery.reason,
        }, model_inspection)

    if engine_type == "openai-compatible":
        discovery = discover_openai_compatible_models(
            api_url=_runtime_api_url_for_engine(runtime_config, engine_type),
            api_key=runtime_config.openai_compatible_api_key if runtime_config else None,
        )
        return _attach_model_inspection({
            "engine_type": engine_type,
            "models": discovery.models,
            "stale": False,
            "available": discovery.available,
            "reason": discovery.reason,
        }, model_inspection)

    return _attach_model_inspection({
        "engine_type": engine_type,
        "models": models_for_engine(engine_type),
        "stale": False,
        "available": True,
    }, model_inspection)


def _inspection_request(
    params: Any,
    engine_type: str,
) -> tuple[str, dict[str, Any] | None]:
    if not isinstance(params, dict) or "inspect_model_id" not in params:
        return "", None
    raw_model_id = params.get("inspect_model_id")
    model_id = str(raw_model_id or "").strip()
    if not model_id or len(model_id) > MAX_OLLAMA_MODEL_ID_CHARS:
        return "", _unavailable_inspection("", "invalid_model_id")
    if engine_type != "ollama":
        return model_id, _unavailable_inspection(model_id, "unsupported_engine")
    return model_id, None


def _unavailable_inspection(model_id: str, reason: str) -> dict[str, Any]:
    return {
        "model_id": model_id,
        "available": False,
        "native_context_length": None,
        "reason": reason,
    }


def _attach_model_inspection(
    result: dict[str, Any],
    inspection: dict[str, Any] | None,
) -> dict[str, Any]:
    if inspection is not None:
        result["model_inspection"] = inspection
    return result


def _resolve_ollama_inspection(
    *,
    inspect_model_id: str,
    existing: dict[str, Any] | None,
    api_url: str | None,
) -> dict[str, Any] | None:
    if not inspect_model_id:
        return existing
    return inspect_ollama_model(
        host=resolve_ollama_base_url(api_url),
        model_id=inspect_model_id,
    )


def _runtime_api_url_for_engine(runtime_config: Any, engine_type: str) -> str | None:
    if runtime_config is None:
        return None
    active_engine_type = str(getattr(runtime_config, "engine_type", "") or "").strip().lower()
    requested_engine_type = str(engine_type or "").strip().lower()
    if active_engine_type != requested_engine_type:
        return None
    return getattr(runtime_config, "api_url", None)


def _add_catalog_metadata(result: dict[str, Any], discovery: Any) -> None:
    for key in _OLLAMA_CATALOG_METADATA_FIELDS:
        value = getattr(discovery, key, None)
        if isinstance(value, str) and value.strip():
            result[key] = value.strip()


def _codex_cli_models(default_models: list[Any], configured_models: Any) -> list[str]:
    models: list[str] = []
    seen: set[str] = set()
    for raw_model in [*default_models, *(configured_models or ())]:
        token = str(raw_model or "").strip()
        if not token:
            continue
        if not token.lower().startswith("codex-cli/"):
            token = f"codex-cli/{token}"
        dedupe_key = token.lower()
        if dedupe_key in seen:
            continue
        seen.add(dedupe_key)
        models.append(token)
    return models


def _normalized_engine_type(params: Any) -> str:
    if isinstance(params, dict):
        value = params.get("engine_type")
        if isinstance(value, str) and value.strip():
            return value.strip().lower()
    return "mock"


def _runtime_initialize_config(params: Any) -> dict[str, Any]:
    """Copy ``params["config"]`` minus every credential-bearing key.

    Reads ``params`` without mutating it: the caller's request object is shared
    with ``_apply_telemetry_config``, which still needs the untouched original.
    """
    config: dict[str, Any] = {}
    if isinstance(params, dict):
        raw_config = params.get("config")
        if isinstance(raw_config, dict):
            for key, value in raw_config.items():
                if key in SECRET_CONFIG_KEYS:
                    continue
                config[key] = value

    return config


def initialize_secrets(params: Any) -> dict[str, Any]:
    """Return only the brokered secrets an initialize request may forward.

    ``telemetry_dsn`` is deliberately NOT brokered: ``_apply_telemetry_config``
    reads it straight off ``params["secrets"]`` and it must never enter a config.
    """
    if not isinstance(params, dict):
        return {}
    raw_secrets = params.get("secrets")
    if not isinstance(raw_secrets, dict):
        return {}
    secrets: dict[str, Any] = {}
    for key in sorted(BROKERED_SECRET_KEYS):
        value = raw_secrets.get(key)
        if value is None:
            continue
        secrets[key] = (
            str(value)
            if key in {"chatgpt_access_token", "openai_compatible_api_key"}
            else value
        )
    return secrets
