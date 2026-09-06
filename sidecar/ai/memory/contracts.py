"""Canonical validation and identity helpers for durable memory state."""

from __future__ import annotations

import hashlib
import math
import re
import unicodedata
from dataclasses import dataclass
from typing import Any

MAX_SESSION_ID_CHARS = 256
MAX_REQUEST_ID_CHARS = 256
MAX_TITLE_CHARS = 120
MAX_LESSON_TEXT_CHARS = 240
MAX_SOURCE_EXCERPT_CHARS = 1_000
MAX_FAMILY_KEY_CHARS = 128
MAX_CATEGORY_CHARS = 128
MAX_PROVENANCE_CHARS = 32
MAX_RECALL_QUERY_CHARS = 2_000
MAX_LIST_PAGE_SIZE = 250
DEFAULT_LIST_PAGE_SIZE = 100
MAX_QUARANTINE_ROWS = 1_000
MAX_QUARANTINE_PAYLOAD_CHARS = 2_000
CONTENT_DIGEST_PREFIX = "sha256:"
CONTENT_DIGEST_HEX_CHARS = 64
CONTENT_DIGEST_CHARS = len(CONTENT_DIGEST_PREFIX) + CONTENT_DIGEST_HEX_CHARS


@dataclass(frozen=True)
class MemoryPolicy:
    enabled: bool = True
    include_response_style: bool = True
    recall_query: str = ""


_SPACES_RE = re.compile(r"\s+")
_DIGEST_RE = re.compile(r"^sha256:[0-9a-f]{64}$")


def normalize_spaces(value: Any, *, max_chars: int | None = None) -> str:
    """Normalize user/model text without accepting non-string object renderings."""

    normalized = unicodedata.normalize("NFC", str(value or ""))
    normalized = _SPACES_RE.sub(" ", normalized).strip()
    if max_chars is not None:
        normalized = normalized[:max_chars]
    return normalized


def normalize_lesson_text(value: Any) -> str:
    normalized = normalize_spaces(value)
    if normalized and normalized[-1] not in ".!?":
        normalized += "."
    return normalized[:MAX_LESSON_TEXT_CHARS]


def build_content_digest(lesson_kind: Any, lesson_text: Any) -> str:
    """Return the non-reversible canonical identity for one memory lesson."""

    normalized_kind = normalize_spaces(lesson_kind, max_chars=MAX_CATEGORY_CHARS).lower()
    normalized_text = normalize_lesson_text(lesson_text).casefold()
    material = f"{normalized_kind}\n{normalized_text}".encode("utf-8", errors="strict")
    return f"{CONTENT_DIGEST_PREFIX}{hashlib.sha256(material).hexdigest()}"


def is_content_digest(value: Any) -> bool:
    return bool(_DIGEST_RE.fullmatch(str(value or "").strip().lower()))


def require_bounded_text(
    value: Any,
    *,
    field: str,
    max_chars: int,
    allow_blank: bool = False,
) -> str:
    normalized = normalize_spaces(value)
    if not normalized and not allow_blank:
        raise ValueError(f"{field} is required")
    if len(normalized) > max_chars:
        raise ValueError(f"{field} exceeds {max_chars} characters")
    return normalized


def require_finite_confidence(value: Any, *, field: str = "confidence") -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{field} must be a finite number")
    normalized = float(value)
    if not math.isfinite(normalized):
        raise ValueError(f"{field} must be a finite number")
    if normalized < 0.0 or normalized > 1.0:
        raise ValueError(f"{field} must be between 0 and 1")
    return normalized


def normalize_positive_limit(
    value: Any,
    *,
    default: int = DEFAULT_LIST_PAGE_SIZE,
    maximum: int = MAX_LIST_PAGE_SIZE,
) -> int:
    if value is None:
        return default
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError("limit must be an integer")
    if value < 1 or value > maximum:
        raise ValueError(f"limit must be between 1 and {maximum}")
    return value


__all__ = [
    "CONTENT_DIGEST_CHARS",
    "CONTENT_DIGEST_PREFIX",
    "DEFAULT_LIST_PAGE_SIZE",
    "MAX_CATEGORY_CHARS",
    "MAX_FAMILY_KEY_CHARS",
    "MAX_LESSON_TEXT_CHARS",
    "MAX_LIST_PAGE_SIZE",
    "MAX_PROVENANCE_CHARS",
    "MAX_RECALL_QUERY_CHARS",
    "MAX_REQUEST_ID_CHARS",
    "MAX_SESSION_ID_CHARS",
    "MAX_SOURCE_EXCERPT_CHARS",
    "MAX_TITLE_CHARS",
    "build_content_digest",
    "is_content_digest",
    "normalize_lesson_text",
    "normalize_positive_limit",
    "normalize_spaces",
    "require_bounded_text",
    "require_finite_confidence",
]
