"""Validation, schema v9 service calls and serializers for the memory.* JSON-RPC methods.

Every write goes through the v9 service (``remember/update/forget/restore/undo``)
with ``origin="user"``: these methods are Electron's explicit user actions,
never model tools. The one exception is ``memory.import_session`` (row 58 W3),
which recreates an imported chat's notes with non-user origins so suppression
still applies. Refusals and conflicts come back as results; validation
failures raise :class:`ValueError` (``MemoryRequestError`` when a specific
``CMP-MEM`` code applies) and become JSON-RPC invalid-params errors upstream.
"""

from __future__ import annotations

import base64
import binascii
import re
import uuid
from typing import Any

from sidecar.ai.error_codes import CMP_MEMORY_FAILED, CMP_MEMORY_INVALID_KIND
from sidecar.ai.memory.contracts import (
    DEFAULT_LIST_PAGE_SIZE,
    GENERAL_PROJECT_ID,
    MAX_LESSON_TEXT_CHARS,
    MAX_LIST_PAGE_SIZE,
    MAX_OPERATION_ID_CHARS,
    MAX_RECALL_QUERY_CHARS,
    MAX_SESSION_ID_CHARS,
    MEMORY_KINDS,
    is_content_digest,
    normalize_positive_limit,
    require_bounded_text,
    require_finite_confidence,
)
from sidecar.ai.memory.service import (
    MemoryService,
    MemoryWriteResult,
    approved_memory_api,
    pending_memory_api,
)
from sidecar.ai.memory.store import ApprovedMemory, MemoryStore, PendingMemoryCandidate
from sidecar.ai.tools.sanitization import scrub_memory_text
from sidecar.exceptions import MemoryStoreError
from sidecar.runtime.memory_text import (
    _normalize_spaces,
    _normalize_title,
    _sanitize_source_excerpt,
)

MemoryBackend = MemoryStore | MemoryService

_OPERATION_ID_RE = re.compile(rf"^[A-Za-z0-9_.:-]{{1,{MAX_OPERATION_ID_CHARS}}}$")
_LIST_STATUSES = ("active", "archived")
_MAX_V9_CURSOR_CHARS = 256
# memory.update fields a caller may change; at least one must be present.
UPDATE_FIELDS = ("lesson_text", "lesson_kind", "title", "always_on", "remove_provenance")


