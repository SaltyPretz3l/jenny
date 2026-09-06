"""Shared local-engine snapshot helpers."""

from __future__ import annotations

from typing import Any

from .contracts import (
    LOCAL_RUNTIME_CONTRACT_VERSION,
    build_capability_entry,
    build_engine_fallback_payload,
    build_readiness_payload,
    build_reasoning_entry,
    normalize_local_runtime_source,
)


def _positive_int(value: Any) -> int | None:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed > 0 else None


def context_metadata_payload(
    *,
    configured_context_length: Any,
    native_context_length: Any,
) -> dict[str, int | None]:
    configured = _positive_int(configured_context_length)
    native = _positive_int(native_context_length)
    effective: int | None
    if configured is not None and native is not None:
        effective = min(configured, native)
    else:
        effective = configured or native
    return {
        "configured_context_length": configured,
        "native_context_length": native,
        "effective_context_length": effective,
    }


def active_template_diagnostics_payload(engine: Any) -> dict[str, object] | None:
    diagnostics = getattr(engine, "_template_diagnostics", None)
    if isinstance(diagnostics, dict) and diagnostics:
        return dict(diagnostics)
    return None


def active_model_capabilities_payload(engine: Any) -> dict[str, bool]:
    capabilities = getattr(engine, "capabilities", {})
    if not isinstance(capabilities, dict):
        return {}
    return {
        str(key).strip(): True
        for key, value in capabilities.items()
        if str(key).strip() and value is True
    }


def active_app_profile_payload(runtime_config: Any) -> dict[str, Any] | None:
    family = str(getattr(runtime_config, "resolved_app_profile_family", "") or "").strip()
    if not family:
        return None
    variant = str(getattr(runtime_config, "resolved_app_profile_variant", "") or "").strip()
    parser_start = str(
        getattr(runtime_config, "resolved_app_profile_reasoning_parser_start", "") or ""
    ).strip()
    parser_end = str(
        getattr(runtime_config, "resolved_app_profile_reasoning_parser_end", "") or ""
    ).strip()
    return {
        "family": family,
        "variant": variant or None,
        "temperature": getattr(runtime_config, "resolved_app_profile_temperature", None),
        "top_k": getattr(runtime_config, "resolved_app_profile_top_k", None),
        "reasoning_parser": {
            "start": parser_start or None,
            "end": parser_end or None,
        },
    }


def _engine_capability_sources(engine: Any) -> dict[str, str]:
    raw_sources = getattr(engine, "_local_runtime_capability_sources", None)
    sources = dict(raw_sources) if isinstance(raw_sources, dict) else {}
    legacy_thinking = str(getattr(engine, "_thinking_capability_source", "") or "").strip()
    if legacy_thinking and "thinking" not in sources:
        sources["thinking"] = legacy_thinking
    return {
        str(key).strip(): normalize_local_runtime_source(value)
        for key, value in sources.items()
        if str(key).strip()
    }


def _engine_model_context_length(engine: Any) -> int | None:
    getter = getattr(engine, "get_model_context_length", None)
    if callable(getter):
        return _positive_int(getter())
    return _positive_int(getattr(engine, "_context_length", None))


def _engine_supports_tool_calling(engine: Any) -> bool:
    supports = getattr(engine, "supports_tool_calling", False)
    if callable(supports):
        try:
            return bool(supports())
        except TypeError:
            return bool(supports)
    return supports is True


def build_local_runtime_payload(
    *,
    runtime_config: Any,
    engine: Any,
    engine_fallback: dict[str, Any] | None = None,
) -> dict[str, Any]:
    app_profile = active_app_profile_payload(runtime_config)
    capability_sources = _engine_capability_sources(engine)
    active_capabilities = active_model_capabilities_payload(engine)
    loaded_model = str(getattr(engine, "model_name", "") or "").strip()
    configured_model = str(getattr(runtime_config, "model", "") or "").strip()
    effective_model = loaded_model or configured_model
    ready_flag = getattr(engine, "_ready", None)
    has_explicit_readiness = isinstance(ready_flag, bool)
    model_loaded = ready_flag if has_explicit_readiness else bool(loaded_model)
    context = context_metadata_payload(
        configured_context_length=getattr(runtime_config, "context_length", None),
        native_context_length=_engine_model_context_length(engine),
    )
    fallback = build_engine_fallback_payload(engine_fallback)
    parser_config = app_profile.get("reasoning_parser") if isinstance(app_profile, dict) else None
    parser_available = (
        isinstance(parser_config, dict)
        and bool(parser_config.get("start"))
        and bool(parser_config.get("end"))
    )
    thinking_entry = build_capability_entry(
        available=active_capabilities.get("thinking") is True,
        source=capability_sources.get("thinking"),
    )
    return {
        "contract_version": LOCAL_RUNTIME_CONTRACT_VERSION,
        "engine": {
            "type": str(getattr(runtime_config, "engine_type", "") or "").strip(),
        },
        "model": {
            "id": effective_model or None,
            "loaded": model_loaded,
        },
        "readiness": build_readiness_payload(
            ready=ready_flag if has_explicit_readiness else model_loaded,
            model_loaded=model_loaded,
        ),
        "fallback": fallback,
        "capabilities": {
            "text": build_capability_entry(
                available=active_capabilities.get("text") is True,
                source=capability_sources.get("text"),
                default_available_source="engine_default",
            ),
            "vision": build_capability_entry(
                available=active_capabilities.get("vision") is True,
                source=capability_sources.get("vision"),
            ),
            "tool_calling": build_capability_entry(
                available=_engine_supports_tool_calling(engine),
                source=capability_sources.get("tool_calling"),
                default_available_source="engine_default",
            ),
            "thinking": thinking_entry,
        },
        "reasoning": build_reasoning_entry(
            native_available=thinking_entry["available"] is True,
            native_source=thinking_entry["source"],
            parser_available=parser_available,
        ),
        "context": context,
        "template_diagnostics": active_template_diagnostics_payload(engine),
    }


def derive_legacy_runtime_aliases(
    *,
    local_runtime: dict[str, Any],
    active_app_profile: dict[str, Any] | None,
    active_model_capabilities: dict[str, bool],
) -> dict[str, Any]:
    context = local_runtime.get("context") if isinstance(local_runtime, dict) else {}
    fallback = local_runtime.get("fallback") if isinstance(local_runtime, dict) else {}
    return {
        "active_engine": str(
            ((local_runtime.get("engine") or {}) if isinstance(local_runtime, dict) else {}).get(
                "type"
            )
            or ""
        ),
        "active_model": str(
            ((local_runtime.get("model") or {}) if isinstance(local_runtime, dict) else {}).get(
                "id"
            )
            or ""
        ),
        "active_app_profile": active_app_profile,
        "active_model_capabilities": active_model_capabilities,
        "active_model_reasoning_support": str(
            ((local_runtime.get("reasoning") or {}) if isinstance(local_runtime, dict) else {}).get(
                "support"
            )
            or "unsupported"
        ),
        "configured_context_length": context.get("configured_context_length")
        if isinstance(context, dict)
        else None,
        "native_context_length": context.get("native_context_length")
        if isinstance(context, dict)
        else None,
        "effective_context_length": context.get("effective_context_length")
        if isinstance(context, dict)
        else None,
        "engine_fallback": (
            {
                "requested_engine": fallback.get("requested_engine"),
                "reason": fallback.get("reason"),
            }
            if isinstance(fallback, dict) and fallback.get("active") is True
            else None
        ),
        "template_diagnostics": (
            local_runtime.get("template_diagnostics") if isinstance(local_runtime, dict) else None
        ),
    }
