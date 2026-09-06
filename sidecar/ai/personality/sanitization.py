"""Sanitizers for workspace bootstrap and personality text."""

from __future__ import annotations

import hashlib
import logging
import re
import unicodedata
from typing import Any

from sidecar.ai.tools import sanitization as tool_sanitization
from sidecar.ai.tools.prompt_marker_guard import neutralize_prompt_markers

LOGGER = logging.getLogger(__name__)
BOOTSTRAP_SANITIZATION_LOG_EVENT = "ai.personality.sanitization.bootstrap_neutralized"
_CONTROL_CHAR_RE = re.compile(r"[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]")
_NEWLINE_NORMALIZE_RE = re.compile(r"\r\n?")


def sanitize_bootstrap(text: object, *, source_name: str = "") -> str:
    """Sanitize trusted-shape but workspace-controlled bootstrap text."""
    normalized = _normalize_bootstrap_text(text, tool_sanitization=tool_sanitization)
    normalized, matched_families = tool_sanitization.neutralize_prompt_injection_patterns(
        normalized
    )
    if matched_families:
        _log_bootstrap_neutralization(
            source_name=source_name,
            matched_families=matched_families,
            sanitized_text=normalized,
        )
    normalized = neutralize_prompt_markers(normalized)
    normalized = tool_sanitization.redact_obvious_secrets(normalized)
    return normalized.strip()


def _normalize_bootstrap_text(text: object, *, tool_sanitization: Any) -> str:
    raw = tool_sanitization.strip_surrogates(str(text or ""))
    raw = _CONTROL_CHAR_RE.sub("", raw)
    raw = _NEWLINE_NORMALIZE_RE.sub("\n", raw)
    raw = unicodedata.normalize("NFKC", raw)
    raw = tool_sanitization.strip_invisible_chars(raw)
    return tool_sanitization.strip_special_tokens(raw)


def _log_bootstrap_neutralization(
    *,
    source_name: str,
    matched_families: tuple[str, ...],
    sanitized_text: str,
) -> None:
    content_bytes = sanitized_text.encode("utf-8", errors="replace")
    LOGGER.info(
        "Neutralized prompt injection in workspace bootstrap text.",
        extra={
            "event": BOOTSTRAP_SANITIZATION_LOG_EVENT,
            "component": "ai.personality.sanitization",
            "source_name": str(source_name or ""),
            "pattern_families": list(matched_families),
            "content_length": len(sanitized_text),
            "content_sha256_prefix": hashlib.sha256(content_bytes).hexdigest()[:16],
        },
    )
