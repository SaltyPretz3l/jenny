"""Approved-memory reads and recall.

Reads see the v9 lifecycle: listings and recall return ``status='active'``
rows only (``list_archived`` returns the archived ones), chat-scope rows reach
only their own session, and General rows join a project's results when
``include_general`` is set.
"""

from __future__ import annotations

import base64
import binascii
import heapq
import json
import sqlite3
import time
from datetime import datetime, timezone
from typing import Any, Callable, Sequence

from sidecar.ai.error_codes import CMP_MEMORY_FAILED
from sidecar.ai.memory.contracts import (
    GENERAL_PROJECT_ID,
    MAX_CATEGORY_CHARS,
    MAX_LESSON_TEXT_CHARS,
    MAX_MEMORY_PAGE_SIZE,
    MAX_PROVENANCE_CHARS,
    MAX_SESSION_ID_CHARS,
    MAX_SOURCE_EXCERPT_CHARS,
    MAX_TITLE_CHARS,
    is_content_digest,
    require_bounded_text,
    require_finite_confidence,
)
from sidecar.ai.memory.store_shared import (
    _APPROVED_MEMORY_SELECT,
    APPROVED_UPDATED_AT_INDEX,
    MAX_ALL_MEMORIES_LIMIT,
    MAX_PROMPT_RECAP_LINES,
    MAX_RECALL_LIMIT,
    NOT_RECAP_SQL,
    RECAP_PROVENANCE,
    ApprovedMemory,
    _locked,
    _project_scope,
    recall_scopes,
)
from sidecar.exceptions import MemoryStoreError

RECALL_DEADLINE_SECONDS = 0.1
_MAX_RECALL_QUERY_TOKENS = 32
_CURSOR_PREFIX = "v2."
_MAX_CURSOR_CHARS = 256


def _scope_predicate(
    project_id: str,
    *,
    include_general: bool,
    scope_session_id: str | None,
    alias: str = "",
    any_chat: bool = False,
) -> tuple[str, tuple[str, ...]]:
    """Project (plus General) and chat-scope filter for one session, none, or every chat."""

    scopes = recall_scopes(project_id) if include_general else (project_id,)
    column = f"{alias}." if alias else ""
    placeholders = ", ".join("?" for _ in scopes)
    # Reflection recap rows are read only through their own path (row 58 W2).
    not_recap = f"{column}{NOT_RECAP_SQL}"
    if any_chat:
        return f"{column}project_id IN ({placeholders}) AND {not_recap}", scopes
    if scope_session_id:
        return (
            f"{column}project_id IN ({placeholders}) AND {column}scope_session_id IN ('', ?)"
            f" AND {not_recap}",
            (*scopes, scope_session_id),
        )
    return (
        f"{column}project_id IN ({placeholders}) AND {column}scope_session_id = ''"
        f" AND {not_recap}",
        scopes,
    )


def _encode_cursor(updated_at: str, memory_id: int) -> str:
    raw = json.dumps([updated_at, memory_id], separators=(",", ":")).encode("utf-8")
    return _CURSOR_PREFIX + base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _decode_cursor(cursor: str) -> tuple[str, int]:
    if not isinstance(cursor, str) or not cursor.startswith(_CURSOR_PREFIX) or len(cursor) > _MAX_CURSOR_CHARS:
        raise ValueError("cursor is invalid")
    encoded = cursor[len(_CURSOR_PREFIX):]
    try:
        updated_at, memory_id = json.loads(
            base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4)).decode("utf-8")
        )
    except (ValueError, TypeError, UnicodeError, binascii.Error) as error:
        raise ValueError("cursor is invalid") from error
    if not isinstance(updated_at, str) or isinstance(memory_id, bool) or not isinstance(memory_id, int):
        raise ValueError("cursor is invalid")
    return updated_at, memory_id


