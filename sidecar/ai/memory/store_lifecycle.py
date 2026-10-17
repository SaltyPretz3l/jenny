"""Project archive, session purge and the v9 lifecycle retention sweep.

Archiving a project (desktop project delete, owner decision 2) archives its
active rows, drops its pending candidates and fences every later write for
it (``refused: project_archived``) until ``unarchive_project``. Purging a
session (chat delete) removes that chat's chat-scope rows, reflection cursor
and pending rows, stubs their operations and leaves a marker so a late write
for the chat is ``refused: session_purged``. Both are idempotent. Logs carry
ids and counts only.
"""

from __future__ import annotations

import logging
import sqlite3
from datetime import datetime, timedelta
from typing import Any

from sidecar.ai.error_codes import CMP_MEMORY_FAILED
from sidecar.ai.memory.contracts import (
    ARCHIVED_RETENTION_DAYS,
    GENERAL_PROJECT_ID,
    MAX_MEMORY_PAGE_SIZE,
    MAX_SESSION_ID_CHARS,
    MAX_SESSION_MARKERS,
    require_bounded_text,
    require_project_id,
)
from sidecar.ai.memory.datetime_utils import parse_iso_datetime
from sidecar.ai.memory.store_operations import (
    maintain_operations,
    project_scope_range,
    stub_operations,
    timestamp,
)
from sidecar.ai.memory.store_shared import _locked, _project_scope
from sidecar.ai.memory.store_write_support import _MemoryWriteSupportMixin
from sidecar.exceptions import MemoryStoreError

logger = logging.getLogger(__name__)


def _session(value: Any) -> str:
    if not isinstance(value, str):
        raise ValueError("session_id must be a string")
    return require_bounded_text(value, field="session_id", max_chars=MAX_SESSION_ID_CHARS)


# The status each undoable op leaves its row in; undo needs the row still there.
_UNDO_ROW_STATUS = {
    "remember": "active", "restore": "active", "update": "active", "forget": "archived",
}


def _undoable(row: Any, now: datetime) -> bool:
    op, memory_id, result_revision, expires_at, undone_at = (
        row[1], row[3], row[4], row[6], row[7]
    )
    expires = parse_iso_datetime(expires_at)
    return (
        op in _UNDO_ROW_STATUS
        and memory_id is not None
        and undone_at is None
        and expires is not None
        and expires > now
        and row[8] is not None
        and int(row[8]) == int(result_revision or 0)
        and row[9] == _UNDO_ROW_STATUS[op]
        and not row[10]
    )


