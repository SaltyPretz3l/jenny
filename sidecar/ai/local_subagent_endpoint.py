"""Electron's description of the local subagent engine (row 179).

A ready managed local server (NInfer or llama-server) that a cloud primary's
delegate children may run on. Kept free of config imports so ``RuntimeConfig``
can carry it; the child config itself is built in
``sidecar.ai.routing.subagent_local_engine``.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlsplit

LOCAL_SUBAGENT_ALIAS = "local"
LOCAL_SUBAGENT_ENGINE_TYPE = "openai-compatible"
_PROVIDER_KINDS = frozenset({"ninfer", "llama-server"})
_LOOPBACK_HOSTS = frozenset({"127.0.0.1", "localhost", "::1"})
_FIELDS = frozenset({
    "base_url", "model", "provider_kind", "context_length", "ready",
    "prefill_progress", "json_schema_response_format",
})
_MODEL_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:/+@-]{0,255}\Z")
_MAX_CONTEXT = 4_194_304
_MAX_URL_CHARS = 256


@dataclass(frozen=True)
class LocalSubagentEngine:
    base_url: str
    model: str
    provider_kind: str
    context_length: int | None
    prefill_progress: bool
    json_schema_response_format: bool
    api_key: str | None = field(default=None, repr=False)


def _bounded_int(value: Any, maximum: int) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= maximum:
        return None
    return value


def _loopback_url(value: Any) -> str | None:
    if not isinstance(value, str) or len(value) > _MAX_URL_CHARS or value != value.strip():
        return None
    try:
        parts = urlsplit(value)
        port = parts.port
    except ValueError:
        return None
    if (
        parts.scheme != "http" or parts.hostname not in _LOOPBACK_HOSTS or port is None
        or parts.username or parts.password or parts.query or parts.fragment
    ):
        return None
    return value


def parse_local_subagent_engine(raw: Any, api_key: Any = None) -> LocalSubagentEngine | None:
    """Admit Electron's helper description; anything malformed or not ready is ``None``."""
    if not isinstance(raw, dict) or set(raw) != _FIELDS or raw.get("ready") is not True:
        return None
    base_url = _loopback_url(raw.get("base_url"))
    model = raw.get("model")
    kind = raw.get("provider_kind")
    context = raw.get("context_length")
    flags = (raw.get("prefill_progress"), raw.get("json_schema_response_format"))
    if (
        base_url is None or not isinstance(model, str) or not _MODEL_RE.fullmatch(model)
        or kind not in _PROVIDER_KINDS
        or (context is not None and _bounded_int(context, _MAX_CONTEXT) is None)
        or not all(isinstance(flag, bool) for flag in flags)
    ):
        return None
    key = api_key.strip() if isinstance(api_key, str) and api_key.strip() else None
    return LocalSubagentEngine(
        base_url=base_url, model=model, provider_kind=str(kind), context_length=context,
        prefill_progress=flags[0] is True,
        json_schema_response_format=flags[1] is True, api_key=key,
    )
