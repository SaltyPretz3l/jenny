"""Model catalog helpers used by models.list."""

from __future__ import annotations

import logging
import time
import urllib.parse
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from sidecar.ai.engines.local_server_props import probe_server_modalities, vision_from_props
from sidecar.ai.engines.model_name import (
    THINKING_MODEL_PREFIXES,
    VISION_MODEL_PREFIXES,
    VLLM_VISION_MODEL_PREFIXES,
    advertised_capability_source,
    canonical_model_token,
    extract_family_tokens,
    is_qwen38_model,
    model_token_matches,
    supports_ollama_reasoning_levels,
)
from sidecar.ai.engines.ollama_catalog_cache import (
    load_ollama_catalog_cache,
    resolve_ollama_catalog_cache_path,
    write_ollama_catalog_cache,
)
from sidecar.ai.engines.provider_http import ProviderHttpError, ProviderHttpService
from sidecar.runtime.diagnostics import log_event

logger = logging.getLogger(__name__)

# IPv4 literal, not "localhost": on Windows, getaddrinfo("localhost") often
# returns ::1 (AAAA) first, and Ollama/vLLM typically bind only to 127.0.0.1.
# The IPv6 SYN takes ~2s to time out before the IPv4 fallback runs — and
# because the sidecar's main RPC loop is single-threaded, that stall blocks
# every other RPC behind it.
_DEFAULT_OLLAMA_HOST = "http://127.0.0.1:11434"
_DEFAULT_VLLM_HOST = "http://127.0.0.1:8000"
_DEFAULT_OPENAI_COMPAT_HOST = "http://127.0.0.1:8033"
_VLLM_DISCOVERY_TIMEOUT_SECONDS = 3.0
_OPENAI_COMPAT_DISCOVERY_TIMEOUT_SECONDS = 3.0
_OLLAMA_DISCOVERY_TIMEOUT_SECONDS = 2.0
_OLLAMA_DISCOVERY_TOTAL_BUDGET_SECONDS = 7.0
_OLLAMA_DISCOVERY_RETRY_ATTEMPTS = 1
_OLLAMA_DISCOVERY_RETRY_BACKOFF_SECONDS = 0.2
_CATALOG_SOURCE_API = "api"
_CATALOG_SOURCE_CACHE = "cache"
_CATALOG_SOURCE_MANIFEST = "manifest"
# Fill-in-the-middle (suffix-aware) coder model families, used as a name-based
# fallback when Ollama's /api/tags entry omits the "insert" capability token.
# These are the `-base` coder variants that support FIM completion; the instruct
# variants generally do not, so the suffix check below keeps it conservative.
_FIM_MODEL_PREFIXES = (
    "qwen2.5-coder",
    "qwen3-coder",
    "qwen2.5coder",
    "deepseek-coder",
    "deepseek-coder-v2",
    "starcoder2",
    "starcoder",
    "codegemma",
    "codellama",
    "stable-code",
    "codeqwen",
)
ModelCatalogEntry = str | dict[str, Any]


@dataclass(frozen=True)
class ModelCatalogResult:
    models: list[ModelCatalogEntry]
    available: bool
    reason: str = ""
    source: str = ""
    cached_at: str | None = None
    expires_at: str | None = None
    stale: bool = False
    last_error: str | None = None
    daemon_version: str | None = None


def _provider_failure_reason(prefix: str, base_url: str, error: ProviderHttpError) -> str:
    return f"{prefix} at {base_url}: {error.classification or error.code}"


def _provider_failure_token(error: ProviderHttpError) -> str:
    return str(error.classification or error.code or type(error).__name__).strip()


def _provider_failure_data(base_url: str, error: ProviderHttpError) -> dict[str, str]:
    return {
        "base_url": base_url,
        "error_type": type(error).__name__,
        "classification": error.classification,
    }


