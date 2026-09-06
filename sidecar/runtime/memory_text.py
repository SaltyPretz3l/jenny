"""Shared text normalization for memory.py and memory_suggestions.py.

Leaf module by design: it imports nothing from sidecar.runtime, so both
memory.py and memory_suggestions.py can depend on it without forming a cycle.
These helpers used to live in memory.py, which forced memory_suggestions.py to
import memory.py while memory.py re-exported from memory_suggestions.py. That
circle only resolved when memory.py happened to be imported first, so
`import sidecar.runtime.memory_suggestions` in a fresh process raised
ImportError on a partially initialized module.
"""

from __future__ import annotations

import re
from typing import Any

from sidecar.ai.memory.contracts import (
    MAX_TITLE_CHARS,
    build_content_digest,
    normalize_lesson_text,
    normalize_spaces,
)
from sidecar.ai.tools.sanitization import redact_obvious_secrets


def _normalize_spaces(value: str) -> str:
    return normalize_spaces(value)


def _normalize_title(value: str) -> str:
    return normalize_spaces(value, max_chars=MAX_TITLE_CHARS)


def _normalize_lesson_text(value: str) -> str:
    return normalize_lesson_text(value)


def _build_fingerprint(lesson_kind: str, lesson_text: str) -> str:
    return build_content_digest(lesson_kind, lesson_text)


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
