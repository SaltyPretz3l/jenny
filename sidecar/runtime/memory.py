"""Memory suggestion and persistence helpers for sidecar JSON-RPC methods."""

from __future__ import annotations

import base64
import binascii
from dataclasses import dataclass
from typing import Any

from sidecar.ai.error_codes import (
    CMP_MEMORY_FAILED,
    CMP_MEMORY_FAMILY_UNRESOLVED,
    CMP_MEMORY_INVALID_KIND,
)
from sidecar.ai.memory.contracts import (
    DEFAULT_LIST_PAGE_SIZE,
    MAX_LIST_PAGE_SIZE,
    MAX_RECALL_QUERY_CHARS,
    MAX_SESSION_ID_CHARS,
    normalize_positive_limit,
    require_bounded_text,
    require_finite_confidence,
)
from sidecar.ai.memory.families import GATED_MEMORY_KINDS, resolve_gated_family_key
from sidecar.ai.memory.service import (
    MemoryService,
    approved_memory_api,
    pending_memory_api,
)
from sidecar.ai.memory.store import ApprovedMemory, MemoryStore
from sidecar.exceptions import MemoryStoreError
from sidecar.runtime.memory_text import (
    _build_fingerprint,
    _normalize_lesson_text,
    _normalize_spaces,
    _normalize_title,
    _sanitize_source_excerpt,
)


def _is_valid_limit(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


# ── Re-exports from memory_suggestions (preserve backward-compatible paths) ──
from sidecar.runtime.memory_suggestions import (  # noqa: F401,E402
    GENERIC_CAPTURE_VALUES,
    GOAL_CANDIDATES,
    IMPORTANT_PERSON_CANDIDATES,
    MAX_CAPTURE_LENGTH,
    MEMORY_PATTERNS,
    MIN_CAPTURE_LENGTH,
    PROJECT_CONTEXT_CANDIDATES,
    RESPONSE_STYLE_CANDIDATES,
    ROUTINE_CANDIDATES,
    TOOL_STRATEGY_CANDIDATES,
    WORKING_PREFERENCE_CANDIDATES,
    _normalize_capture,
    _validate_capture,
    serialize_pending_memory_candidate,
    suggest_memories,
)


@dataclass(frozen=True)
class SaveMemoryCandidateResult:
    memory: ApprovedMemory
    created: bool
    warning_code: str | None = None
    warning_detail: str | None = None


def save_memory_candidate(
    *,
    session_id: Any,
    candidate: Any,
    memory_store: MemoryStore | MemoryService,
) -> SaveMemoryCandidateResult:
    normalized_session_id = require_bounded_text(
        session_id,
        field="session_id",
        max_chars=MAX_SESSION_ID_CHARS,
    )
    if not isinstance(candidate, dict):
        raise ValueError("candidate must be an object")

    raw_title = candidate.get("title", "")
    raw_lesson_text = candidate.get("lesson_text", "")
    if not isinstance(raw_title, str):
        raise ValueError("candidate.title must be a string")
    if not isinstance(raw_lesson_text, str):
        raise ValueError("candidate.lesson_text must be a string")
    title = _normalize_title(raw_title)
    lesson_text = _normalize_lesson_text(raw_lesson_text)
    lesson_kind = _normalize_spaces(str(candidate.get("lesson_kind", ""))).lower()
    confidence = require_finite_confidence(
        candidate.get("confidence", 0.0),
        field="candidate.confidence",
    )
    source_excerpt = _sanitize_source_excerpt(candidate.get("source_excerpt", ""))

    if not title:
        raise ValueError("candidate.title is required")
    if not lesson_text:
        raise ValueError("candidate.lesson_text is required")
    _VALID_LESSON_KINDS = {
        "profile",
        "preference",
        "response_style",
        "tool_strategy",
        "working_preference",
        "project_context",
        "routine",
        "goal",
        "important_person",
    }
    if lesson_kind not in _VALID_LESSON_KINDS:
        raise ValueError(
            f"{CMP_MEMORY_INVALID_KIND}: candidate.lesson_kind must be one of {sorted(_VALID_LESSON_KINDS)}"
        )
    # Always recompute the dedupe key from validated content so callers cannot
    # bypass canonical-memory dedupe by supplying arbitrary fingerprints.
    content_fingerprint = _build_fingerprint(lesson_kind, lesson_text)
    family_key = resolve_gated_family_key(
        lesson_kind=lesson_kind,
        lesson_text=lesson_text,
        content_fingerprint=content_fingerprint,
    )
    warning_code = None
    warning_detail = None
    if lesson_kind in GATED_MEMORY_KINDS and not family_key:
        warning_code = CMP_MEMORY_FAMILY_UNRESOLVED
        warning_detail = (
            f"family_key could not be resolved for gated lesson_kind '{lesson_kind}'; "
            "saved with fail-closed family_key=''"
        )

    memory, created = approved_memory_api(memory_store).save_memory(
        session_id=normalized_session_id,
        title=title,
        lesson_text=lesson_text,
        lesson_kind=lesson_kind,
        confidence=confidence,
        source_excerpt=source_excerpt,
        family_key=family_key,
        provenance="user_approved",
    )
    return SaveMemoryCandidateResult(
        memory=memory,
        created=created,
        warning_code=warning_code,
        warning_detail=warning_detail,
    )


def _parse_memory_id(value: Any) -> int:
    if isinstance(value, bool):
        raise ValueError("memory_id must be an integer")
    if isinstance(value, int):
        memory_id = value
    else:
        normalized = str(value or "").strip()
        if not normalized or not normalized.isdigit():
            raise ValueError("memory_id must be an integer")
        memory_id = int(normalized)
    if memory_id <= 0:
        raise ValueError("memory_id must be a positive integer")
    return memory_id


_CURSOR_PREFIX = "v1:"
_MAX_CURSOR_CHARS = 128


def _parse_cursor(value: Any) -> tuple[int | None, int | None, int | None]:
    if value in (None, ""):
        return None, None, None
    if isinstance(value, bool):
        raise ValueError("cursor is invalid")
    normalized = str(value).strip()
    if len(normalized) > _MAX_CURSOR_CHARS:
        raise ValueError("cursor is invalid")
    if normalized.isdigit():
        return int(normalized), None, None
    if not normalized.startswith(_CURSOR_PREFIX):
        raise ValueError("cursor is invalid")
    encoded = normalized[len(_CURSOR_PREFIX) :]
    try:
        raw = base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4)).decode(
            "ascii", errors="strict"
        )
        snapshot_text, after_text = raw.split(":", 1)
        snapshot_max_id = int(snapshot_text)
        after_id = int(after_text)
    except (ValueError, UnicodeError, binascii.Error) as error:
        raise ValueError("cursor is invalid") from error
    if snapshot_max_id <= 0 or after_id <= 0 or after_id > snapshot_max_id:
        raise ValueError("cursor is invalid")
    return None, snapshot_max_id, after_id