class _ApprovedMemoriesMixin:
    # _connection is owned by the concrete MemoryStore hub (sidecar/ai/memory/store.py);
    # declared here only so mypy can see it across the mixin split. These are bare
    # annotations with no assigned value, so they have zero runtime effect.
    _connection: sqlite3.Connection
    _quarantine_malformed_row: Callable[..., None]
    _always_on_memories: Callable[[str], list[ApprovedMemory]]

    # --- listings ---------------------------------------------------------------

    @_locked
    def get_all_memories(
        self,
        *,
        project_id: str = GENERAL_PROJECT_ID,
    ) -> list[ApprovedMemory]:
        scope = _project_scope(project_id)
        try:
            rows = self._connection.execute(
                f"""
                {_APPROVED_MEMORY_SELECT}
                WHERE project_id = ? AND status = 'active' AND {NOT_RECAP_SQL}
                ORDER BY updated_at DESC, id DESC LIMIT ?
                """,
                (scope, MAX_ALL_MEMORIES_LIMIT),
            ).fetchall()
        except sqlite3.DatabaseError as error:
            raise MemoryStoreError(CMP_MEMORY_FAILED, "failed to read memories") from error
        return self._approved_rows(rows)

    @_locked
    def get_memories_page(
        self,
        *,
        limit: int,
        snapshot_max_id: int | None = None,
        after_id: int | None = None,
        project_id: str = GENERAL_PROJECT_ID,
        all_projects: bool = False,
    ) -> tuple[list[ApprovedMemory], tuple[int, int] | None]:
        """Legacy id-snapshot page of active rows (the existing Memory page)."""

        scope = None if all_projects else _project_scope(project_id)
        where = f"status = 'active' AND {NOT_RECAP_SQL}" + (
            "" if all_projects else " AND project_id = ?"
        )
        project_params = () if all_projects else (scope,)
        safe_limit = max(1, min(int(limit), 250))
        try:
            if snapshot_max_id is None:
                anchor_row = self._connection.execute(
                    f"SELECT COALESCE(MAX(id), 0) FROM memories WHERE {where}",
                    project_params,
                ).fetchone()
                snapshot_max_id = int(anchor_row[0] if anchor_row else 0)
            safe_snapshot = max(0, int(snapshot_max_id))
            safe_after = safe_snapshot + 1 if after_id is None else max(0, int(after_id))
            rows = self._connection.execute(
                f"""
                {_APPROVED_MEMORY_SELECT}
                WHERE {where} AND id <= ? AND id < ?
                ORDER BY id DESC
                LIMIT ?
                """,
                (*project_params, safe_snapshot, safe_after, safe_limit + 1),
            ).fetchall()
        except sqlite3.DatabaseError as error:
            raise MemoryStoreError(CMP_MEMORY_FAILED, "failed to read memories") from error
        has_more = len(rows) > safe_limit
        page = rows[:safe_limit]
        next_cursor = (safe_snapshot, int(page[-1][0])) if has_more and page else None
        return self._approved_rows(page), next_cursor

    @_locked
    def list_active(
        self,
        *,
        project_id: str,
        scope_session_id: str | None = None,
        include_general: bool = True,
        cursor: str | None = None,
        limit: int = MAX_MEMORY_PAGE_SIZE,
    ) -> tuple[list[ApprovedMemory], str | None]:
        """Active rows newest first; ``scope_session_id`` adds that chat's rows."""

        return self._list_by_status(
            "active", project_id, scope_session_id, include_general, cursor, limit
        )

    @_locked
    def list_archived(
        self,
        *,
        project_id: str,
        scope_session_id: str | None = None,
        include_general: bool = True,
        cursor: str | None = None,
        limit: int = MAX_MEMORY_PAGE_SIZE,
        any_chat: bool = False,
    ) -> tuple[list[ApprovedMemory], str | None]:
        """Archived (forgotten or project-archived) rows, newest first.

        ``any_chat`` (the Settings Forgotten list) adds every chat's notes.
        """

        return self._list_by_status(
            "archived", project_id, scope_session_id, include_general, cursor, limit,
            any_chat=any_chat,
        )

    def _list_by_status(
        self,
        status: str,
        project_id: str,
        scope_session_id: str | None,
        include_general: bool,
        cursor: str | None,
        limit: int,
        *,
        any_chat: bool = False,
    ) -> tuple[list[ApprovedMemory], str | None]:
        scope = _project_scope(project_id)
        safe_limit = max(1, min(int(limit), MAX_MEMORY_PAGE_SIZE))
        predicate, params = _scope_predicate(
            scope, include_general=include_general, scope_session_id=scope_session_id or None,
            any_chat=any_chat,
        )
        keyset = ""
        keyset_params: tuple[Any, ...] = ()
        if cursor:
            updated_at, memory_id = _decode_cursor(cursor)
            keyset = "AND (updated_at < ? OR (updated_at = ? AND id < ?))"
            keyset_params = (updated_at, updated_at, memory_id)
        try:
            rows = self._connection.execute(
                f"""
                {_APPROVED_MEMORY_SELECT}
                WHERE {predicate} AND status = ? {keyset}
                ORDER BY updated_at DESC, id DESC
                LIMIT ?
                """,
                (*params, status, *keyset_params, safe_limit + 1),
            ).fetchall()
        except sqlite3.DatabaseError as error:
            raise MemoryStoreError(CMP_MEMORY_FAILED, "failed to read memories") from error
        page = rows[:safe_limit]
        next_cursor = (
            _encode_cursor(str(page[-1][APPROVED_UPDATED_AT_INDEX]), int(page[-1][0]))
            if len(rows) > safe_limit and page
            else None
        )
        return self._approved_rows(page), next_cursor

    @_locked
    def always_on_rows(self, project_id: str) -> list[ApprovedMemory]:
        """Active always-on rows: General first, then the project's, each oldest id first."""

        try:
            return self._always_on_memories(_project_scope(project_id))
        except sqlite3.DatabaseError as error:
            raise MemoryStoreError(CMP_MEMORY_FAILED, "failed to read memories") from error

    @_locked
    def recaps_for_sessions(
        self, *, project_id: str, session_ids: Sequence[str], limit: int = 3
    ) -> list[tuple[str, str, str]]:
        project = _project_scope(project_id)
        sessions = list(dict.fromkeys(session_ids))
        if not sessions:
            return []
        placeholders = ", ".join("?" for _ in sessions)
        ordering = " ".join(f"WHEN ? THEN {index}" for index in range(len(sessions)))
        try:
            rows = self._connection.execute(
                f"""
                SELECT scope_session_id, lesson_text, updated_at FROM memories
                WHERE project_id = ? AND provenance = ? AND status = 'active'
                  AND scope_session_id IN ({placeholders})
                ORDER BY CASE scope_session_id {ordering} END, updated_at DESC, id DESC
                LIMIT ?
                """,
                (project, RECAP_PROVENANCE, *sessions, *sessions,
                 max(1, min(int(limit), MAX_PROMPT_RECAP_LINES))),
            ).fetchall()
        except sqlite3.DatabaseError as error:
            raise MemoryStoreError(CMP_MEMORY_FAILED, "failed to read recaps") from error
        return [(str(row[0]), str(row[1]), str(row[2])) for row in rows]

    # --- recall -------------------------------------------------------------------

    @_locked
    def recall_memories(
        self,
        query: str,
        limit: int = 3,
        *,
        project_id: str = GENERAL_PROJECT_ID,
        include_general: bool = False,
        scope_session_id: str | None = None,
        deadline: float | None = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> list[ApprovedMemory]:
        scope = _project_scope(project_id)
        normalized_query = str(query or "").strip()
        if not normalized_query:
            raise MemoryStoreError(CMP_MEMORY_FAILED, "query is required")

        # Recall scoring loads with the first recall, off the sidecar startup path.
        from sidecar.ai.memory.recall_scoring import tokenize

        safe_limit = max(1, min(int(limit), MAX_RECALL_LIMIT))
        query_tokens = tokenize(normalized_query)
        if not query_tokens:
            return []

        now = datetime.now(timezone.utc)
        # A caller-supplied deadline lets one prompt bound every store call it
        # makes; on expiry the best matches scored so far are kept and flagged.
        effective_deadline = (
            deadline if deadline is not None else clock() + RECALL_DEADLINE_SECONDS
        )
        self._last_recall_partial = False
        top_matches: list[tuple[float, str, int, sqlite3.Row | tuple[Any, ...]]] = []
        try:
            rows = self._candidate_rows_for_recall(
                query_tokens=query_tokens,
                project_id=scope,
                include_general=include_general,
                scope_session_id=scope_session_id,
            )
            for row in rows:
                if clock() > effective_deadline:
                    self._last_recall_partial = True
                    break
                score = self._score_memory_row(
                    row,
                    query_tokens=query_tokens,
                    now=now,
                )
                if score is None or score <= 0.0:
                    continue
                item = (score, str(row[APPROVED_UPDATED_AT_INDEX]), int(row[0]), row)
                if len(top_matches) < safe_limit:
                    heapq.heappush(top_matches, item)
                    continue
                if item[:3] > top_matches[0][:3]:
                    heapq.heapreplace(top_matches, item)
        except sqlite3.DatabaseError as error:
            raise MemoryStoreError(CMP_MEMORY_FAILED, "failed to read memories") from error

        top_matches.sort(key=lambda item: (item[0], item[1], item[2]), reverse=True)
        return self._approved_rows([row for _, _, _, row in top_matches])

    def _candidate_rows_for_recall(
        self,
        *,
        query_tokens: set[str],
        project_id: str = GENERAL_PROJECT_ID,
        include_general: bool = False,
        scope_session_id: str | None = None,
    ) -> list[sqlite3.Row | tuple[Any, ...]]:
        scope = _project_scope(project_id)
        predicate, params = _scope_predicate(
            scope, include_general=include_general, scope_session_id=scope_session_id
        )
        fts_predicate, fts_params = _scope_predicate(
            scope,
            include_general=include_general,
            scope_session_id=scope_session_id,
            alias="scoped_memory",
        )
        bounded_tokens = sorted(query_tokens, key=lambda token: (-len(token), token))[
            :_MAX_RECALL_QUERY_TOKENS
        ]
        if getattr(self, "_recall_index_available", False):
            fts_query = " OR ".join(
                f'"{token.replace(chr(34), "")}"' for token in bounded_tokens
            )
            if fts_query:
                try:
                    rows = self._connection.execute(
                        f"""
                        {_APPROVED_MEMORY_SELECT}
                        WHERE {predicate} AND status = 'active' AND id IN (
                            SELECT memory_fts.rowid FROM memory_fts
                            JOIN memories AS scoped_memory ON scoped_memory.id = memory_fts.rowid
                            WHERE {fts_predicate} AND scoped_memory.status = 'active'
                              AND memory_fts MATCH ?
                            ORDER BY bm25(memory_fts)
                            LIMIT 1000
                        )
                        ORDER BY updated_at DESC, id DESC
                        """,
                        (*params, *fts_params, fts_query),
                    ).fetchall()
                    if rows:
                        return rows
                except sqlite3.DatabaseError:
                    self._recall_index_available = False
        searchable = "lower(title || ' ' || lesson_text || ' ' || source_excerpt)"
        predicates = " OR ".join(
            f"instr({searchable}, ?) > 0" for _token in bounded_tokens
        )
        return self._connection.execute(
            f"{_APPROVED_MEMORY_SELECT} WHERE {predicate} AND status = 'active' "
            f"AND ({predicates}) ORDER BY updated_at DESC, id DESC LIMIT ?",
            (*params, *bounded_tokens, MAX_ALL_MEMORIES_LIMIT),
        ).fetchall()

    def _score_memory_row(
        self,
        row: sqlite3.Row | tuple[Any, ...],
        *,
        query_tokens: set[str],
        now: datetime,
    ) -> float | None:
        from sidecar.ai.memory.recall_scoring import score_memory

        try:
            memory_id = int(row[0])
            confidence = require_finite_confidence(row[5])
            fingerprint = str(row[7] or "").strip().lower()
            if memory_id <= 0 or not is_content_digest(fingerprint):
                raise ValueError("invalid approved memory identity")
            return score_memory(
                title=str(row[2] or ""),
                lesson_text=str(row[3] or ""),
                source_excerpt=str(row[6] or ""),
                confidence=confidence,
                updated_at=str(row[APPROVED_UPDATED_AT_INDEX] or ""),
                query_tokens=query_tokens,
                now=now,
            )
        except (IndexError, TypeError, ValueError, OverflowError):
            self._quarantine_malformed_row(
                source_table="memories",
                row=row,
                reason_code="malformed_runtime_row",
            )
            return None

    def _approved_rows(
        self,
        rows: list[sqlite3.Row | tuple[Any, ...]],
    ) -> list[ApprovedMemory]:
        converted: list[ApprovedMemory] = []
        for row in rows:
            memory = self._approved_from_row(row)
            if memory is not None:
                converted.append(memory)
        return converted

    def _approved_from_row(
        self,
        row: sqlite3.Row | tuple[Any, ...],
    ) -> ApprovedMemory | None:
        try:
            memory_id = int(row[0])
            confidence = require_finite_confidence(row[5])
            fingerprint = str(row[7] or "").strip().lower()
            if memory_id <= 0 or not is_content_digest(fingerprint):
                raise ValueError("invalid approved memory identity")
            message_ids = json.loads(str(row[19] or "[]"))
            if not isinstance(message_ids, list) or not all(
                isinstance(item, str) for item in message_ids
            ):
                raise ValueError("invalid source_message_ids")
            return ApprovedMemory(
                id=memory_id,
                session_id=require_bounded_text(
                    row[1], field="session_id", max_chars=MAX_SESSION_ID_CHARS
                ),
                title=require_bounded_text(row[2], field="title", max_chars=MAX_TITLE_CHARS),
                lesson_text=require_bounded_text(
                    row[3], field="lesson_text", max_chars=MAX_LESSON_TEXT_CHARS
                ),
                lesson_kind=require_bounded_text(
                    row[4], field="lesson_kind", max_chars=MAX_CATEGORY_CHARS
                ),
                confidence=confidence,
                source_excerpt=require_bounded_text(
                    row[6],
                    field="source_excerpt",
                    max_chars=MAX_SOURCE_EXCERPT_CHARS,
                    allow_blank=True,
                ),
                content_fingerprint=fingerprint,
                provenance=require_bounded_text(
                    row[8], field="provenance", max_chars=MAX_PROVENANCE_CHARS
                ),
                created_at=str(row[9]),
                updated_at=str(row[10]),
                project_id=_project_scope(row[11]),
                scope_session_id=str(row[12] or ""),
                origin=str(row[13]),
                status=str(row[14]),
                archived_at=None if row[15] is None else str(row[15]),
                revision=int(row[16]),
                protected=bool(row[17]),
                always_on=bool(row[18]),
                source_message_ids=tuple(message_ids),
            )
        except (IndexError, TypeError, ValueError, OverflowError, MemoryStoreError):
            self._quarantine_malformed_row(
                source_table="memories",
                row=row,
                reason_code="malformed_runtime_row",
            )
            return None