def _get_provider_json(
    *,
    provider: str,
    base_url: str,
    path: str,
    timeout_seconds: float,
    headers: dict[str, str] | None = None,
) -> dict[str, Any]:
    service = ProviderHttpService(
        provider=provider,
        base_url=base_url,
        headers={"Accept": "application/json", **(headers or {})},
        timeout_seconds=timeout_seconds,
    )
    try:
        return service.get_json(path)
    finally:
        service.close()


def _force_ipv4_localhost(url: str) -> str:
    # Same Windows-IPv6 reason as _DEFAULT_OLLAMA_HOST above: a user-supplied
    # "http://localhost:11434" hits the same SYN-stall path.
    parsed = urllib.parse.urlsplit(url)
    hostname = parsed.hostname or ""
    if hostname.casefold() != "localhost":
        return url
    host_start = parsed.netloc.rfind("@") + 1
    host_end = host_start + len(hostname)
    netloc = f"{parsed.netloc[:host_start]}127.0.0.1{parsed.netloc[host_end:]}"
    return urllib.parse.urlunsplit(parsed._replace(netloc=netloc))


def resolve_ollama_base_url(api_url: str | None = None) -> str:
    normalized = str(api_url or "").strip().rstrip("/")
    return _force_ipv4_localhost(normalized) if normalized else _DEFAULT_OLLAMA_HOST


def _fetch_ollama_tags_within_budget(
    *,
    base_url: str,
    timeout_seconds: float,
    deadline: float,
) -> tuple[dict[str, Any] | None, ProviderHttpError | None]:
    payload: dict[str, Any] | None = None
    last_error: ProviderHttpError | None = None
    for attempt in range(_OLLAMA_DISCOVERY_RETRY_ATTEMPTS + 1):
        remaining_seconds = deadline - time.monotonic()
        if remaining_seconds <= 0:
            break
        try:
            payload = _get_provider_json(
                provider="ollama",
                base_url=base_url,
                path="/api/tags",
                timeout_seconds=min(timeout_seconds, remaining_seconds),
            )
            last_error = None
            break
        except ProviderHttpError as error:
            last_error = error
            if attempt >= _OLLAMA_DISCOVERY_RETRY_ATTEMPTS or not error.retryable:
                break
            log_event(
                logger,
                logging.INFO,
                component="ai.engines.catalog",
                event="ai.engines.catalog.ollama_discovery_retry",
                message="Retrying transient Ollama model discovery failure",
                status="retry",
                data=_provider_failure_data(base_url, error),
            )
            remaining_seconds = deadline - time.monotonic()
            if remaining_seconds > _OLLAMA_DISCOVERY_RETRY_BACKOFF_SECONDS:
                time.sleep(_OLLAMA_DISCOVERY_RETRY_BACKOFF_SECONDS)
    return payload, last_error


def _read_daemon_version_within(
    *,
    base_url: str,
    timeout_seconds: float,
    deadline: float,
) -> str | None:
    remaining_seconds = deadline - time.monotonic()
    if remaining_seconds <= 0:
        return None
    return _read_ollama_daemon_version(
        base_url=base_url,
        timeout_seconds=min(timeout_seconds, remaining_seconds),
    )


