"""Derived Ollama model catalog cache.

The live Ollama daemon remains authoritative. This cache only preserves the
last successfully discovered catalog so ``models.list`` can stay useful after a
sidecar restart when the daemon is temporarily unreachable.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit, urlunsplit

from sidecar.ai.utils.coercion import coerce_optional_int
from sidecar.ai.utils.json_io import write_json_atomic

SCHEMA_VERSION = 1
CACHE_FILENAME = "ollama-catalog.json"
CACHE_TTL_SECONDS = 24 * 60 * 60
UNKNOWN_DAEMON_VERSION = "unknown"
MAX_CACHE_MODELS = 512
MAX_CACHE_MODEL_ID_CHARS = 256
MAX_CACHE_TEMPLATE_FAMILY_CHARS = 64
MAX_CACHE_PARAMETER_SIZE_CHARS = 32
MAX_CACHE_QUANTIZATION_LEVEL_CHARS = 32
MAX_CACHE_DIGEST_CHARS = 128
_CACHE_BOOLEAN_CAPABILITY_KEYS = frozenset({"thinking", "vision", "insert", "reasoning_effort"})
_CACHE_REASONING_EFFORTS = frozenset({"none", "minimal", "low", "medium", "high", "xhigh", "max"})


@dataclass(frozen=True)
class OllamaCatalogCacheHit:
    models: list[Any]
    cached_at: str
    expires_at: str
    daemon_version: str


def resolve_ollama_catalog_cache_path(state_root: str | Path | None = None) -> Path:
    root_value = str(state_root or "").strip()
    root = Path(root_value).expanduser() if root_value else Path.home() / ".companion"
    return root / CACHE_FILENAME


def normalize_ollama_catalog_base_url(base_url: str) -> str:
    normalized = str(base_url or "").strip().rstrip("/")
    if not normalized:
        return normalized
    try:
        parsed = urlsplit(normalized)
        hostname = parsed.hostname or ""
        port = parsed.port
    except ValueError:
        return normalized
    if not parsed.scheme or not hostname:
        return normalized

    safe_host = hostname.lower()
    if ":" in safe_host and not safe_host.startswith("["):
        safe_host = f"[{safe_host}]"
    netloc = f"{safe_host}:{port}" if port is not None else safe_host
    return urlunsplit((parsed.scheme.lower(), netloc, parsed.path.rstrip("/"), "", ""))


def load_ollama_catalog_cache(
    *,
    cache_path: Path,
    base_url: str,
    daemon_version: str | None,
) -> OllamaCatalogCacheHit | None:
    payload, future_schema = _read_current_payload(cache_path)
    if future_schema or payload is None:
        return None

    catalogs = payload.get("catalogs")
    if not isinstance(catalogs, list):
        return None

    safe_base_url = normalize_ollama_catalog_base_url(base_url)
    version_key = _normalize_daemon_version(daemon_version)
    best_hit: OllamaCatalogCacheHit | None = None
    for entry in catalogs:
        if not isinstance(entry, dict):
            continue
        if str(entry.get("base_url") or "") != safe_base_url:
            continue
        if version_key is not None and str(entry.get("daemon_version") or "") != version_key:
            continue
        hit = _cache_hit_from_entry(entry)
        if hit is not None and (best_hit is None or hit.cached_at > best_hit.cached_at):
            best_hit = hit
    return best_hit


def write_ollama_catalog_cache(
    *,
    cache_path: Path,
    base_url: str,
    daemon_version: str | None,
    models: list[Any],
) -> OllamaCatalogCacheHit | None:
    existing_payload, future_schema = _read_current_payload(cache_path)
    if future_schema:
        return None

    safe_base_url = normalize_ollama_catalog_base_url(base_url)
    version_key = _normalize_daemon_version(daemon_version) or UNKNOWN_DAEMON_VERSION
    cache_models = _copy_model_entries(models)
    catalogs = _current_catalogs(existing_payload)

    # Polling must not rewrite an unchanged catalog because atomic replacement
    # is costly. ``_current_catalogs`` has already dropped expired entries.
    unchanged = _matching_catalog_entry(catalogs, safe_base_url, version_key)
    if unchanged is not None and unchanged.get("models") == cache_models:
        return OllamaCatalogCacheHit(
            models=_copy_model_entries(unchanged.get("models") or []),
            cached_at=str(unchanged.get("cached_at") or ""),
            expires_at=str(unchanged.get("expires_at") or ""),
            daemon_version=version_key,
        )

    now = datetime.now(timezone.utc)
    cached_at = _format_utc(now)
    expires_at = _format_utc(now + timedelta(seconds=CACHE_TTL_SECONDS))
    entry = {
        "base_url": safe_base_url,
        "daemon_version": version_key,
        "models": cache_models,
        "cached_at": cached_at,
        "expires_at": expires_at,
    }

    catalogs = [
        catalog
        for catalog in catalogs
        if not (
            str(catalog.get("base_url") or "") == safe_base_url
            and str(catalog.get("daemon_version") or "") == version_key
        )
    ]
    catalogs.append(entry)
    catalogs.sort(
        key=lambda catalog: (
            str(catalog.get("base_url") or ""),
            str(catalog.get("daemon_version") or ""),
        )
    )
    payload = {
        "schema_version": SCHEMA_VERSION,
        "updated_at": cached_at,
        "catalogs": catalogs,
    }
    if not write_json_atomic(cache_path, payload):
        return None
    return OllamaCatalogCacheHit(
        models=cache_models,
        cached_at=cached_at,
        expires_at=expires_at,
        daemon_version=version_key,
    )


def _matching_catalog_entry(
    catalogs: list[dict[str, Any]],
    safe_base_url: str,
    version_key: str,
) -> dict[str, Any] | None:
    for catalog in catalogs:
        if (
            str(catalog.get("base_url") or "") == safe_base_url
            and str(catalog.get("daemon_version") or "") == version_key
        ):
            return catalog
    return None


def _normalize_daemon_version(daemon_version: str | None) -> str | None:
    normalized = str(daemon_version or "").strip()
    return normalized or None


def _read_current_payload(cache_path: Path) -> tuple[dict[str, Any] | None, bool]:
    try:
        raw_payload = json.loads(cache_path.read_text(encoding="utf-8"))
    except (FileNotFoundError, OSError, UnicodeDecodeError, json.JSONDecodeError):
        return None, False
    if not isinstance(raw_payload, dict):
        return None, False

    schema_version = coerce_optional_int(raw_payload.get("schema_version"))
    if schema_version is None:
        return None, False
    if schema_version > SCHEMA_VERSION:
        return None, True
    if schema_version != SCHEMA_VERSION:
        return None, False
    return raw_payload, False


def _cache_hit_from_entry(entry: dict[str, Any]) -> OllamaCatalogCacheHit | None:
    models = entry.get("models")
    cached_at = str(entry.get("cached_at") or "").strip()
    expires_at = str(entry.get("expires_at") or "").strip()
    daemon_version = str(entry.get("daemon_version") or "").strip()
    if not isinstance(models, list) or not cached_at or not expires_at or not daemon_version:
        return None
    if _cache_entry_is_expired(expires_at):
        return None
    return OllamaCatalogCacheHit(
        models=_copy_model_entries(models),
        cached_at=cached_at,
        expires_at=expires_at,
        daemon_version=daemon_version,
    )


def _current_catalogs(payload: dict[str, Any] | None) -> list[dict[str, Any]]:
    if not isinstance(payload, dict):
        return []
    catalogs = payload.get("catalogs")
    if not isinstance(catalogs, list):
        return []
    current: list[dict[str, Any]] = []
    for entry in catalogs:
        if not isinstance(entry, dict):
            continue
        base_url = normalize_ollama_catalog_base_url(str(entry.get("base_url") or ""))
        hit = _cache_hit_from_entry(entry)
        if not base_url or hit is None:
            continue
        current.append(
            {
                "base_url": base_url,
                "daemon_version": hit.daemon_version,
                "models": hit.models,
                "cached_at": hit.cached_at,
                "expires_at": hit.expires_at,
            }
        )
    return current


def _copy_model_entries(models: list[Any]) -> list[Any]:
    copied: list[Any] = []
    for entry in models:
        copied_entry = _copy_model_entry(entry)
        if copied_entry is not None:
            copied.append(copied_entry)
            if len(copied) >= MAX_CACHE_MODELS:
                break
    return copied


def _copy_model_entry(entry: Any) -> Any | None:
    if isinstance(entry, str):
        normalized = entry.strip()
        return normalized if _is_safe_cache_model_id(normalized) else None
    if not isinstance(entry, dict):
        return None

    model_id = str(entry.get("id") or entry.get("name") or entry.get("model") or "").strip()
    if not _is_safe_cache_model_id(model_id):
        return None

    copied: dict[str, Any] = {"id": model_id}
    capabilities = entry.get("capabilities")
    if isinstance(capabilities, dict):
        safe_capabilities: dict[str, Any] = {
            str(key).strip(): value
            for key, value in capabilities.items()
            if (
                isinstance(key, str)
                and key.strip() in _CACHE_BOOLEAN_CAPABILITY_KEYS
                and isinstance(value, bool)
            )
        }
        reasoning_efforts = capabilities.get("reasoning_efforts")
        if isinstance(reasoning_efforts, list):
            normalized_efforts = [
                token
                for value in reasoning_efforts
                if (token := str(value or "").strip().lower()) in _CACHE_REASONING_EFFORTS
            ]
            if normalized_efforts:
                safe_capabilities["reasoning_efforts"] = list(dict.fromkeys(normalized_efforts))
        default_effort = str(capabilities.get("default_reasoning_effort") or "").strip().lower()
        if default_effort == "default" or default_effort in _CACHE_REASONING_EFFORTS:
            safe_capabilities["default_reasoning_effort"] = default_effort
        if safe_capabilities:
            copied["capabilities"] = safe_capabilities

    template_family = _safe_cache_template_family(entry.get("template_family"))
    if template_family:
        copied["template_family"] = template_family

    # Deliberately stricter than catalog.py's _coerce_positive_model_size:
    # the writer always hands us a clean int, so on the read path a float or
    # exotic string in a hand-edited/older cache file drops the size rather
    # than round-tripping it. Bounded like the other cached fields.
    size = coerce_optional_int(entry.get("size"))
    if size is not None and 0 < size < (1 << 50):
        copied["size"] = size

    # Model-fit estimator inputs (Wave 1), mirrored from catalog.py's
    # _normalize_ollama_catalog_entry so cached entries keep them across
    # a cold-start read.
    parameter_size = _bounded_cache_str(entry.get("parameter_size"), MAX_CACHE_PARAMETER_SIZE_CHARS)
    if parameter_size:
        copied["parameter_size"] = parameter_size
    quantization_level = _bounded_cache_str(entry.get("quantization_level"), MAX_CACHE_QUANTIZATION_LEVEL_CHARS)
    if quantization_level:
        copied["quantization_level"] = quantization_level
    digest = _bounded_cache_str(entry.get("digest"), MAX_CACHE_DIGEST_CHARS)
    if digest:
        copied["digest"] = digest

    return copied


def _bounded_cache_str(value: Any, max_len: int) -> str:
    text = str(value or "").strip()
    return text[:max_len] if text else ""


def _is_safe_cache_model_id(value: str) -> bool:
    return bool(value) and len(value) <= MAX_CACHE_MODEL_ID_CHARS


def _safe_cache_template_family(value: Any) -> str:
    normalized = str(value or "").strip()
    if len(normalized) > MAX_CACHE_TEMPLATE_FAMILY_CHARS:
        return ""
    return normalized


def _format_utc(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _cache_entry_is_expired(expires_at: str) -> bool:
    parsed = _parse_utc_timestamp(expires_at)
    if parsed is None:
        return True
    return parsed <= datetime.now(timezone.utc)


def _parse_utc_timestamp(value: str) -> datetime | None:
    normalized = str(value or "").strip()
    if not normalized:
        return None
    if normalized.endswith("Z"):
        normalized = f"{normalized[:-1]}+00:00"
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)
