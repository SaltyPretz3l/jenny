"""Approved-memory persistence and recall for the sidecar memory store."""

from __future__ import annotations

import heapq
import sqlite3
import time
from contextlib import AbstractContextManager
from datetime import datetime, timezone
from typing import Any, Callable

from sidecar.ai.context.token_budget import CharEstimationBackend, TokenizerBackend
from sidecar.ai.error_codes import (
    CMP_MEMORY_FAILED,
    CMP_MEMORY_FINGERPRINT_CONFLICT,
    CMP_MEMORY_NOT_FOUND,
)
from sidecar.ai.memory.contracts import (
    MAX_CATEGORY_CHARS,
    MAX_FAMILY_KEY_CHARS,
    MAX_LESSON_TEXT_CHARS,
    MAX_PROVENANCE_CHARS,
    MAX_SESSION_ID_CHARS,
    MAX_SOURCE_EXCERPT_CHARS,
    MAX_TITLE_CHARS,
    build_content_digest,
    is_content_digest,
    require_bounded_text,
    require_finite_confidence,
)
from sidecar.ai.memory.recall_scoring import score_memory, tokenize
from sidecar.ai.memory.store_shared import (
    _ALLOWED_MEMORY_PROVENANCE,
    _APPROVED_MEMORY_SELECT,
    MAX_ALL_MEMORIES_LIMIT,
    MAX_RECALL_LIMIT,
    PROMPT_RECALL_TOKEN_BUDGET,
    ApprovedMemory,
    _locked,
)
from sidecar.exceptions import MemoryStoreError

RECALL_DEADLINE_SECONDS = 0.1
_MAX_RECALL_QUERY_TOKENS = 32