class _MemoryLifecycleMixin(_MemoryWriteSupportMixin):
    # The hub-owned attributes (_connection, _now, _guarded_write, ...) are
    # declared on _MemoryWriteSupportMixin for mypy.

    @_locked
    def archive_project(self, project_id: str) -> dict[str, int]:
        """Archive every active row of *project_id* and fence its writes."""

        project = require_project_id(project_id)
        if project == GENERAL_PROJECT_ID:
            raise ValueError("General memories cannot be archived")
        with self._guarded_write():
            stamp = timestamp(self._now())
            archived = self._connection.execute(
                """
                UPDATE memories
                SET status = 'archived', archived_at = ?, revision = revision + 1, updated_at = ?
                WHERE project_id = ? AND status = 'active'
                """,
                (stamp, stamp, project),
            ).rowcount
            pending = self._connection.execute(
                "DELETE FROM pending_memory_candidates WHERE project_id = ?", (project,)
            ).rowcount
            self._connection.execute(
                """
                INSERT OR IGNORE INTO memory_project_state (project_id, archived_at)
                VALUES (?, ?)
                """,
                (project, stamp),
            )
        counts = {"archived": int(archived or 0), "pending_deleted": int(pending or 0)}
        logger.info(
            "memory_project_archived archived=%d pending_deleted=%d",
            counts["archived"],
            counts["pending_deleted"],
        )
        return counts

    @_locked
    def unarchive_project(self, project_id: str) -> bool:
        """Lift the write fence; rows stay archived until restored one by one.

        Their ``archived_at`` restarts so the 30-day archived purge gives the
        user the full window to restore them.
        """

        project = require_project_id(project_id)
        with self._guarded_write():
            removed = self._connection.execute(
                "DELETE FROM memory_project_state WHERE project_id = ?", (project,)
            ).rowcount
            if removed:
                self._connection.execute(
                    """
                    UPDATE memories SET archived_at = ?
                    WHERE project_id = ? AND status = 'archived'
                    """,
                    (timestamp(self._now()), project),
                )
        return bool(removed)

    @_locked
    def purge_session(self, session_id: str) -> dict[str, int]:
        """Delete chat-scope state, clear shared sources and mark the chat purged."""

        session = _session(session_id)
        with self._guarded_write():
            operations = stub_operations(
                self._connection,
                where="memory_id IN (SELECT id FROM memories WHERE scope_session_id = ?)",
                params=(session,),
            )
            memories = self._connection.execute(
                "DELETE FROM memories WHERE scope_session_id = ?", (session,)
            ).rowcount
            cursor = self._connection.execute(
                "DELETE FROM memory_reflection_cursor WHERE session_id = ?", (session,)
            ).rowcount
            pending = self._connection.execute(
                "DELETE FROM pending_memory_candidates WHERE session_id = ?", (session,)
            ).rowcount
            sources_removed = self._connection.execute(
                """
                UPDATE memories
                SET provenance = 'source_removed', source_excerpt = '', source_message_ids = '[]',
                    updated_at = ?
                WHERE session_id = ? AND scope_session_id = ''
                """,
                (timestamp(self._now()), session),
            ).rowcount
            self._connection.execute(
                """
                INSERT OR IGNORE INTO memory_session_markers (session_id, purged_at)
                VALUES (?, ?)
                """,
                (session, timestamp(self._now())),
            )
            self._trim_session_markers()
        counts = {
            "memories": int(memories or 0),
            "operations": operations,
            "pending": int(pending or 0),
            "cursor": int(cursor or 0),
            "sources_removed": int(sources_removed or 0),
        }
        logger.info(
            "memory_session_purged memories=%d operations=%d pending=%d cursor=%d "
            "sources_removed=%d",
            counts["memories"],
            counts["operations"],
            counts["pending"],
            counts["cursor"],
            counts["sources_removed"],
        )
        return counts

    def _trim_session_markers(self) -> int:
        cursor = self._connection.execute(
            """
            DELETE FROM memory_session_markers
            WHERE session_id NOT IN (
                SELECT session_id FROM memory_session_markers
                ORDER BY purged_at DESC, session_id DESC
                LIMIT ?
            )
            """,
            (MAX_SESSION_MARKERS,),
        )
        return int(cursor.rowcount or 0)

    @_locked
    def is_session_purged(self, session_id: str) -> bool:
        session = _session(session_id)
        try:
            row = self._connection.execute(
                "SELECT 1 FROM memory_session_markers WHERE session_id = ? LIMIT 1", (session,)
            ).fetchone()
        except sqlite3.DatabaseError as error:
            raise MemoryStoreError(CMP_MEMORY_FAILED, "failed to read memory state") from error
        return row is not None

    @_locked
    def clear_suppressions(self, *, project_id: str | None = None) -> int:
        """Settings "Clear forgotten list": one project, or every project for None."""

        with self._guarded_write():
            if project_id is None:
                cursor = self._connection.execute("DELETE FROM memory_suppressions")
            else:
                cursor = self._connection.execute(
                    "DELETE FROM memory_suppressions WHERE project_id = ?",
                    (_project_scope(project_id),),
                )
        return int(cursor.rowcount or 0)

    @_locked
    def list_operations(
        self, *, project_id: str, limit: int = MAX_MEMORY_PAGE_SIZE
    ) -> list[dict[str, Any]]:
        """Recent live operations of one project, newest first, without content.

        ``undoable`` is a read-only preview of :meth:`undo`'s preconditions:
        an unexpired, not-undone remember/update/forget/restore whose row still
        has the operation's result revision and status, in a live project and
        chat. ``memory.undo`` stays the authority (suppression and twin checks).
        """

        project = _project_scope(project_id)
        safe_limit = max(1, min(int(limit), MAX_MEMORY_PAGE_SIZE))
        try:
            rows = self._connection.execute(
                """
                SELECT o.operation_id, o.op, o.origin, o.memory_id, o.result_revision,
                       o.created_at, o.expires_at, o.undone_at, m.revision, m.status,
                       EXISTS (SELECT 1 FROM memory_project_state WHERE project_id = ?)
                       OR EXISTS (SELECT 1 FROM memory_session_markers
                                  WHERE m.scope_session_id != ''
                                    AND session_id = m.scope_session_id)
                FROM memory_operations AS o
                LEFT JOIN memories AS m ON m.id = o.memory_id AND m.project_id = ?
                WHERE o.stub = 0 AND o.scope_key >= ? AND o.scope_key < ?
                ORDER BY o.created_at DESC, o.operation_id DESC
                LIMIT ?
                """,
                (project, project, *project_scope_range(project), safe_limit),
            ).fetchall()
        except sqlite3.DatabaseError as error:
            raise MemoryStoreError(CMP_MEMORY_FAILED, "failed to read memory operations") from error
        now = self._now()
        keys = (
            "operation_id", "op", "origin", "memory_id", "result_revision",
            "created_at", "expires_at", "undone_at",
        )
        return [
            {**dict(zip(keys, row[:8], strict=True)), "undoable": _undoable(row, now)}
            for row in rows
        ]

    def _lifecycle_retention(self, *, apply_age_retention: bool) -> dict[str, int]:
        """Ledger stubs, archived-row purge and marker cap (caller holds the transaction)."""

        now = self._now()
        removed = {"memory_operations": maintain_operations(self._connection, now=now)}
        purged = 0
        if apply_age_retention:
            cutoff = timestamp(now - timedelta(days=ARCHIVED_RETENTION_DAYS))
            ids = [
                int(row[0])
                for row in self._connection.execute(
                    """
                    SELECT id FROM memories
                    WHERE status = 'archived' AND archived_at < ?
                      AND project_id NOT IN (SELECT project_id FROM memory_project_state)
                    ORDER BY archived_at ASC, id ASC
                    LIMIT 500
                    """,
                    (cutoff,),
                ).fetchall()
            ]
            if ids:
                placeholders = ", ".join("?" for _ in ids)
                stub_operations(
                    self._connection, where=f"memory_id IN ({placeholders})", params=tuple(ids)
                )
                purged = int(
                    self._connection.execute(
                        f"DELETE FROM memories WHERE id IN ({placeholders})", tuple(ids)
                    ).rowcount
                    or 0
                )
        removed["archived_memories"] = purged
        removed["memory_session_markers"] = self._trim_session_markers()
        return removed


__all__ = ["_MemoryLifecycleMixin"]
