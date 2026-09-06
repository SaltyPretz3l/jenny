"""Probe local OpenAI-compatible server capabilities through ``GET /props``.
Strip ``/v1`` because llama-server exposes that endpoint at the server root.
"""

from __future__ import annotations

import logging
from typing import Any

from sidecar.ai.engines.provider_http import ProviderHttpService
from sidecar.runtime.diagnostics import log_event

logger = logging.getLogger(__name__)


def props_base_url(base_url: str) -> str:
    normalized = str(base_url).rstrip("/")
    return normalized[:-3] if normalized.endswith("/v1") else normalized


def probe_server_modalities(
    *,
    base_url: str,
    headers: dict[str, str] | None = None,
    timeout_seconds: float = 2.0,
) -> dict[str, Any] | None:
    probe_base_url = props_base_url(base_url)
    service: ProviderHttpService | None = None
    props: dict[str, Any] | None = None
    error: Exception | None = None
    try:
        service = ProviderHttpService(
            provider="openai-compatible",
            base_url=probe_base_url,
            headers={"Accept": "application/json", **(headers or {})},
            timeout_seconds=timeout_seconds,
        )
        candidate = service.get_json("/props", timeout=timeout_seconds)
        if not isinstance(candidate, dict):
            raise TypeError("server props response was not a JSON object")
        props = candidate
    except Exception as exc:  # noqa: BLE001 - optional capability probe never raises.
        error = exc
    finally:
        if service is not None:
            try:
                service.close()
            except Exception as exc:  # noqa: BLE001 - close failure also degrades the probe.
                error = error or exc

    if error is not None:
        log_event(
            logger,
            logging.DEBUG,
            component="ai.engines.local_server_props",
            event="ai.engines.local_server_props.probe_failed",
            message="Local server capability probe failed.",
            status="degraded",
            data={"base_url": probe_base_url, "error_type": type(error).__name__},
        )
        return None
    if not isinstance(props, dict):
        return None

    log_event(
        logger,
        logging.DEBUG,
        component="ai.engines.local_server_props",
        event="ai.engines.local_server_props.probe_succeeded",
        message="Local server capability probe succeeded.",
        status="success",
        data={
            "base_url": probe_base_url,
            "has_modalities": isinstance(props.get("modalities"), dict),
        },
    )
    return props


def vision_from_props(props: dict[str, Any] | None) -> bool | None:
    if not isinstance(props, dict):
        return None
    modalities = props.get("modalities")
    if not isinstance(modalities, dict):
        return None
    vision = modalities.get("vision")
    return vision if isinstance(vision, bool) else None


def context_length_from_props(props: dict[str, Any] | None) -> int | None:
    if not isinstance(props, dict):
        return None
    settings = props.get("default_generation_settings")
    value = settings.get("n_ctx") if isinstance(settings, dict) else None
    if isinstance(value, int) and not isinstance(value, bool) and value > 0:
        return value
    return None


__all__ = [
    "context_length_from_props",
    "probe_server_modalities",
    "props_base_url",
    "vision_from_props",
]