class _ApprovedMemoriesMixin:
    # _connection is owned by the concrete MemoryStore hub (sidecar/ai/memory/store.py);
    # declared here only so mypy can see it across the mixin split. This is a bare
    # annotation with no assigned value, so it has zero runtime effect.
    _connection: sqlite3.Connection
    _write_transaction: Callable[[], AbstractContextManager[None]]
    _assert_capacity_for_growth: Callable[[], None]
    _prepare_capacity_for_growth: Callable[[], None]
    _quarantine_malformed_row: Callable[..., None]

    @_locked
    def has_memory_fingerprint(self, content_fingerprint: str) -> bool:
        normalized = str(content_fingerprint or "").strip().lower()
        if not normalized:
            raise MemoryStoreError(CMP_MEMORY_FAILED, "content_fingerprint is required")

        try:
            row = self._connection.execute(
                """
                SELECT 1
                FROM memories
                WHERE content_fingerprint = ?
                LIMIT 1
                """,
                (normalized,),
            ).fetchone()
        except sqlite3.DatabaseError as error:
            raise MemoryStoreError(CMP_MEMORY_FAILED, "failed to read memories") from error

        return bool(row)

    @_locked
    def get_memory_by_id(self, memory_id: int) -> ApprovedMemory | None:
        safe_memory_id = int(memory_id)
        if safe_memory_id <= 0:
            raise MemoryStoreError(CMP_MEMORY_NOT_FOUND, "memory_id must be positive")

        try:
            row = self._connection.execute(
                f"{_APPROVED_MEMORY_SELECT} WHERE id = ? LIMIT 1",
                (safe_memory_id,),
            ).fetchone()
        except sqlite3.DatabaseError as error:
            raise MemoryStoreError(CMP_MEMORY_FAILED, "failed to read memories") from error

        return self._approved_from_row(row) if row else None

    @_locked
    def save_memory(
        self,
        *,
        session_id: str,
        title: str,
        lesson_text: str,
        lesson_kind: str,
        confidence: float,
        source_excerpt: str,
        family_key: str = "",
        provenance: str = "unknown_legacy",
    ) -> tuple[ApprovedMemory, bool]:
        try:
            normalized_session_id = require_bounded_text(
                session_id, field="session_id", max_chars=MAX_SESSION_ID_CHARS
            )
            normalized_title = require_bounded_text(title, field="title", max_chars=MAX_TITLE_CHARS)
            normalized_lesson_text = require_bounded_text(
                lesson_text, field="lesson_text", max_chars=MAX_LESSON_TEXT_CHARS
            )
            normalized_kind = require_bounded_text(
                lesson_kind, field="lesson_kind", max_chars=MAX_CATEGORY_CHARS
            ).lower()
            normalized_source_excerpt = require_bounded_text(
                source_excerpt,
                field="source_excerpt",
                max_chars=MAX_SOURCE_EXCERPT_CHARS,
                allow_blank=True,
            )
            normalized_family_key = require_bounded_text(
                family_key,
                field="family_key",
                max_chars=MAX_FAMILY_KEY_CHARS,
                allow_blank=True,
            ).lower()
            normalized_provenance = require_bounded_text(
                provenance,
                field="provenance",
                max_chars=MAX_PROVENANCE_CHARS,
            ).lower()
            normalized_confidence = require_finite_confidence(confidence)
        except ValueError as error:
            raise MemoryStoreError(CMP_MEMORY_FAILED, str(error)) from error
        normalized_fingerprint = build_content_digest(normalized_kind, normalized_lesson_text)
        if normalized_provenance not in _ALLOWED_MEMORY_PROVENANCE:
            raise MemoryStoreError(CMP_MEMORY_FAILED, "provenance is required")

        timestamp = datetime.now(timezone.utc).isoformat()
        self._prepare_capacity_for_growth()

        try:
            with self._write_transaction():
                existing_row = self._connection.execute(
                    f"{_APPROVED_MEMORY_SELECT} WHERE content_fingerprint = ? LIMIT 1",
                    (normalized_fingerprint,),
                ).fetchone()
                existing = self._approved_from_row(existing_row) if existing_row else None
                if existing:
                    existing_size = sum(
                        len(value)
                        for value in (
                            existing.session_id,
                            existing.title,
                            existing.lesson_text,
                            existing.source_excerpt,
                            existing.family_key,
                        )
                    )
                    replacement_size = sum(
                        len(value)
                        for value in (
                            normalized_session_id,
                            normalized_title,
                            normalized_lesson_text,
                            normalized_source_excerpt,
                            normalized_family_key,
                        )
                    )
                    if replacement_size > existing_size:
                        self._assert_capacity_for_growth()
                    self._connection.execute(
                        """
                        UPDATE memories
                        SET
                            session_id = ?,
                            title = ?,
                            lesson_text = ?,
                            lesson_kind = ?,
                            confidence = ?,
                            source_excerpt = ?,
                            family_key = ?,
                            provenance = ?,
                            updated_at = ?
                        WHERE id = ?
                        """,
                        (
                            normalized_session_id,
                            normalized_title,
                            normalized_lesson_text,
                            normalized_kind,
                            normalized_confidence,
                            normalized_source_excerpt,
                            normalized_family_key,
                            normalized_provenance,
                            timestamp,
                            existing.id,
                        ),
                    )
                    self._connection.execute(
                        """
                        DELETE FROM pending_memory_candidates
                        WHERE session_id = ? AND content_fingerprint = ?
                        """,
                        (normalized_session_id, normalized_fingerprint),
                    )
                    self._connection.execute(
                        "DELETE FROM memory_suppressions WHERE content_fingerprint = ?",
                        (normalized_fingerprint,),
                    )
                if existing:
                    result = (
                        ApprovedMemory(
                            id=existing.id,
                            session_id=normalized_session_id,
                            title=normalized_title,
                            lesson_text=normalized_lesson_text,
                            lesson_kind=normalized_kind,
                            confidence=normalized_confidence,
                            source_excerpt=normalized_source_excerpt,
                            content_fingerprint=normalized_fingerprint,
                            family_key=normalized_family_key,
                            provenance=normalized_provenance,
                            created_at=existing.created_at,
                            updated_at=timestamp,
                        ),
                        False,
                    )
                else:
                    self._assert_capacity_for_growth()
                    cursor = self._connection.execute(
                        """
                    INSERT INTO memories (
                        session_id,
                        title,
                        lesson_text,
                        lesson_kind,
                        confidence,
                        source_excerpt,
                        content_fingerprint,
                        family_key,
                        provenance,
                        created_at,
                        updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                        (
                            normalized_session_id,
                            normalized_title,
                            normalized_lesson_text,
                            normalized_kind,
                            normalized_confidence,
                            normalized_source_excerpt,
                            normalized_fingerprint,
                            normalized_family_key,
                            normalized_provenance,
                            timestamp,
                            timestamp,
                        ),
                    )
                    self._connection.execute(
                        """
                    DELETE FROM pending_memory_candidates
                    WHERE session_id = ? AND content_fingerprint = ?
                    """,
                        (normalized_session_id, normalized_fingerprint),
                    )
                    self._connection.execute(
                        "DELETE FROM memory_suppressions WHERE content_fingerprint = ?",
                        (normalized_fingerprint,),
                    )
                    last_row_id = cursor.lastrowid
                    if last_row_id is None:
                        raise MemoryStoreError(CMP_MEMORY_FAILED, "failed to save memory")
                    result = (
                        ApprovedMemory(
                            id=int(last_row_id),
                            session_id=normalized_session_id,
                            title=normalized_title,
                            lesson_text=normalized_lesson_text,
                            lesson_kind=normalized_kind,
                            confidence=normalized_confidence,
                            source_excerpt=normalized_source_excerpt,
                            content_fingerprint=normalized_fingerprint,
                            family_key=normalized_family_key,
                            provenance=normalized_provenance,
                            created_at=timestamp,
                            updated_at=timestamp,
                        ),
                        True,
                    )
            return result
        except sqlite3.DatabaseError as error:
            raise MemoryStoreError(CMP_MEMORY_FAILED, "failed to save memory") from error

    @_locked
    def update_memory(
        self,
        *,
        memory_id: int,
        title: str,
        lesson_text: str,
        remove_provenance: bool = False,
    ) -> ApprovedMemory:
        existing_memory = self.get_memory_by_id(memory_id)
        if existing_memory is None:
            raise MemoryStoreError(CMP_MEMORY_NOT_FOUND, "memory not found")

        normalized_title = require_bounded_text(
            title,
            field="title",
            max_chars=MAX_TITLE_CHARS,
        )
        normalized_lesson_text = require_bounded_text(
            lesson_text,
            field="lesson_text",
            max_chars=MAX_LESSON_TEXT_CHARS,
        )
        normalized_fingerprint = build_content_digest(
            existing_memory.lesson_kind,
            normalized_lesson_text,
        )

        try:
            conflicting_memory = self._connection.execute(
                """
                SELECT 1
                FROM memories
                WHERE id != ? AND content_fingerprint = ?
                LIMIT 1
                """,
                (
                    existing_memory.id,
                    normalized_fingerprint,
                ),
            ).fetchone()
        except sqlite3.DatabaseError as error:
            raise MemoryStoreError(CMP_MEMORY_FAILED, "failed to read memories") from error
        if conflicting_memory:
            raise MemoryStoreError(
                CMP_MEMORY_FINGERPRINT_CONFLICT,
                "content_fingerprint already exists",
            )

        if len(normalized_title) + len(normalized_lesson_text) > (
            len(existing_memory.title) + len(existing_memory.lesson_text)
        ):
            self._prepare_capacity_for_growth()
            self._assert_capacity_for_growth()

        timestamp = datetime.now(timezone.utc).isoformat()
        try:
            with self._write_transaction():
                self._connection.execute(
                    """
                    UPDATE memories
                    SET
                        title = ?,
                        lesson_text = ?,
                        content_fingerprint = ?,
                        source_excerpt = ?,
                        provenance = ?,
                        updated_at = ?
                    WHERE id = ?
                    """,
                    (
                        normalized_title,
                        normalized_lesson_text,
                        normalized_fingerprint,
                        "" if remove_provenance else existing_memory.source_excerpt,
                        "source_removed" if remove_provenance else existing_memory.provenance,
                        timestamp,
                        existing_memory.id,
                    ),
                )
                self._connection.execute(
                    "DELETE FROM memory_suppressions WHERE content_fingerprint = ?",
                    (normalized_fingerprint,),
                )
        except sqlite3.IntegrityError as error:
            raise MemoryStoreError(
                CMP_MEMORY_FINGERPRINT_CONFLICT,
                "content_fingerprint already exists",
            ) from error
        except sqlite3.DatabaseError as error:
            raise MemoryStoreError(CMP_MEMORY_FAILED, "failed to save memory") from error

        return ApprovedMemory(
            id=existing_memory.id,
            session_id=existing_memory.session_id,
            title=normalized_title,
            lesson_text=normalized_lesson_text,
            lesson_kind=existing_memory.lesson_kind,
            confidence=existing_memory.confidence,
            source_excerpt="" if remove_provenance else existing_memory.source_excerpt,
            content_fingerprint=normalized_fingerprint,
            family_key=existing_memory.family_key,
            provenance="source_removed" if remove_provenance else existing_memory.provenance,
            created_at=existing_memory.created_at,
            updated_at=timestamp,
        )

    @_locked
    def delete_memory(self, memory_id: int) -> bool:
        safe_memory_id = int(memory_id)
        if safe_memory_id <= 0:
            raise MemoryStoreError(CMP_MEMORY_FAILED, "memory_id must be positive")

        try:
            with self._write_transaction():
                row = self._connection.execute(
                    "SELECT content_fingerprint FROM memories WHERE id = ? LIMIT 1",
                    (safe_memory_id,),
                ).fetchone()
                if row is None:
                    return False
                fingerprint = str(row[0])
                cursor = self._connection.execute(
                    """
                    DELETE FROM memories
                    WHERE id = ?
                    """,
                    (safe_memory_id,),
                )
                self._connection.execute(
                    "DELETE FROM pending_memory_candidates WHERE content_fingerprint = ?",
                    (fingerprint,),
                )
                self._connection.execute(
                    """
                    INSERT INTO memory_suppressions (
                        content_fingerprint, reason, created_at
                    ) VALUES (?, 'forgotten', ?)
                    ON CONFLICT(content_fingerprint) DO UPDATE SET
                        reason = excluded.reason,
                        created_at = excluded.created_at
                    """,
                    (fingerprint, datetime.now(timezone.utc).isoformat()),
                )
        except sqlite3.DatabaseError as error:
            raise MemoryStoreError(CMP_MEMORY_FAILED, "failed to delete memory") from error

        return int(cursor.rowcount or 0) > 0

    @_locked
    def get_all_memories(self) -> list[ApprovedMemory]:
        try:
            rows = self._connection.execute(
                f"{_APPROVED_MEMORY_SELECT} ORDER BY updated_at DESC, id DESC LIMIT ?",
                (MAX_ALL_MEMORIES_LIMIT,),
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
        legacy_offset: int | None = None,
    ) -> tuple[list[ApprovedMemory], tuple[int, int] | int | None]:
        safe_limit = max(1, min(int(limit), 250))
        try:
            if legacy_offset is not None:
                safe_offset = max(0, int(legacy_offset))
                rows = self._connection.execute(
                    f"""
                    {_APPROVED_MEMORY_SELECT}
                    ORDER BY updated_at DESC, id DESC
                    LIMIT ? OFFSET ?
                    """,
                    (safe_limit + 1, safe_offset),
                ).fetchall()
                has_more = len(rows) > safe_limit
                page = rows[:safe_limit]
                return (
                    self._approved_rows(page),
                    safe_offset + safe_limit if has_more else None,
                )

            if snapshot_max_id is None:
                anchor_row = self._connection.execute(
                    "SELECT COALESCE(MAX(id), 0) FROM memories"
                ).fetchone()
                snapshot_max_id = int(anchor_row[0] if anchor_row else 0)
            safe_snapshot = max(0, int(snapshot_max_id))
            safe_after = safe_snapshot + 1 if after_id is None else max(0, int(after_id))
            rows = self._connection.execute(
                f"""
                {_APPROVED_MEMORY_SELECT}
                WHERE id <= ? AND id < ?
                ORDER BY id DESC
                LIMIT ?
                """,
                (safe_snapshot, safe_after, safe_limit + 1),
            ).fetchall()
        except sqlite3.DatabaseError as error:
            raise MemoryStoreError(CMP_MEMORY_FAILED, "failed to read memories") from error
        has_more = len(rows) > safe_limit
        page = rows[:safe_limit]
        next_cursor = (
            (safe_snapshot, int(page[-1][0])) if has_more and page else None
        )
        return (
            self._approved_rows(page),
            next_cursor,
        )

    @_locked
    def get_recent_memories_by_kind(self, lesson_kind: str, limit: int = 3) -> list[ApprovedMemory]:
        normalized_kind = str(lesson_kind or "").strip().lower()
        if not normalized_kind:
            raise MemoryStoreError(CMP_MEMORY_FAILED, "lesson_kind is required")

        safe_limit = max(1, min(int(limit), MAX_RECALL_LIMIT))
        try:
            rows = self._connection.execute(
                f"{_APPROVED_MEMORY_SELECT} WHERE lesson_kind = ? ORDER BY updated_at DESC, id DESC LIMIT ?",
                (normalized_kind, safe_limit),
            ).fetchall()
        except sqlite3.DatabaseError as error:
            raise MemoryStoreError(CMP_MEMORY_FAILED, "failed to read memories") from error

        return self._approved_rows(rows)

    @_locked
    def recall_memories(self, query: str, limit: int = 3) -> list[ApprovedMemory]:
        normalized_query = str(query or "").strip()
        if not normalized_query:
            raise MemoryStoreError(CMP_MEMORY_FAILED, "query is required")

        safe_limit = max(1, min(int(limit), MAX_RECALL_LIMIT))
        query_tokens = tokenize(normalized_query)
        if not query_tokens:
            return []

        now = datetime.now(timezone.utc)
        deadline = time.perf_counter() + RECALL_DEADLINE_SECONDS
        self._last_recall_partial = False
        top_matches: list[tuple[float, str, int, sqlite3.Row | tuple[Any, ...]]] = []
        try:
            rows = self._candidate_rows_for_recall(
                normalized_query=normalized_query,
                query_tokens=query_tokens,
            )
            for row in rows:
                if time.perf_counter() > deadline:
                    self._last_recall_partial = True
                    return []
                score = self._score_memory_row(
                    row,
                    query_tokens=query_tokens,
                    normalized_query=normalized_query,
                    now=now,
                )
                if score is None or score <= 0.0:
                    continue
                memory_id = int(row[0])
                item = (score, str(row[11]), memory_id, row)
                if len(top_matches) < safe_limit:
                    heapq.heappush(top_matches, item)
                    continue
                candidate_key = (item[0], item[1], item[2])
                worst_key = (
                    top_matches[0][0],
                    top_matches[0][1],
                    top_matches[0][2],
                )
                if candidate_key > worst_key:
                    heapq.heapreplace(top_matches, item)
        except sqlite3.DatabaseError as error:
            raise MemoryStoreError(CMP_MEMORY_FAILED, "failed to read memories") from error

        top_matches.sort(key=lambda item: (item[0], item[1], item[2]), reverse=True)
        if time.perf_counter() > deadline:
            self._last_recall_partial = True
            return []
        return self._approved_rows([row for _, _, _, row in top_matches])

    def _candidate_rows_for_recall(
        self,
        *,
        normalized_query: str,
        query_tokens: set[str],
    ) -> list[sqlite3.Row | tuple[Any, ...]]:
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
                        WHERE id IN (
                            SELECT rowid FROM memory_fts
                            WHERE memory_fts MATCH ?
                            ORDER BY bm25(memory_fts)
                            LIMIT 1000
                        )
                        ORDER BY updated_at DESC, id DESC
                        """,
                        (fts_query,),
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
            f"{_APPROVED_MEMORY_SELECT} WHERE {predicates} "
            "ORDER BY updated_at DESC, id DESC LIMIT ?",
            (*bounded_tokens, MAX_ALL_MEMORIES_LIMIT),
        ).fetchall()

    @_locked
    def recall_memories_for_prompt(
        self,
        query: str,
        *,
        limit: int = MAX_RECALL_LIMIT,
        max_prompt_tokens: int = PROMPT_RECALL_TOKEN_BUDGET,
        backend: TokenizerBackend | None = None,
    ) -> list[ApprovedMemory]:
        try:
            token_cap = max(0, int(max_prompt_tokens))
        except (TypeError, ValueError):
            token_cap = 0
        if token_cap <= 0:
            return []
        token_backend = backend if backend is not None else CharEstimationBackend()
        selected: list[ApprovedMemory] = []
        tokens_used = 0
        for memory in self.recall_memories(query, limit=limit):
            memory_tokens = max(1, token_backend.count_tokens(self._prompt_recall_text(memory)))
            if tokens_used + memory_tokens > token_cap:
                continue
            selected.append(memory)
            tokens_used += memory_tokens
        return selected

    @staticmethod
    def _prompt_recall_text(memory: ApprovedMemory) -> str:
        return "\n".join(
            (
                memory.title,
                memory.lesson_kind,
                memory.lesson_text,
                memory.source_excerpt,
            )
        )

    def _score_memory_row(
        self,
        row: sqlite3.Row | tuple[Any, ...],
        *,
        query_tokens: set[str],
        normalized_query: str,
        now: datetime,
    ) -> float | None:
        try:
            memory_id = int(row[0])
            confidence = require_finite_confidence(row[5])
            fingerprint = str(row[7] or "").strip().lower()
            if memory_id <= 0 or not is_content_digest(fingerprint):
                raise ValueError("invalid approved memory identity")
            return score_memory(
                lesson_kind=str(row[4] or ""),
                family_key=str(row[8] or ""),
                title=str(row[2] or ""),
                lesson_text=str(row[3] or ""),
                source_excerpt=str(row[6] or ""),
                confidence=confidence,
                updated_at=str(row[11] or ""),
                query_tokens=query_tokens,
                normalized_query=normalized_query,
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
                family_key=require_bounded_text(
                    row[8],
                    field="family_key",
                    max_chars=MAX_FAMILY_KEY_CHARS,
                    allow_blank=True,
                ),
                provenance=require_bounded_text(
                    row[9], field="provenance", max_chars=MAX_PROVENANCE_CHARS
                ),
                created_at=str(row[10]),
                updated_at=str(row[11]),
            )
        except (IndexError, TypeError, ValueError, OverflowError):
            self._quarantine_malformed_row(
                source_table="memories",
                row=row,
                reason_code="malformed_runtime_row",
            )
            return None