def discover_ollama_models(
    *,
    api_url: str | None = None,
    models_dir: str | None = None,
    state_root: str | None = None,
    timeout_seconds: float = _OLLAMA_DISCOVERY_TIMEOUT_SECONDS,
) -> ModelCatalogResult:
    deadline = time.monotonic() + _OLLAMA_DISCOVERY_TOTAL_BUDGET_SECONDS
    base_url = resolve_ollama_base_url(api_url)
    payload, last_error = _fetch_ollama_tags_within_budget(
        base_url=base_url,
        timeout_seconds=timeout_seconds,
        deadline=deadline,
    )

    if last_error is not None:
        cache_path = resolve_ollama_catalog_cache_path(state_root)
        cached_catalog = load_ollama_catalog_cache(
            cache_path=cache_path,
            base_url=base_url,
            daemon_version=None,
        )
        if cached_catalog is not None:
            daemon_version = _read_daemon_version_within(
                base_url=base_url,
                timeout_seconds=timeout_seconds,
                deadline=deadline,
            )
            if daemon_version is not None:
                cached_catalog = load_ollama_catalog_cache(
                    cache_path=cache_path,
                    base_url=base_url,
                    daemon_version=daemon_version,
                )

        if cached_catalog is not None:
            reason = "Using cached Ollama catalog after API query failed"
            log_event(
                logger,
                logging.INFO,
                component="ai.engines.catalog",
                event="ai.engines.catalog.ollama_cache_fallback_succeeded",
                message=reason,
                status="success",
                data={
                    "base_url": base_url,
                    "daemon_version": cached_catalog.daemon_version,
                    "error_type": type(last_error).__name__,
                    "model_count": len(cached_catalog.models),
                },
            )
            return ModelCatalogResult(
                models=cached_catalog.models,
                available=True,
                reason=reason,
                source=_CATALOG_SOURCE_CACHE,
                cached_at=cached_catalog.cached_at,
                expires_at=cached_catalog.expires_at,
                stale=True,
                last_error=_provider_failure_token(last_error),
                daemon_version=cached_catalog.daemon_version,
            )

        fallback_models: list[ModelCatalogEntry] = list(discover_ollama_manifest_models(models_dir))
        if fallback_models:
            reason = (
                f"Using local Ollama manifests from "
                f"{_resolve_ollama_manifest_library_dir(models_dir)} after API query failed"
            )
            log_event(
                logger,
                logging.INFO,
                component="ai.engines.catalog",
                event="ai.engines.catalog.ollama_manifest_fallback_succeeded",
                message=reason,
                status="success",
                data={
                    "base_url": base_url,
                    "error_type": type(last_error).__name__,
                    "model_count": len(fallback_models),
                },
            )
            return ModelCatalogResult(
                models=fallback_models,
                available=True,
                reason=reason,
                source=_CATALOG_SOURCE_MANIFEST,
                last_error=_provider_failure_token(last_error),
            )

        reason = _provider_failure_reason("Could not query Ollama", base_url, last_error)
        log_event(
            logger,
            logging.WARNING,
            component="ai.engines.catalog",
            event="ai.engines.catalog.ollama_discovery_failed",
            message=reason,
            status="failure",
            data=_provider_failure_data(base_url, last_error),
        )
        return ModelCatalogResult(
            models=[],
            available=False,
            reason=reason,
            source=_CATALOG_SOURCE_API,
            last_error=_provider_failure_token(last_error),
        )

    if payload is None:
        payload = {}

    models = _parse_ollama_tags_payload(payload)
    if models is None:
        reason = f"Ollama at {base_url} returned an invalid model catalog payload"
        log_event(
            logger,
            logging.WARNING,
            component="ai.engines.catalog",
            event="ai.engines.catalog.ollama_discovery_invalid_payload",
            message=reason,
            status="failure",
            data={"base_url": base_url},
        )
        return ModelCatalogResult(
            models=[],
            available=False,
            reason=reason,
            source=_CATALOG_SOURCE_API,
            last_error="invalid_payload",
        )

    daemon_version = _read_daemon_version_within(
        base_url=base_url,
        timeout_seconds=timeout_seconds,
        deadline=deadline,
    )
    cache_hit = write_ollama_catalog_cache(
        cache_path=resolve_ollama_catalog_cache_path(state_root),
        base_url=base_url,
        daemon_version=daemon_version,
        models=models,
    )
    if cache_hit is not None:
        daemon_version = cache_hit.daemon_version

    log_event(
        logger,
        logging.DEBUG,
        component="ai.engines.catalog",
        event="ai.engines.catalog.ollama_discovery_succeeded",
        message=f"Discovered {len(models)} Ollama model(s)",
        status="success",
        data={
            "base_url": base_url,
            "daemon_version": daemon_version,
            "model_count": len(models),
        },
    )
    return ModelCatalogResult(
        models=models,
        available=True,
        source=_CATALOG_SOURCE_API,
        cached_at=cache_hit.cached_at if cache_hit is not None else None,
        expires_at=cache_hit.expires_at if cache_hit is not None else None,
        stale=False,
        daemon_version=daemon_version,
    )


