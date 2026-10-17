"""Canonical validation and identity helpers for durable memory state."""

from __future__ import annotations

import hashlib
import math
import re
import unicodedata
from dataclasses import dataclass
from typing import Any

from sidecar.ai.tools.sanitization import scrub_memory_text

MAX_SESSION_ID_CHARS = 256
MAX_REQUEST_ID_CHARS = 256
MAX_TITLE_CHARS = 120
MAX_RECENT_CHATS = 6
# Prompt recall ceilings (row 58 W3): 5 memories within 256 tokens (the W2
# selection), then up to 3 recap lines while the total stays within 600.
PROMPT_MEMORY_TOKEN_BUDGET = 256
PROMPT_RECALL_TOKEN_BUDGET = 600
MAX_PROMPT_RECAP_LINES = 3
# Newest shared rows a reflection dedupes against (store and reflection checks).
DEDUPE_ROW_LIMIT = 200
MAX_RECENT_CHAT_TITLE_CHARS = 200
MAX_LESSON_TEXT_CHARS = 400
# The legacy regex-capture path still stores at most 240 characters.
LEGACY_CAPTURE_TEXT_CHARS = 240
MAX_SOURCE_EXCERPT_CHARS = 1_000
MAX_FAMILY_KEY_CHARS = 128
MAX_CATEGORY_CHARS = 128
MAX_PROVENANCE_CHARS = 32
MAX_RECALL_QUERY_CHARS = 2_000
MAX_LIST_PAGE_SIZE = 250
DEFAULT_LIST_PAGE_SIZE = 100
MAX_QUARANTINE_ROWS = 1_000
MAX_QUARANTINE_PAYLOAD_CHARS = 2_000
GENERAL_PROJECT_ID = "project_general"
MAX_PROJECT_ID_CHARS = len("project_") + 128
CONTENT_DIGEST_PREFIX = "sha256:"
CONTENT_DIGEST_HEX_CHARS = 64
CONTENT_DIGEST_CHARS = len(CONTENT_DIGEST_PREFIX) + CONTENT_DIGEST_HEX_CHARS

# Schema v9: the closed kind and origin vocabularies.
MEMORY_KINDS = ("preference", "fact", "decision", "convention", "person", "routine", "lesson")
MEMORY_ORIGINS = ("user", "jenny", "reflection", "legacy")
WRITE_ORIGINS = ("user", "jenny", "reflection")
# v8 kinds -> v9 kinds (migration and the transitional legacy writers).
LEGACY_KIND_MAP = {
    "profile": "fact",
    "preference": "preference",
    "response_style": "preference",
    "working_preference": "preference",
    "tool_strategy": "lesson",
    "project_context": "convention",
    "routine": "routine",
    "goal": "fact",
    "important_person": "person",
}
MAX_SOURCE_MESSAGE_IDS = 16
MAX_SOURCE_MESSAGE_ID_CHARS = 128
MAX_OPERATION_ID_CHARS = 128
MAX_OPERATION_JSON_CHARS = 4_000
OPERATION_RETRY_SECONDS = 24 * 3600
MAX_ACTIVE_MEMORIES = 10_000
ARCHIVED_RETENTION_DAYS = 30
MAX_SESSION_MARKERS = 10_000
MAX_MEMORY_PAGE_SIZE = 50
ALWAYS_ON_BUDGET_CHARS = 1_200
# Heading + framing line + newlines of the rendered `## Always-on memories`
# section (sidecar/ai/context/always_on_memories.py), so a store filled to the
# cap renders every row.
ALWAYS_ON_HEADING_RESERVE = 144
ALWAYS_ON_ROW_OVERHEAD = 16
MEMORY_CAPTURE_MODES = ("auto", "ask", "off")
# Kind-slot salt of the recap row identity (see recap_text_digest).
RECAP_DIGEST_SALT = "recap"


@dataclass(frozen=True)
class RecentChat:
    session_id: str
    title: str

    def __post_init__(self) -> None:
        if (
            not isinstance(self.session_id, str) or not self.session_id.strip()
            or len(self.session_id) > MAX_SESSION_ID_CHARS
        ):
            raise ValueError("recent_chats session_id is invalid")
        if not isinstance(self.title, str) or len(self.title) > MAX_RECENT_CHAT_TITLE_CHARS:
            raise ValueError("recent_chats title must be at most 200 characters")
        # The title is chat-index metadata rendered into a system message.
        object.__setattr__(self, "title", scrub_memory_text(self.title)[0])


@dataclass(frozen=True)
class RecapLine:
    title: str
    updated_date: str
    text: str


@dataclass(frozen=True)
class MemoryPolicy:
    enabled: bool = True
    recall_query: str = ""
    project_id: str = GENERAL_PROJECT_ID
    capture: str = "auto"
    recall: bool = True
    policy_epoch: int = 0
    recent_chats: tuple[RecentChat, ...] = ()

    def __post_init__(self) -> None:
        object.__setattr__(self, "project_id", require_project_id(self.project_id))
        if self.capture not in MEMORY_CAPTURE_MODES:
            raise ValueError("capture must be one of auto, ask, off")
        if (
            not isinstance(self.recent_chats, tuple)
            or len(self.recent_chats) > MAX_RECENT_CHATS
            or not all(isinstance(chat, RecentChat) for chat in self.recent_chats)
        ):
            raise ValueError("recent_chats must be a tuple of at most 6 RecentChat values")
        seen: set[str] = set()
        chats = []
        for chat in self.recent_chats:
            if chat.session_id not in seen:
                seen.add(chat.session_id)
                chats.append(chat)
        object.__setattr__(self, "recent_chats", tuple(chats))
        epoch = self.policy_epoch
        if isinstance(epoch, bool) or not isinstance(epoch, int) or epoch < 0:
            raise ValueError("policy_epoch must be a non-negative integer")


