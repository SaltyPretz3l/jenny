"""Text normalization and provenance redaction for the memory.* RPC helpers.

Leaf module by design: it imports nothing from sidecar.runtime, so
sidecar/runtime/memory.py (and anything else in the runtime) can depend on it
without an import cycle.
"""

from __future__ import annotations

import re
from typing import Any

from sidecar.ai.memory.contracts import MAX_TITLE_CHARS, normalize_spaces
from sidecar.ai.tools.sanitization import redact_obvious_secrets


def _normalize_spaces(value: str) -> str:
    return normalize_spaces(value)


def _normalize_title(value: str) -> str:
    return normalize_spaces(value, max_chars=MAX_TITLE_CHARS)


_PROVENANCE_EXCERPT_MAX_CHARS = 240
_PROVENANCE_INPUT_MAX_CHARS = 4096
_LOCAL_PATH_RE = re.compile(
    r"(?i)(?:[a-z]:\\[^\s<>\"']+|\\\\[^\\\s<>\"']+\\[^\s<>\"']+|(?<!\S)/(?!/)[^\s<>\"']+)"
)
_EMAIL_RE = re.compile(r"(?i)\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b")


def _sanitize_source_excerpt(value: Any) -> str:
    """Bound and redact provenance without retaining a source turn."""

    raw = str(value or "")[:_PROVENANCE_INPUT_MAX_CHARS]
    normalized = normalize_spaces(raw)
    redacted = redact_obvious_secrets(normalized)
    redacted = _LOCAL_PATH_RE.sub("[LOCAL_PATH_REDACTED]", redacted)
    redacted = _EMAIL_RE.sub("[EMAIL_REDACTED]", redacted)
    return redacted[:_PROVENANCE_EXCERPT_MAX_CHARS].rstrip()
