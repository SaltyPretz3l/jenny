"""Canonical local-engine runtime contract helpers."""

from __future__ import annotations

from typing import Any

LOCAL_RUNTIME_CONTRACT_VERSION = "2"


def normalize_local_runtime_source(
    value: Any,
    *,
    default: str = "unknown",
) -> str:
    token = str(value or "").strip().lower()
    return token or default


def build_capability_entry(
    *,
    available: Any,
    source: Any = None,
    default_available_source: str = "runtime",
) -> dict[str, Any]:
    is_available = available is True
    default_source = default_available_source if is_available else "unsupported"
    return {
        "available": is_available,
        "source": normalize_local_runtime_source(source, default=default_source),
    }


def build_reasoning_entry(
    *,
    native_available: bool,
    native_source: Any = None,
    parser_available: bool = False,
    parser_source: str = "app_profile_reasoning_parser",
) -> dict[str, str]:
    if native_available:
        return {
            "support": "supported",
            "mode": "native",
            "source": normalize_local_runtime_source(
                native_source,
                default="runtime",
            ),
        }
    if parser_available:
        return {
            "support": "supported",
            "mode": "parser_fallback",
            "source": normalize_local_runtime_source(
                parser_source,
                default="app_profile_reasoning_parser",
            ),
        }
    return {
        "support": "unsupported",
        "mode": "unsupported",
        "source": "unsupported",
    }


def build_readiness_payload(
    *,
    ready: Any,
    model_loaded: Any,
) -> dict[str, Any]:
    is_ready = ready is True
    is_model_loaded = model_loaded is True
    return {
        "status": "ready" if is_ready else "idle",
        "ready": is_ready,
        "model_loaded": is_model_loaded,
    }


def build_engine_fallback_payload(
    value: Any = None,
    *,
    requested_engine: Any = None,
    reason: Any = None,
) -> dict[str, Any]:
    payload = value if isinstance(value, dict) else {}
    normalized_requested_engine = str(
        payload.get("requested_engine") or requested_engine or ""
    ).strip()
    normalized_reason = str(payload.get("reason") or reason or "").strip()
    active = bool(normalized_requested_engine and normalized_reason)
    return {
        "active": active,
        "requested_engine": normalized_requested_engine or None,
        "reason": normalized_reason or None,
    }
