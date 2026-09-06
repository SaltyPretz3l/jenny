"""Ollama metadata/capability helpers."""

from __future__ import annotations

import json
import logging
import re
from typing import Any

from sidecar.ai.engines.model_name import (
    THINKING_MODEL_PREFIXES,
    VISION_MODEL_PREFIXES,
    advertised_capability_source,
    canonical_model_token,
    extract_family_tokens,
    model_token_matches,
)
from sidecar.runtime.ollama_support import resolve_template_diagnostics

logger = logging.getLogger(__name__)

_TOOL_CAPABLE_PREFIXES = (
    "qwen3.6",
    "qwen3.5",
    "qwen36",
    "qwen3",
    "llama3.1",
    "llama3.2",
    "llama3.3",
    "mistral-nemo",
    "mistral-small",
    "command-r",
    # gpt-oss harmony models support function calling, but Ollama's /api/show
    # does not advertise the "tools" capability for them, so they fall through
    # to this allowlist. The HTTP-400 retry path disables tools gracefully if a
    # given build genuinely rejects them.
    "gpt-oss",
)
_SMALL_MODEL_SUFFIX_RE = re.compile(r"(?P<size>\d+(?:\.\d+)?)\s*b\b", re.IGNORECASE)
_CACHED_TOOLS_STATE_PARTS = 2


def detect_vision(name: str, info: dict[str, Any] | None) -> tuple[bool, str]:
    canonical = canonical_model_token(name)
    if model_token_matches(canonical, marker="vision", prefixes=VISION_MODEL_PREFIXES):
        return True, "model_name"
    if info:
        source = advertised_capability_source(info, "vision", normalize_lists=False)
        if source:
            return True, source
        for token, source in extract_family_tokens(info, include_family=False):
            if model_token_matches(token, marker="vision", prefixes=VISION_MODEL_PREFIXES):
                return True, source
        return False, "unsupported"
    return False, "model_name"


def extract_context_length(info: dict[str, Any] | None) -> int | None:
    if not info:
        return None
    model_info = info.get("model_info", {})
    if isinstance(model_info, dict):
        for key, value in model_info.items():
            if "context_length" in key:
                try:
                    return int(value)
                except (ValueError, TypeError):
                    pass
    params = info.get("parameters", "")
    if isinstance(params, str):
        match = re.search(r"num_ctx\s+(\d+)", params)
        if match:
            return int(match.group(1))
    return None


def extract_max_output_tokens(
    info: dict[str, Any] | None,
    context_length: int | None,
) -> int | None:
    if info:
        params = info.get("parameters", "")
        if isinstance(params, str):
            match = re.search(r"num_predict\s+(\d+)", params)
            if match:
                return int(match.group(1))
    if context_length is not None and context_length > 0:
        return min(context_length, 16384)
    return None


def refresh_tool_capability(
    name: str,
    info: dict[str, Any] | None,
) -> tuple[bool, str]:
    if not info:
        return True, "engine_default"
    caps = info.get("capabilities")
    if isinstance(caps, dict):
        if caps.get("tools") is True:
            return True, "capabilities"
        if "tools" in caps:
            # Explicit ``tools: False`` (or any non-True value) is an
            # authoritative denial — trust it, do not allowlist-override.
            return False, "capabilities"
        if caps:
            # ``tools`` key absent: an omission, not a denial. A known
            # tool-capable family (e.g. gpt-oss) may still be allowlisted.
            return _tool_capability_from_allowlist(name, sorted(str(key) for key in caps))
        return True, "engine_default"
    if not isinstance(caps, list):
        return True, "engine_default"
    normalized = {str(capability).strip().lower() for capability in caps if str(capability).strip()}
    if "tools" in normalized:
        return True, "capabilities"
    if normalized:
        return _tool_capability_from_allowlist(name, sorted(normalized))
    return True, "engine_default"


def _tool_capability_from_allowlist(
    name: str,
    advertised: list[str],
) -> tuple[bool, str]:
    """Resolve tool-calling when a model reports capabilities that omit ``tools``.

    Falls back to the model-name allowlist for known tool-capable families whose
    Ollama manifests do not advertise the ``tools`` capability (e.g. gpt-oss).
    """
    matched_prefix = _tool_capable_allowlist_prefix(name)
    if matched_prefix:
        logger.warning(
            "Ollama model '%s' did not advertise 'tools' but matched allowlist '%s'; "
            "enabling tool-calling. If tool calls fail, remove the prefix from "
            "_TOOL_CAPABLE_PREFIXES.",
            name,
            matched_prefix,
        )
        return True, "model_name_allowlist"
    logger.info(
        "Ollama model '%s' does not advertise tool support (capabilities=%s); "
        "tool-calling disabled for this session.",
        name,
        ",".join(advertised),
    )
    return False, "capabilities"


