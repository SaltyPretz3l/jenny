"""Bounded chat-scope export, guarded import, and deletion reconciliation reads."""

from __future__ import annotations

import sqlite3
from collections.abc import Callable, Sequence
from typing import Any

from sidecar.ai.error_codes import CMP_MEMORY_CAPACITY_EXCEEDED, CMP_MEMORY_FAILED
from sidecar.ai.memory.contracts import (
    MAX_LESSON_TEXT_CHARS,
    MAX_SESSION_ID_CHARS,
    MEMORY_KINDS,
    normalize_positive_limit,
    require_bounded_text,
)
from sidecar.ai.memory.store_shared import (
    NOT_RECAP_SQL,
    RECAP_PROVENANCE,
    MemoryWriteResult,
    _locked,
    _project_scope,
)
from sidecar.ai.memory.store_write_support import _memory_text, _MemoryWriteSupportMixin
from sidecar.exceptions import MemoryStoreError

MAX_TRANSFER_NOTES = 200
MAX_CHAT_SESSIONS = 2000


def _session(value: str) -> str:
    if not isinstance(value, str):
        raise ValueError("session_id must be a string")
    return require_bounded_text(value, field="session_id", max_chars=MAX_SESSION_ID_CHARS)


class _ImportRefused(Exception):
    def __init__(self, reason: str) -> None:
        self.reason = reason


class _MemorySessionTransferMixin(_MemoryWriteSupportMixin):
    remember: Callable[..., MemoryWriteResult]

    @_locked
    def export_session(self, session_id: str) -> dict[str, Any]:
        session = _session(session_id)
        try:
            if self._connection.execute(
                "SELECT 1 FROM memory_session_markers WHERE session_id = ?", (session,)
            ).fetchone():
                return {"notes": [], "recap": None}
            notes = self._connection.execute(
                f"""SELECT lesson_text, lesson_kind, origin, created_at FROM memories
                WHERE scope_session_id = ? AND status = 'active' AND {NOT_RECAP_SQL}
                ORDER BY created_at, id LIMIT ?""",
                (session, MAX_TRANSFER_NOTES),
            ).fetchall()
            recap = self._connection.execute(
                """SELECT lesson_text, updated_at FROM memories
                WHERE scope_session_id = ? AND status = 'active' AND provenance = ?
                ORDER BY updated_at DESC, id DESC LIMIT 1""",
                (session, RECAP_PROVENANCE),
            ).fetchone()
        except sqlite3.DatabaseError as error:
            raise MemoryStoreError(
                CMP_MEMORY_FAILED, "failed to export session memories"
            ) from error
        return {
            "notes": [
                dict(zip(("text", "kind", "origin", "created_at"), row, strict=True))
                for row in notes
            ],
            "recap": None if recap is None else {"text": recap[0], "updated_at": recap[1]},
        }

    @_locked
    def import_session(
        self, *, session_id: str, project_id: str,
        notes: Sequence[dict[str, str]], recap: str | None = None,
    ) -> dict[str, Any]:
        session, project = _session(session_id), _project_scope(project_id)
        imported = 0
        try:
            with self._guarded_write():
                if self._connection.execute(
                    "SELECT 1 FROM memory_session_markers WHERE session_id = ?", (session,)
                ).fetchone():
                    raise _ImportRefused("session_purged")
                if self._connection.execute(
                    "SELECT 1 FROM memory_project_state WHERE project_id = ?", (project,)
                ).fetchone():
                    raise _ImportRefused("project_archived")
                for index, note in enumerate(notes):
                    if note["kind"] not in MEMORY_KINDS:
                        continue
                    origin = "reflection" if note.get("origin") == "reflection" else "jenny"
                    result = self._import_note(
                        session, project, f"import:{session}:{index}", note["text"], note["kind"],
                        origin, "reflection" if origin == "reflection" else "automatic",
                    )
                    if (
                        result and result.status == "saved"
                        and not (result.duplicate or result.replayed)
                    ):
                        imported += 1
                # Lazy: the reflection checks stay off the sidecar startup path.
                from sidecar.ai.memory.reflection_checks import scrub_recap

                text = scrub_recap(recap)
                if text and not self._connection.execute(
                    """SELECT 1 FROM memories WHERE scope_session_id = ?
                    AND provenance = ? AND status = 'active' LIMIT 1""",
                    (session, RECAP_PROVENANCE),
                ).fetchone():
                    self._import_note(session, project, f"import-recap:{session}", text,
                                      "fact", "reflection", RECAP_PROVENANCE)
        except _ImportRefused as refused:
            return {"status": "refused", "reason": refused.reason, "imported": 0, "skipped": 0}
        return {"status": "imported", "imported": imported, "skipped": len(notes) - imported}

    def _import_note(  # noqa: PLR0913 - mirrors the nested remember write.
        self, session: str, project: str, operation_id: str, text: str,
        kind: str, origin: str, provenance: str,
    ) -> MemoryWriteResult | None:
        try:
            cleaned = _memory_text(text, "text", MAX_LESSON_TEXT_CHARS)
        except MemoryStoreError:
            return None
        try:
            return self.remember(
                operation_id=operation_id, project_id=project, text=cleaned, kind=kind,
                origin=origin, provenance=provenance, session_id=session, scope_session_id=session,
            )
        except MemoryStoreError as error:
            if error.code != CMP_MEMORY_CAPACITY_EXCEEDED:
                raise
            return None

    @_locked
    def chat_sessions(self, *, limit: int = MAX_CHAT_SESSIONS) -> dict[str, Any]:
        safe_limit = normalize_positive_limit(
            limit, default=MAX_CHAT_SESSIONS, maximum=MAX_CHAT_SESSIONS
        )
        try:
            rows = self._connection.execute(
                """SELECT session_id FROM (
                    SELECT scope_session_id AS session_id FROM memories WHERE scope_session_id != ''
                    UNION SELECT session_id FROM memory_reflection_cursor
                    UNION SELECT session_id FROM pending_memory_candidates
                    UNION SELECT session_id FROM memories WHERE scope_session_id = ''
                        AND provenance != 'source_removed'
                        AND (source_excerpt != '' OR source_message_ids != '[]')
                ) AS sessions WHERE session_id != '' AND NOT EXISTS (
                    SELECT 1 FROM memory_session_markers AS purged
                    WHERE purged.session_id = sessions.session_id
                ) ORDER BY session_id LIMIT ?""",
                (safe_limit + 1,),
            ).fetchall()
        except sqlite3.DatabaseError as error:
            raise MemoryStoreError(
                CMP_MEMORY_FAILED, "failed to list memory chat sessions"
            ) from error
        return {"session_ids": [str(row[0]) for row in rows[:safe_limit]],
                "truncated": len(rows) > safe_limit}