class MemoryRequestError(ValueError):
    """An invalid memory request that maps to one specific ``CMP-MEM`` code."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


# --- request validation ------------------------------------------------------------


def request_operation_id(value: Any, *, field: str = "operation_id") -> str:
    """Validate a caller-supplied operation id; generate ``rpc:<uuid4>`` when absent."""

    if value is None:
        return f"rpc:{uuid.uuid4()}"
    if not isinstance(value, str) or not _OPERATION_ID_RE.fullmatch(value):
        raise ValueError(f"{field} is invalid")
    return value


def _require_kind(value: Any, *, field: str) -> str:
    kind = value.strip().lower() if isinstance(value, str) else ""
    if kind not in MEMORY_KINDS:
        raise MemoryRequestError(
            CMP_MEMORY_INVALID_KIND, f"{field} must be one of {', '.join(MEMORY_KINDS)}"
        )
    return kind


def _require_text(value: Any, *, field: str) -> str:
    if not isinstance(value, str):
        raise ValueError(f"{field} must be a string")
    cleaned, secret = scrub_memory_text(value)
    if secret:
        raise ValueError(f"{field} looks like a credential and is not stored")
    return require_bounded_text(cleaned, field=field, max_chars=MAX_LESSON_TEXT_CHARS)


def _optional_title(value: Any, *, field: str) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError(f"{field} must be a string")
    return _normalize_title(value) or None


def _optional_flag(value: Any, *, field: str) -> bool | None:
    if value is None:
        return None
    if not isinstance(value, bool):
        raise ValueError(f"{field} must be a boolean")
    return value


def _optional_session(value: Any, *, field: str) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError(f"{field} must be a string")
    return require_bounded_text(
        value, field=field, max_chars=MAX_SESSION_ID_CHARS, allow_blank=True
    )


def _optional_revision(value: Any) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise ValueError("expected_revision must be a positive integer")
    return value


def parse_memory_id(value: Any) -> int:
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


# --- writes -----------------------------------------------------------------------


def save_memory_candidate(  # noqa: PLR0913 - mirrors the memory.save params.
    *,
    session_id: Any,
    candidate: Any,
    memory_store: MemoryBackend,
    project_id: str = GENERAL_PROJECT_ID,
    scope_session_id: Any = None,
    always_on: Any = None,
    operation_id: Any = None,
) -> MemoryWriteResult:
    """memory.save: one explicit user save (a duplicate returns the existing row)."""

    origin_session = require_bounded_text(
        session_id, field="session_id", max_chars=MAX_SESSION_ID_CHARS
    )
    if not isinstance(candidate, dict):
        raise ValueError("candidate must be an object")
    text = _require_text(candidate.get("lesson_text"), field="candidate.lesson_text")
    title = _optional_title(candidate.get("title"), field="candidate.title")
    kind = _require_kind(candidate.get("lesson_kind"), field="candidate.lesson_kind")
    scope_session = _optional_session(scope_session_id, field="scope_session_id") or ""
    wants_always_on = _optional_flag(always_on, field="always_on") or False
    if wants_always_on and scope_session:
        raise ValueError("always_on needs project or global scope")
    optional: dict[str, Any] = {}
    if candidate.get("confidence") is not None:
        optional["confidence"] = require_finite_confidence(
            candidate.get("confidence"), field="candidate.confidence"
        )
    return approved_memory_api(memory_store).remember(
        operation_id=request_operation_id(operation_id),
        project_id=project_id,
        text=text,
        kind=kind,
        origin="user",
        session_id=origin_session,
        scope_session_id=scope_session,
        always_on=wants_always_on,
        source_excerpt=_sanitize_source_excerpt(candidate.get("source_excerpt", "")),
        title=title,
        **optional,
    )


def update_memory(  # noqa: PLR0913 - mirrors the memory.update params.
    *,
    memory_id: Any,
    changes: dict[str, Any],
    memory_store: MemoryBackend,
    project_id: str = GENERAL_PROJECT_ID,
    expected_revision: Any = None,
    operation_id: Any = None,
) -> MemoryWriteResult:
    """memory.update: edit one active row in place; a user edit protects it."""

    if not any(changes.get(field) is not None for field in UPDATE_FIELDS):
        raise ValueError(f"memory.update needs one of {', '.join(UPDATE_FIELDS)}")
    text = changes.get("lesson_text")
    kind = changes.get("lesson_kind")
    return approved_memory_api(memory_store).update(
        operation_id=request_operation_id(operation_id),
        project_id=project_id,
        memory_id=parse_memory_id(memory_id),
        text=None if text is None else _require_text(text, field="lesson_text"),
        kind=None if kind is None else _require_kind(kind, field="lesson_kind"),
        title=_optional_title(changes.get("title"), field="title"),
        always_on=_optional_flag(changes.get("always_on"), field="always_on"),
        remove_provenance=bool(
            _optional_flag(changes.get("remove_provenance"), field="remove_provenance")
        ),
        expected_revision=_optional_revision(expected_revision),
        origin="user",
    )


def delete_memory(
    *,
    memory_id: Any,
    memory_store: MemoryBackend,
    project_id: str = GENERAL_PROJECT_ID,
    expected_revision: Any = None,
    operation_id: Any = None,
) -> MemoryWriteResult:
    """memory.delete: forget (archive + suppress) one active row; undoable."""

    return approved_memory_api(memory_store).forget(
        operation_id=request_operation_id(operation_id),
        project_id=project_id,
        memory_id=parse_memory_id(memory_id),
        expected_revision=_optional_revision(expected_revision),
        origin="user",
    )


def restore_memory(
    *,
    memory_id: Any,
    memory_store: MemoryBackend,
    project_id: str = GENERAL_PROJECT_ID,
    operation_id: Any = None,
    target_project_id: str | None = None,
) -> MemoryWriteResult:
    """memory.restore: bring one archived row back and lift its suppression
    (with *target_project_id*, a deleted project's row goes into that project)."""

    approved = approved_memory_api(memory_store)
    request: dict[str, Any] = {"operation_id": request_operation_id(operation_id),
                               "project_id": project_id, "memory_id": parse_memory_id(memory_id)}
    if target_project_id is not None:
        return approved.restore_to(**request, target_project_id=target_project_id)
    return approved.restore(**request, origin="user")


def undo_memory_operation(
    *,
    operation_id: Any,
    memory_store: MemoryBackend,
    project_id: str = GENERAL_PROJECT_ID,
    undo_operation_id: Any = None,
) -> MemoryWriteResult:
    """memory.undo: invert one recorded operation of *project_id*."""

    if operation_id is None:
        raise ValueError("operation_id is required")
    return approved_memory_api(memory_store).undo(
        operation_id=request_operation_id(operation_id),
        undo_operation_id=request_operation_id(undo_operation_id, field="undo_operation_id"),
        project_id=project_id,
    )


def archive_project_memories(*, memory_store: MemoryBackend, project_id: str) -> dict[str, object]:
    """memory.archive_project: the desktop project delete (General is refused)."""

    counts = approved_memory_api(memory_store).archive_project(project_id)
    return {
        "ok": True,
        "archived": int(counts.get("archived", 0)),
        "pending_removed": int(counts.get("pending_deleted", 0)),
    }


def purge_session_memories(*, session_id: Any, memory_store: MemoryBackend) -> dict[str, object]:
    """memory.purge_session: drop one deleted chat's chat-scope memory state."""

    if not isinstance(session_id, str):
        raise ValueError("session_id must be a string")
    session = require_bounded_text(session_id, field="session_id", max_chars=MAX_SESSION_ID_CHARS)
    counts = approved_memory_api(memory_store).purge_session(session)
    return {"ok": True, "removed": int(counts.get("memories", 0))}


def clear_memory_suppressions(
    *, memory_store: MemoryBackend, project_id: str | None
) -> dict[str, object]:
    """memory.clear_suppressions: one project's forgotten list, or every project's."""

    return {"cleared": approved_memory_api(memory_store).clear_suppressions(project_id=project_id)}


# --- reads ------------------------------------------------------------------------


_CURSOR_PREFIX = "v1:"
_MAX_CURSOR_CHARS = 128


def _parse_cursor(value: Any) -> tuple[int | None, int | None]:
    if value in (None, ""):
        return None, None
    if isinstance(value, bool):
        raise ValueError("cursor is invalid")
    normalized = str(value).strip()
    if len(normalized) > _MAX_CURSOR_CHARS:
        raise ValueError("cursor is invalid")
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
    return snapshot_max_id, after_id


def _encode_cursor(value: tuple[int, int] | None) -> str | None:
    if value is None:
        return None
    snapshot_max_id, after_id = value
    raw = f"{snapshot_max_id}:{after_id}".encode("ascii")
    return _CURSOR_PREFIX + base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def list_memories_page(  # noqa: PLR0913 - mirrors the memory.list params.
    *,
    cursor: Any,
    limit: Any,
    memory_store: MemoryBackend,
    project_id: str = GENERAL_PROJECT_ID,
    all_projects: bool = False,
    status: Any = None,
    scope_session_id: Any = None,
) -> dict[str, object]:
    """memory.list: the id-snapshot page of active rows, or a v9 status page.

    Active rows without a chat scope keep the legacy snapshot cursor (and the
    every-project view); archived rows and a chat scope use the v9 lister,
    which pages one project (plus that chat) newest first.
    """

    wanted = "active" if status is None else status
    if wanted not in _LIST_STATUSES:
        raise ValueError("status must be 'active' or 'archived'")
    scope_session = _optional_session(scope_session_id, field="scope_session_id")
    safe_limit = normalize_positive_limit(
        limit, default=DEFAULT_LIST_PAGE_SIZE, maximum=MAX_LIST_PAGE_SIZE
    )
    approved = approved_memory_api(memory_store)
    if wanted == "active" and not scope_session:
        snapshot_max_id, after_id = _parse_cursor(cursor)
        rows, next_offset = approved.get_memories_page(
            limit=safe_limit,
            snapshot_max_id=snapshot_max_id,
            after_id=after_id,
            project_id=project_id,
            all_projects=all_projects,
        )
        return {
            "memories": [serialize_approved_memory(row) for row in rows],
            "next_cursor": _encode_cursor(next_offset),
        }
    if all_projects:
        raise ValueError("scope 'all' lists active memories only")
    if cursor not in (None, "") and (
        not isinstance(cursor, str) or len(cursor) > _MAX_V9_CURSOR_CHARS
    ):
        raise ValueError("cursor is invalid")
    if wanted == "archived":
        # Without a chat, the Settings Forgotten list: every chat's notes too,
        # as the active Settings list shows them.
        page, next_cursor = approved.list_archived(
            project_id=project_id,
            scope_session_id=scope_session or None,
            include_general=False,
            cursor=cursor or None,
            limit=safe_limit,
            any_chat=not scope_session,
        )
    else:
        page, next_cursor = approved.list_active(
            project_id=project_id,
            scope_session_id=scope_session,
            include_general=False,
            cursor=cursor or None,
            limit=safe_limit,
        )
    return {
        "memories": [serialize_approved_memory(row) for row in page],
        "next_cursor": next_cursor,
    }


def list_pending_memories_page(
    *,
    cursor: Any,
    limit: Any,
    memory_store: MemoryBackend,
    project_id: str = GENERAL_PROJECT_ID,
    all_projects: bool = False,
) -> dict[str, object]:
    safe_limit = normalize_positive_limit(
        limit,
        default=DEFAULT_LIST_PAGE_SIZE,
        maximum=MAX_LIST_PAGE_SIZE,
    )
    snapshot_max_id, after_id = _parse_cursor(cursor)
    rows, next_offset = pending_memory_api(memory_store).get_pending_candidates_page(
        limit=safe_limit,
        snapshot_max_id=snapshot_max_id,
        after_id=after_id,
        project_id=project_id,
        all_projects=all_projects,
    )
    return {
        "candidates": [serialize_pending_memory_candidate(row) for row in rows],
        "next_cursor": _encode_cursor(next_offset),
    }


def delete_pending_memory(
    *,
    session_id: Any,
    content_fingerprint: Any,
    memory_store: MemoryBackend,
    project_id: str = GENERAL_PROJECT_ID,
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
        project_id=project_id,
    )


def accept_pending_memory(
    *,
    session_id: Any,
    content_fingerprint: Any,
    memory_store: MemoryBackend,
    project_id: str = GENERAL_PROJECT_ID,
    operation_id: Any = None,
) -> MemoryWriteResult:
    """memory.pending.accept: save one queued proposal under its own queued scope."""

    session = require_bounded_text(
        session_id, field="session_id", max_chars=MAX_SESSION_ID_CHARS
    )
    fingerprint = _normalize_spaces(str(content_fingerprint or "")).lower()
    if not fingerprint:
        raise ValueError("content_fingerprint is required")
    if not is_content_digest(fingerprint):
        raise ValueError("content_fingerprint is invalid")
    return pending_memory_api(memory_store).accept_pending(
        operation_id=request_operation_id(operation_id),
        project_id=project_id,
        session_id=session,
        content_fingerprint=fingerprint,
    )


def recall_memories(  # noqa: PLR0913 - mirrors the memory.recall params.
    *,
    query: Any,
    limit: Any,
    memory_store: MemoryBackend,
    project_id: str = GENERAL_PROJECT_ID,
    include_general: bool = False,
    scope_session_id: Any = None,
) -> list[dict[str, object]]:
    normalized_query = require_bounded_text(
        query,
        field="query",
        max_chars=MAX_RECALL_QUERY_CHARS,
    )
    normalized_limit = 3 if limit is None else limit
    if isinstance(normalized_limit, bool) or not isinstance(normalized_limit, int):
        raise ValueError("limit must be an integer")
    scope_session = _optional_session(scope_session_id, field="scope_session_id")
    return [
        serialize_approved_memory(memory)
        for memory in approved_memory_api(memory_store).recall_memories(
            normalized_query,
            limit=normalized_limit,
            project_id=project_id,
            include_general=include_general,
            scope_session_id=scope_session or None,
        )
    ]


# --- serializers -------------------------------------------------------------------


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
        "provenance": memory.provenance,
        "created_at": memory.created_at,
        "updated_at": memory.updated_at,
        "project_id": memory.project_id,
        "scope_session_id": memory.scope_session_id,
        "origin": memory.origin,
        "status": memory.status,
        "archived_at": memory.archived_at,
        "revision": memory.revision,
        "protected": memory.protected,
        "always_on": memory.always_on,
        "source_message_ids": list(memory.source_message_ids),
    }