def _tool_capable_allowlist_prefix(token: str) -> str:
    normalized = canonical_model_token(token)
    if not normalized:
        return ""
    return next(
        (prefix for prefix in _TOOL_CAPABLE_PREFIXES if normalized.startswith(prefix)),
        "",
    )


def resolve_template_diagnostics_payload(
    name: str,
    info: dict[str, Any] | None,
) -> dict[str, object]:
    try:
        diagnostics = resolve_template_diagnostics(name, info)
        resolved = diagnostics.get("resolved", False)
        family = diagnostics.get("family", "")
        source = diagnostics.get("resolution_source", "")
        if resolved:
            logger.info(
                "Ollama template resolved for '%s': family=%s via %s.",
                name,
                family,
                source,
            )
        else:
            logger.warning(
                "Ollama template not resolved for '%s' (source=%s). "
                "Registry may be stale for this model family.",
                name,
                source,
            )
        return diagnostics
    except Exception as error:  # noqa: BLE001
        logger.debug("Template diagnostics failed for '%s': %s", name, error)
        return {}


def is_likely_thinking_model(token: str) -> bool:
    return model_token_matches(
        canonical_model_token(token),
        marker="thinking",
        prefixes=THINKING_MODEL_PREFIXES,
    )


def detect_thinking(name: str, info: dict[str, Any] | None) -> tuple[bool, str]:
    lower = str(name or "").strip().lower()
    if info:
        source = advertised_capability_source(info, "thinking")
        if source:
            return True, source
        for token, source in extract_family_tokens(info, stringify_family=True):
            if is_likely_thinking_model(token):
                return True, source
    if is_likely_thinking_model(lower):
        return True, "model_name"
    return False, "unsupported"


def compact_parameters(schema: dict[str, Any]) -> dict[str, Any]:
    props = schema.get("properties")
    if not isinstance(props, dict):
        return schema
    compacted_props: dict[str, Any] = {}
    for key, value in props.items():
        if isinstance(value, dict):
            compacted_props[key] = {k: v for k, v in value.items() if k != "description"}
        else:
            compacted_props[key] = value
    result = dict(schema)
    result["properties"] = compacted_props
    return result


def build_tools_payload(
    tools: list[dict[str, Any]],
    *,
    compact: bool = True,
) -> list[dict[str, Any]]:
    payload: list[dict[str, Any]] = []
    for tool in tools:
        name = str(tool.get("name") or "").strip()
        if not name:
            continue
        if tool.get("defer_loading") is True:
            continue
        description = str(tool.get("description") or "").strip()
        parameters = tool.get("parameters")
        schema = parameters if isinstance(parameters, dict) else {}
        if compact:
            schema = compact_parameters(schema)
        payload.append(
            {
                "type": "function",
                "function": {
                    "name": name,
                    "description": description,
                    "parameters": schema,
                },
            }
        )
    return payload


def build_tools_payload_cached(
    engine: Any,
    tools: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    key = tuple(
        json.dumps(
            {
                "name": str(tool.get("name", "")).strip(),
                "description": str(tool.get("description", "")).strip(),
                "defer_loading": tool.get("defer_loading") is True,
                "parameters": (
                    tool.get("parameters") if isinstance(tool.get("parameters"), dict) else {}
                ),
            },
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=True,
        )
        for tool in tools
        if str(tool.get("name", "")).strip()
    )
    cached_state = getattr(engine, "_cached_tools_state", None)
    if (
        isinstance(cached_state, tuple)
        and len(cached_state) == _CACHED_TOOLS_STATE_PARTS
        and key == cached_state[0]
    ):
        return cached_state[1]
    payload = build_tools_payload(tools)
    # One reference publication prevents readers from ever observing a key
    # from one contract paired with the payload from another concurrent turn.
    engine._cached_tools_state = (key, payload)
    return payload


def model_size_billions(model_name: str | None) -> float | None:
    normalized = str(model_name or "").strip().lower()
    if ":" not in normalized:
        return None
    suffix = normalized.split(":", 1)[1]
    match = _SMALL_MODEL_SUFFIX_RE.search(suffix)
    if match is None:
        return None
    try:
        return float(match.group("size"))
    except ValueError:
        return None