def _read_ollama_daemon_version(
    *,
    base_url: str,
    timeout_seconds: float,
) -> str | None:
    try:
        payload = _get_provider_json(
            provider="ollama",
            base_url=base_url,
            path="/api/version",
            timeout_seconds=timeout_seconds,
        )
    except ProviderHttpError:
        return None
    if not isinstance(payload, dict):
        return None
    version = str(payload.get("version") or "").strip()
    return version or None


def _parse_ollama_tags_payload(payload: Any) -> list[ModelCatalogEntry] | None:
    if not isinstance(payload, dict):
        return None
    raw_models = payload.get("models")
    if not isinstance(raw_models, list):
        return None
    models: list[ModelCatalogEntry] = []
    for entry in raw_models:
        normalized = _normalize_ollama_catalog_entry(entry)
        if normalized is not None:
            models.append(normalized)
    return models


def resolve_template_diagnostics(
    model_name: str,
    info: dict[str, Any] | None,
) -> dict[str, Any]:
    """Resolve template diagnostics for a loaded Ollama model.

    Thin delegation to ``ollama_templates.template_diagnostics`` so that
    engine modules can call through ``catalog`` without adding a direct
    import of ``ollama_templates`` (avoids import fan-out violations).
    """
    from sidecar.ai.engines.ollama_templates import template_diagnostics  # noqa: PLC0415

    return template_diagnostics(model_name, info)


def _resolve_entry_template_family(entry: dict[str, Any]) -> str:
    """Resolve the template family name from catalog entry metadata."""
    details = entry.get("details")
    if not isinstance(details, dict):
        return ""
    try:
        from sidecar.ai.engines.ollama_templates import resolve_template  # noqa: PLC0415

        family = str(details.get("family") or "").strip().lower()
        families_raw = details.get("families")
        families = (
            [str(f).strip().lower() for f in families_raw if str(f).strip()]
            if isinstance(families_raw, list)
            else []
        )
        resolved = resolve_template(family=family, families=families)
        return resolved.family if resolved else ""
    except Exception:  # noqa: BLE001
        return ""