def _encode_cursor(value: tuple[int, int] | int | None) -> str | None:
    if value is None:
        return None
    if isinstance(value, int):
        return str(value)
    snapshot_max_id, after_id = value
    raw = f"{snapshot_max_id}:{after_id}".encode("ascii")
    return _CURSOR_PREFIX + base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def list_memories_page(
    *,
    cursor: Any,
    limit: Any,
    memory_store: MemoryStore | MemoryService,
) -> dict[str, object]:
    safe_limit = normalize_positive_limit(
        limit,
        default=DEFAULT_LIST_PAGE_SIZE,
        maximum=MAX_LIST_PAGE_SIZE,
    )
    legacy_offset, snapshot_max_id, after_id = _parse_cursor(cursor)
    rows, next_offset = approved_memory_api(memory_store).get_memories_page(
        limit=safe_limit,
        snapshot_max_id=snapshot_max_id,
        after_id=after_id,
        legacy_offset=legacy_offset,
    )
    return {
        "memories": [serialize_approved_memory(row) for row in rows],
        "next_cursor": _encode_cursor(next_offset),
    }


def list_pending_memories_page(
    *,
    cursor: Any,
    limit: Any,
    memory_store: MemoryStore | MemoryService,
) -> dict[str, object]:
    safe_limit = normalize_positive_limit(
        limit,
        default=DEFAULT_LIST_PAGE_SIZE,
        maximum=MAX_LIST_PAGE_SIZE,
    )
    legacy_offset, snapshot_max_id, after_id = _parse_cursor(cursor)
    rows, next_offset = pending_memory_api(memory_store).get_pending_candidates_page(
        limit=safe_limit,
        snapshot_max_id=snapshot_max_id,
        after_id=after_id,
        legacy_offset=legacy_offset,
    )
    return {
        "candidates": [serialize_pending_memory_candidate(row) for row in rows],
        "next_cursor": _encode_cursor(next_offset),
    }