def serialize_pending_memory_candidate(candidate: PendingMemoryCandidate) -> dict[str, object]:
    return {
        "id": candidate.id,
        "session_id": candidate.session_id,
        "source_request_id": candidate.source_request_id,
        "title": candidate.title,
        "lesson_text": candidate.lesson_text,
        "lesson_kind": candidate.lesson_kind,
        "confidence": candidate.confidence,
        "source_excerpt": _sanitize_source_excerpt(candidate.source_excerpt),
        "content_fingerprint": candidate.content_fingerprint,
        "category": candidate.category,
        "created_at": candidate.created_at,
        "updated_at": candidate.updated_at,
        "project_id": candidate.project_id,
    }


def serialize_write_result(result: MemoryWriteResult) -> dict[str, object]:
    """The shared v9 write payload; refusals and conflicts carry reason and code."""

    payload: dict[str, object] = {
        "status": result.status,
        "memory": (
            serialize_approved_memory(result.memory) if result.memory is not None else None
        ),
        "operation_id": result.operation_id,
        "duplicate": result.duplicate,
        "replayed": result.replayed,
        "undoable": result.undoable,
    }
    if result.reason is not None:
        payload["reason"] = result.reason
        payload["code"] = result.code
    if result.always_on_lines:
        payload["always_on_lines"] = list(result.always_on_lines)
    return payload


def memory_error_payload(error: MemoryStoreError | ValueError | str) -> dict[str, object]:
    if isinstance(error, MemoryStoreError):
        code, detail, retryable = error.code, error.message, error.retryable
    elif isinstance(error, MemoryRequestError):
        code, detail, retryable = error.code, str(error), False
    else:
        code, detail, retryable = CMP_MEMORY_FAILED, str(error), True
    return {
        "code": code,
        "detail": detail[:240],
        "retryable": retryable,
    }