_SPACES_RE = re.compile(r"\s+")
_DIGEST_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
_PROJECT_ID_RE = re.compile(r"^project_[A-Za-z0-9_-]{1,128}$")


def require_project_id(value: Any) -> str:
    if not isinstance(value, str):
        raise ValueError("project_id must be a string")
    project_id = value.strip()
    if not _PROJECT_ID_RE.fullmatch(project_id):
        raise ValueError("project_id is invalid")
    return project_id


def normalize_spaces(value: Any, *, max_chars: int | None = None) -> str:
    """Normalize user/model text without accepting non-string object renderings."""

    normalized = unicodedata.normalize("NFC", str(value or ""))
    normalized = _SPACES_RE.sub(" ", normalized).strip()
    if max_chars is not None:
        normalized = normalized[:max_chars]
    return normalized


def normalize_lesson_text(value: Any, *, max_chars: int = LEGACY_CAPTURE_TEXT_CHARS) -> str:
    """Normalize lesson text the way the legacy capture path stores it."""

    normalized = normalize_spaces(value)
    if normalized and normalized[-1] not in ".!?":
        normalized += "."
    return normalized[:max_chars]


def legacy_kind_digest(lesson_kind: Any, lesson_text: Any) -> str:
    """The pre-v9 identity (kind + text). Only the v6->v7 rebuild still uses it."""

    normalized_kind = normalize_spaces(lesson_kind, max_chars=MAX_CATEGORY_CHARS).lower()
    normalized_text = normalize_lesson_text(lesson_text, max_chars=MAX_LESSON_TEXT_CHARS)
    material = f"{normalized_kind}\n{normalized_text.casefold()}".encode("utf-8", errors="strict")
    return f"{CONTENT_DIGEST_PREFIX}{hashlib.sha256(material).hexdigest()}"


def build_text_digest(lesson_text: Any) -> str:
    """Return the v9 identity: one non-reversible digest per normalized text, any kind."""

    return legacy_kind_digest("", lesson_text)


def recap_text_digest(lesson_text: Any) -> str:
    """The salted identity of a reflection recap row (row 58 W4, W3 limit A).

    The salt rides in the kind slot of the digest material (``kind + newline +
    text``). A note's material always starts with the newline of its empty kind
    and normalized text never contains a newline, so no note can reproduce a
    recap's digest: a chat note and its recap with the same text are separate
    rows that never dedupe against each other.
    """

    return legacy_kind_digest(RECAP_DIGEST_SALT, lesson_text)


def map_legacy_kind(lesson_kind: Any) -> str:
    """Map a v8 kind (or a v9 kind) to the closed v9 vocabulary; unknown -> fact."""

    normalized = normalize_spaces(lesson_kind, max_chars=MAX_CATEGORY_CHARS).lower()
    if normalized in MEMORY_KINDS:
        return normalized
    return LEGACY_KIND_MAP.get(normalized, "fact")


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
    "ALWAYS_ON_BUDGET_CHARS",
    "ALWAYS_ON_HEADING_RESERVE",
    "ALWAYS_ON_ROW_OVERHEAD",
    "ARCHIVED_RETENTION_DAYS",
    "CONTENT_DIGEST_CHARS",
    "CONTENT_DIGEST_PREFIX",
    "DEDUPE_ROW_LIMIT",
    "DEFAULT_LIST_PAGE_SIZE",
    "GENERAL_PROJECT_ID",
    "LEGACY_CAPTURE_TEXT_CHARS",
    "LEGACY_KIND_MAP",
    "MAX_ACTIVE_MEMORIES",
    "MAX_MEMORY_PAGE_SIZE",
    "MAX_OPERATION_ID_CHARS",
    "MAX_OPERATION_JSON_CHARS",
    "MAX_SESSION_MARKERS",
    "MAX_SOURCE_MESSAGE_IDS",
    "MAX_SOURCE_MESSAGE_ID_CHARS",
    "MEMORY_CAPTURE_MODES",
    "MEMORY_KINDS",
    "MEMORY_ORIGINS",
    "OPERATION_RETRY_SECONDS",
    "WRITE_ORIGINS",
    "MAX_CATEGORY_CHARS",
    "MAX_FAMILY_KEY_CHARS",
    "MAX_LESSON_TEXT_CHARS",
    "MAX_LIST_PAGE_SIZE",
    "MAX_PROVENANCE_CHARS",
    "MAX_PROJECT_ID_CHARS",
    "MAX_RECALL_QUERY_CHARS",
    "MAX_REQUEST_ID_CHARS",
    "MAX_SESSION_ID_CHARS",
    "MAX_SOURCE_EXCERPT_CHARS",
    "MAX_TITLE_CHARS",
    "build_text_digest",
    "is_content_digest",
    "legacy_kind_digest",
    "map_legacy_kind",
    "normalize_lesson_text",
    "normalize_positive_limit",
    "normalize_spaces",
    "recap_text_digest",
    "require_bounded_text",
    "require_finite_confidence",
    "require_project_id",
]