def update_memory(
    *,
    memory_id: Any,
    patch: Any,
    memory_store: MemoryStore | MemoryService,
) -> ApprovedMemory:
    resolved_memory_id = _parse_memory_id(memory_id)
    if not isinstance(patch, dict):
        raise ValueError("patch must be an object")

    raw_title = patch.get("title", "")
    raw_lesson_text = patch.get("lesson_text", "")
    if not isinstance(raw_title, str):
        raise ValueError("patch.title must be a string")
    if not isinstance(raw_lesson_text, str):
        raise ValueError("patch.lesson_text must be a string")
    title = _normalize_title(raw_title)
    lesson_text = _normalize_lesson_text(raw_lesson_text)
    if not title:
        raise ValueError("patch.title is required")
    if not lesson_text:
        raise ValueError("patch.lesson_text is required")

    approved = approved_memory_api(memory_store)
    existing_memory = approved.get_memory_by_id(resolved_memory_id)
    if existing_memory is None:
        raise ValueError("memory not found")

    return approved.update_memory(
        memory_id=resolved_memory_id,
        title=title,
        lesson_text=lesson_text,
        remove_provenance=patch.get("remove_provenance") is True,
    )


def delete_memory(
    *, memory_id: Any, memory_store: MemoryStore | MemoryService
) -> bool:
    return approved_memory_api(memory_store).delete_memory(_parse_memory_id(memory_id))


def delete_pending_memory(
    *,
    session_id: Any,
    content_fingerprint: Any,
    memory_store: MemoryStore | MemoryService,
) -> bool:
    normalized_session_id = _normalize_spaces(str(session_id or ""))
    normalized_fingerprint = _normalize_spaces(str(content_fingerprint or "")).lower()
    if not normalized_session_id:
        raise ValueError("session_id is required")
    if not normalized_fingerprint:
        raise ValueError("content_fingerprint is required")
    return pending_memory_api(memory_store).delete_pending_candidate(
        session_id=normalized_session_id,
        content_fingerprint=normalized_fingerprint,
    )


def recall_memories(
    *,
    query: Any,
    limit: Any,
    memory_store: MemoryStore | MemoryService,
) -> list[dict[str, object]]:
    normalized_query = require_bounded_text(
        query,
        field="query",
        max_chars=MAX_RECALL_QUERY_CHARS,
    )

    normalized_limit = 3 if limit is None else limit
    if not _is_valid_limit(normalized_limit):
        raise ValueError("limit must be an integer")

    return [
        serialize_approved_memory(memory)
        for memory in approved_memory_api(memory_store).recall_memories(
            normalized_query, limit=normalized_limit
        )
    ]


def recall_recent_memories(
    *,
    lesson_kind: Any,
    limit: Any,
    memory_store: MemoryStore | MemoryService,
) -> list[dict[str, object]]:
    normalized_lesson_kind = _normalize_spaces(str(lesson_kind or "")).lower()
    if not normalized_lesson_kind:
        raise ValueError("lesson_kind is required")

    normalized_limit = 3 if limit is None else limit
    if not _is_valid_limit(normalized_limit):
        raise ValueError("limit must be an integer")

    return [
        serialize_approved_memory(memory)
        for memory in approved_memory_api(memory_store).get_recent_memories_by_kind(
            normalized_lesson_kind,
            normalized_limit,
        )
    ]


def serialize_approved_memory(memory: ApprovedMemory) -> dict[str, object]:
    return {
        "id": memory.id,
        "session_id": memory.session_id,
        "title": memory.title,
        "lesson_text": memory.lesson_text,
        "lesson_kind": memory.lesson_kind,
        "confidence": memory.confidence,
        "source_excerpt": _sanitize_source_excerpt(memory.source_excerpt),
        "content_fingerprint": memory.content_fingerprint,
        "family_key": memory.family_key,
        "provenance": memory.provenance,
        "created_at": memory.created_at,
        "updated_at": memory.updated_at,
    }


def memory_error_payload(error: MemoryStoreError | str) -> dict[str, object]:
    code = error.code if isinstance(error, MemoryStoreError) else CMP_MEMORY_FAILED
    detail = error.message if isinstance(error, MemoryStoreError) else str(error)
    retryable = error.retryable if isinstance(error, MemoryStoreError) else True
    return {
        "code": code,
        "detail": detail[:240],
        "retryable": retryable,
    }