def _coerce_positive_model_size(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, float) and not value.is_integer():
        return None
    try:
        size = int(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return size if size > 0 else None


def _bounded_entry_str(value: Any, max_len: int) -> str:
    text = str(value or "").strip()
    return text[:max_len] if text else ""


def _normalize_ollama_catalog_entry(entry: Any) -> ModelCatalogEntry | None:
    if not isinstance(entry, dict):
        return None
    model_name = str(entry.get("name") or "").strip()
    if not model_name:
        return None
    capabilities: dict[str, Any] = {}
    if _entry_supports_vision(model_name, entry):
        capabilities["vision"] = True
    if _entry_supports_thinking(model_name, entry):
        capabilities.update(_ollama_thinking_capabilities(model_name))
    if _entry_supports_fim(model_name, entry):
        capabilities["insert"] = True

    template_family = _resolve_entry_template_family(entry)
    size = _coerce_positive_model_size(entry.get("size"))
    raw_details = entry.get("details")
    details: dict[str, Any] = raw_details if isinstance(raw_details, dict) else {}
    # Model-fit estimator inputs (Wave 1): parameter count + quantization from
    # /api/tags details, plus digest for identity. Bounded like every other
    # cached string field; absent unless the upstream payload actually has them.
    parameter_size = _bounded_entry_str(details.get("parameter_size"), 32)
    quantization_level = _bounded_entry_str(details.get("quantization_level"), 32)
    digest = _bounded_entry_str(entry.get("digest"), 128)

    if capabilities or template_family or size is not None or parameter_size or quantization_level or digest:
        result: dict[str, Any] = {"id": model_name}
        if capabilities:
            result["capabilities"] = capabilities
        if template_family:
            result["template_family"] = template_family
        if size is not None:
            result["size"] = size
        if parameter_size:
            result["parameter_size"] = parameter_size
        if quantization_level:
            result["quantization_level"] = quantization_level
        if digest:
            result["digest"] = digest
        return result
    return model_name


def _entry_supports_vision(model_name: str, entry: dict[str, Any]) -> bool:
    if advertised_capability_source(entry, "vision"):
        return True
    if any(_is_likely_vision_model(token) for token, _source in extract_family_tokens(entry)):
        return True
    return _is_likely_vision_model(model_name)


def _entry_supports_thinking(model_name: str, entry: dict[str, Any]) -> bool:
    if advertised_capability_source(entry, "thinking"):
        return True
    if any(_is_likely_thinking_model(token) for token, _source in extract_family_tokens(entry)):
        return True
    return _is_likely_thinking_model(model_name)


def _ollama_thinking_capabilities(model_name: str) -> dict[str, Any]:
    capabilities: dict[str, Any] = {
        "thinking": True,
        "reasoning_effort": True,
        "reasoning_efforts": ["none"],
        "default_reasoning_effort": "default",
    }
    if supports_ollama_reasoning_levels(model_name):
        capabilities["reasoning_efforts"] = ["none", "low", "medium", "high", "max"]
        capabilities["default_reasoning_effort"] = "medium"
    return capabilities


def _entry_supports_fim(model_name: str, entry: dict[str, Any]) -> bool:
    """Whether a model supports fill-in-the-middle (suffix-aware) completion.

    Ollama's /api/tags reports FIM-capable models with an ``"insert"`` capability
    token (alongside ``"completion"``); prefer that signal at both the top level
    and under ``details``. Fall back to the ``-base`` coder name heuristic for
    catalog sources (manifest scan / older daemons) that omit capabilities.
    """
    if advertised_capability_source(entry, "insert"):
        return True
    return _is_likely_fim_model(model_name)


def _is_likely_fim_model(model_name: str) -> bool:
    normalized = canonical_model_token(model_name)
    if not normalized:
        return False
    return any(normalized.startswith(prefix) for prefix in _FIM_MODEL_PREFIXES)


def _is_likely_vision_model(model_name: str) -> bool:
    return model_token_matches(
        canonical_model_token(model_name),
        marker="vision",
        prefixes=VISION_MODEL_PREFIXES,
    )


def is_vllm_vision_model(model_name: str) -> bool:
    """Return whether a vLLM/OpenAI-style model ID likely supports vision."""
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


def _is_likely_thinking_model(model_name: str) -> bool:
    return model_token_matches(
        canonical_model_token(model_name),
        marker="thinking",
        prefixes=THINKING_MODEL_PREFIXES,
    )


def resolve_vllm_base_url(api_url: str | None = None) -> str:
    """Resolve the vLLM server base URL from an optional override."""
    normalized = str(api_url or "").strip().rstrip("/")
    return _force_ipv4_localhost(normalized) if normalized else _DEFAULT_VLLM_HOST


def resolve_openai_compatible_base_url(api_url: str | None = None) -> str:
    """Resolve the OpenAI-compatible server base URL from an optional override.

    The returned URL never includes the ``/v1`` suffix — discovery/engines
    append path components themselves. Accepts either form as input.
    """
    normalized = str(api_url or "").strip().rstrip("/")
    if normalized.endswith("/v1"):
        normalized = normalized[:-3]
    return _force_ipv4_localhost(normalized) if normalized else _DEFAULT_OPENAI_COMPAT_HOST


def discover_vllm_models(
    *,
    api_url: str | None = None,
    timeout_seconds: float = _VLLM_DISCOVERY_TIMEOUT_SECONDS,
) -> ModelCatalogResult:
    """Discover models served by a running vLLM instance via /v1/models."""
    base_url = resolve_vllm_base_url(api_url)
    try:
        payload = _get_provider_json(
            provider="vllm",
            base_url=base_url,
            path="/v1/models",
            timeout_seconds=timeout_seconds,
        )
    except ProviderHttpError as error:
        reason = _provider_failure_reason("Could not query vLLM", base_url, error)
        log_event(
            logger,
            logging.WARNING,
            component="ai.engines.catalog",
            event="ai.engines.catalog.vllm_discovery_failed",
            message=reason,
            status="failure",
            data=_provider_failure_data(base_url, error),
        )
        return ModelCatalogResult(models=[], available=False, reason=reason)

    models = _parse_vllm_models_payload(payload)
    if models is None:
        return _invalid_models_payload_result(provider="vllm", base_url=base_url)
    log_event(
        logger,
        logging.INFO,
        component="ai.engines.catalog",
        event="ai.engines.catalog.vllm_discovery_succeeded",
        message=f"Discovered {len(models)} vLLM model(s)",
        status="success",
        data={"base_url": base_url, "model_count": len(models)},
    )
    return ModelCatalogResult(models=models, available=True)


def discover_openai_compatible_models(
    *,
    api_url: str | None = None,
    api_key: str | None = None,
    timeout_seconds: float = _OPENAI_COMPAT_DISCOVERY_TIMEOUT_SECONDS,
) -> ModelCatalogResult:
    """Discover models served by an OpenAI-compatible server (e.g. llama-server).

    ``api_key`` is the managed llama-server's per-launch key; the same bearer
    header the chat engine sends, because a keyed server answers 401 to the
    unauthenticated ``/v1/models`` probe and would otherwise read as down.
    """
    base_url = resolve_openai_compatible_base_url(api_url)
    headers = {"Authorization": f"Bearer {api_key}"} if api_key else None
    try:
        payload = _get_provider_json(
            provider="openai-compatible",
            base_url=base_url,
            path="/v1/models",
            timeout_seconds=timeout_seconds,
            headers=headers,
        )
    except ProviderHttpError as error:
        reason = _provider_failure_reason(
            "Could not query OpenAI-compatible server", base_url, error
        )
        log_event(
            logger,
            logging.WARNING,
            component="ai.engines.catalog",
            event="ai.engines.catalog.openai_compatible_discovery_failed",
            message=reason,
            status="failure",
            data=_provider_failure_data(base_url, error),
        )
        return ModelCatalogResult(models=[], available=False, reason=reason)

    models = _parse_vllm_models_payload(payload, openai_compatible_controls=True)
    if models is None:
        return _invalid_models_payload_result(
            provider="openai_compatible",
            base_url=base_url,
        )
    props_vision = vision_from_props(
        probe_server_modalities(
            base_url=base_url,
            headers=headers,
            timeout_seconds=timeout_seconds,
        )
    )
    # /props answers for the one model the server holds: stamp its verdict on
    # every row, false included — an absent flag reads as "unknown" downstream
    # (renderer soft notice), a False flag as evidence (Send blocked).
    if props_vision is not None:
        for index, model in enumerate(models):
            if isinstance(model, str):
                models[index] = {"id": model, "capabilities": {"vision": props_vision}}
                continue
            capabilities = model.get("capabilities")
            if not isinstance(capabilities, dict):
                capabilities = {}
                model["capabilities"] = capabilities
            capabilities["vision"] = props_vision
    log_event(
        logger,
        logging.INFO,
        component="ai.engines.catalog",
        event="ai.engines.catalog.openai_compatible_discovery_succeeded",
        message=f"Discovered {len(models)} OpenAI-compatible model(s)",
        status="success",
        data={"base_url": base_url, "model_count": len(models)},
    )
    return ModelCatalogResult(models=models, available=True)


def _invalid_models_payload_result(*, provider: str, base_url: str) -> ModelCatalogResult:
    reason = "invalid_payload"
    log_event(
        logger,
        logging.WARNING,
        component="ai.engines.catalog",
        event=f"ai.engines.catalog.{provider}_discovery_invalid_payload",
        message=f"Model discovery returned an invalid payload from {base_url}",
        status="failure",
        data={"base_url": base_url},
    )
    return ModelCatalogResult(models=[], available=False, reason=reason)


def _parse_vllm_models_payload(
    payload: Any,
    *,
    openai_compatible_controls: bool = False,
) -> list[ModelCatalogEntry] | None:
    """Parse an OpenAI-format ``/v1/models`` response.

    Unmanaged OpenAI-compatible servers may be llama-server. Qwen3.8 GGUF chat
    templates accept the native ``low``, ``medium``, and ``xhigh`` effort
    values; other recognized thinking models retain the conservative boolean
    control. Leave vLLM's existing catalog contract unchanged.
    """
    if not isinstance(payload, dict):
        return None
    data = payload.get("data")
    if not isinstance(data, list):
        return None
    models: list[ModelCatalogEntry] = []
    for entry in data:
        if not isinstance(entry, dict):
            continue
        model_id = str(entry.get("id") or "").strip()
        if model_id:
            capabilities: dict[str, Any] = {}
            if is_vllm_vision_model(model_id):
                capabilities["vision"] = True
            if _is_likely_thinking_model(model_id):
                capabilities["thinking"] = True
                if openai_compatible_controls:
                    capabilities.update(_openai_compatible_thinking_capabilities(model_id))
            if capabilities:
                models.append({"id": model_id, "capabilities": capabilities})
            else:
                models.append(model_id)
    return models


def _openai_compatible_thinking_capabilities(model_name: str) -> dict[str, Any]:
    if is_qwen38_model(model_name):
        return {
            "reasoning_effort": True,
            "reasoning_efforts": ["none", "low", "medium", "xhigh"],
            "default_reasoning_effort": "medium",
        }
    return {
        "reasoning_effort": True,
        "reasoning_efforts": ["none"],
        "default_reasoning_effort": "default",
    }


def discover_ollama_manifest_models(models_dir: str | None = None) -> list[ModelCatalogEntry]:
    library_dir = _resolve_ollama_manifest_library_dir(models_dir)
    if library_dir is None or not library_dir.is_dir():
        return []

    models: list[ModelCatalogEntry] = []
    model_dirs = sorted(
        (path for path in library_dir.iterdir() if path.is_dir()),
        key=lambda path: path.name.lower(),
    )
    for model_dir in model_dirs:
        tag_paths = sorted(
            (path for path in model_dir.iterdir() if path.is_file()),
            key=lambda path: path.name.lower(),
        )
        for tag_path in tag_paths:
            model_name = f"{model_dir.name}:{tag_path.name}"
            if model_name:
                capabilities: dict[str, Any] = {}
                if _is_likely_vision_model(model_name):
                    capabilities["vision"] = True
                if _is_likely_thinking_model(model_name):
                    capabilities.update(_ollama_thinking_capabilities(model_name))
                if capabilities:
                    models.append({"id": model_name, "capabilities": capabilities})
                else:
                    models.append(model_name)
    return models


def _resolve_ollama_manifest_library_dir(models_dir: str | None = None) -> Path | None:
    raw_dir = str(models_dir or "").strip()
    candidate_roots: list[Path] = []
    if raw_dir:
        candidate_roots.append(Path(raw_dir).expanduser())
    candidate_roots.append(Path.home() / ".ollama" / "models")
    candidate_roots.append(Path.home() / "AppData" / "Local" / "Ollama" / "models")

    candidate_paths: list[Path] = []
    for root in candidate_roots:
        candidate_paths.extend(
            [
                root / "manifests" / "registry.ollama.ai" / "library",
                root / "registry.ollama.ai" / "library",
            ]
        )

    for path in candidate_paths:
        if path.is_dir():
            return path
    return None


def models_for_engine(engine_type: str) -> list[str]:
    normalized = engine_type.strip().lower()
    defaults: dict[str, list[str]] = {
        "mock": ["mock-v1", "mock-v2"],
        "vllm": ["Qwen/Qwen3.5-9B", "Qwen/Qwen2.5-VL-7B-Instruct"],
        "openai-compatible": [],
        "codex-cli": ["codex-cli/default"],
        "replay": ["replay-default"],
        "plugin_host": [],
    }
    return defaults.get(normalized, ["mock-v1"])
