"""Reads and writes of the schema v10 ``memory_vectors`` table (row 58 W4).

Vectors are derived data: one float32 embedding per active, non-recap memory
row, keyed by the embedder's ``model_key`` and the row's ``content_fingerprint``
at embed time. The v10 triggers drop a vector in the same transaction as the
write that archives, edits or deletes its row; a write here only lands when the
row still has the fingerprint it was embedded from. Nothing here sees or logs
an embedder; the network half lives in :mod:`sidecar.ai.memory.vector_index`.
"""

from __future__ import annotations

import sqlite3
from collections.abc import Sequence
from typing import Any, NamedTuple

from sidecar.ai.error_codes import CMP_MEMORY_FAILED
from sidecar.ai.memory.store_approved import _scope_predicate
from sidecar.ai.memory.store_operations import timestamp
from sidecar.ai.memory.store_shared import (
    _APPROVED_MEMORY_SELECT,
    MEMORY_RETENTION_MAX_DB_BYTES,
    NOT_RECAP_SQL,
    ApprovedMemory,
    _locked,
    _project_scope,
)
from sidecar.ai.memory.store_write_support import _MemoryWriteSupportMixin
from sidecar.exceptions import MemoryStoreError

# The vector leg scans at most this many stored vectors per recall, and at most
# MAX_VECTOR_SCAN_FLOATS floats in all: reading and scoring 5,000 vectors of
# 1,024 floats took about 60 ms, past the 40 ms hybrid recall keeps after the
# query embed. The float cap holds the read near 10 ms at any dimension.
MAX_VECTOR_SCAN_ROWS = 5_000
MAX_VECTOR_SCAN_FLOATS = 5_000 * 384


def vector_scan_rows(dim: int) -> int:
    """The row cap for one recall's vector read at *dim* floats per vector."""

    return max(1, min(MAX_VECTOR_SCAN_ROWS, MAX_VECTOR_SCAN_FLOATS // max(1, int(dim))))


class VectorTarget(NamedTuple):
    memory_id: int
    title: str
    lesson_text: str
    content_fingerprint: str


class StoredVector(NamedTuple):
    memory_id: int
    blob: bytes
    norm: float


def _stale_predicate() -> str:
    """Active non-recap rows with no vector for (model key, dim, fingerprint)."""

    return f"""
        m.status = 'active' AND m.{NOT_RECAP_SQL}
        AND (v.memory_id IS NULL OR v.model_key != ? OR (? > 0 AND v.dim != ?)
             OR v.content_fingerprint != m.content_fingerprint)
    """


class _MemoryVectorsMixin(_MemoryWriteSupportMixin):
    # Provided by the concrete MemoryStore hub; declared for mypy only.
    _database_physical_bytes: Any

    @_locked
    def vector_targets(
        self, *, model_key: str, dims: int, limit: int
    ) -> list[VectorTarget]:
        """The newest rows that need an embedding for *model_key*."""

        try:
            rows = self._connection.execute(
                f"""
                SELECT m.id, m.title, m.lesson_text, m.content_fingerprint
                FROM memories AS m LEFT JOIN memory_vectors AS v ON v.memory_id = m.id
                WHERE {_stale_predicate()}
                ORDER BY m.updated_at DESC, m.id DESC
                LIMIT ?
                """,
                (model_key, dims, dims, max(1, int(limit))),
            ).fetchall()
        except sqlite3.DatabaseError as error:
            raise MemoryStoreError(CMP_MEMORY_FAILED, "failed to read memory vectors") from error
        return [VectorTarget(int(row[0]), str(row[1]), str(row[2]), str(row[3])) for row in rows]

    @_locked
    def count_vector_targets(self, *, model_key: str, dims: int) -> int:
        try:
            row = self._connection.execute(
                f"""
                SELECT COUNT(*)
                FROM memories AS m LEFT JOIN memory_vectors AS v ON v.memory_id = m.id
                WHERE {_stale_predicate()}
                """,
                (model_key, dims, dims),
            ).fetchone()
        except sqlite3.DatabaseError as error:
            raise MemoryStoreError(CMP_MEMORY_FAILED, "failed to read memory vectors") from error
        return int(row[0] if row else 0)

    def vector_capacity_blocked(self) -> bool:
        return self._database_physical_bytes() > MEMORY_RETENTION_MAX_DB_BYTES

    @_locked
    def store_memory_vectors(
        self,
        *,
        model_key: str,
        vectors: Sequence[tuple[VectorTarget, list[float]]],
    ) -> int:
        """Write embeddings in one short transaction; returns how many landed.

        Vectors of every other model key go in the same transaction. A vector
        whose row changed (or left ``active``) since it was read is dropped.
        """

        # The vector codec loads with the first embed step, off the startup path.
        from sidecar.ai.semantic.vectors import pack_vector, validate_vector

        packed: list[tuple[VectorTarget, bytes, int, float]] = []
        for target, values in vectors:
            try:
                blob, dim, norm = pack_vector(validate_vector(values))
            except (TypeError, ValueError, OverflowError):
                continue
            if norm > 0.0:
                packed.append((target, blob, dim, norm))
        stored = 0
        with self._guarded_write():
            self._connection.execute(
                "DELETE FROM memory_vectors WHERE model_key != ?", (model_key,)
            )
            stamp = timestamp(self._now())
            for target, blob, dim, norm in packed:
                cursor = self._connection.execute(
                    f"""
                    INSERT OR REPLACE INTO memory_vectors (
                        memory_id, content_fingerprint, model_key, dim, norm, blob, created_at
                    )
                    SELECT id, content_fingerprint, ?, ?, ?, ?, ? FROM memories
                    WHERE id = ? AND content_fingerprint = ? AND title = ? AND lesson_text = ?
                      AND status = 'active' AND {NOT_RECAP_SQL}
                    """,
                    (
                        model_key, dim, norm, blob, stamp, target.memory_id,
                        target.content_fingerprint, target.title, target.lesson_text,
                    ),
                )
                stored += max(0, int(cursor.rowcount or 0))
        return stored

    @_locked
    def vector_candidates(
        self,
        *,
        model_key: str,
        dim: int,
        project_id: str,
        include_general: bool,
        scope_session_id: str | None,
    ) -> list[StoredVector]:
        """Vectors of in-scope active rows whose fingerprint still matches (capped)."""

        predicate, params = _scope_predicate(
            _project_scope(project_id),
            include_general=include_general,
            scope_session_id=scope_session_id,
            alias="m",
        )
        try:
            rows = self._connection.execute(
                f"""
                SELECT m.id, v.blob, v.norm
                FROM memory_vectors AS v JOIN memories AS m ON m.id = v.memory_id
                WHERE {predicate} AND m.status = 'active' AND v.model_key = ? AND v.dim = ?
                  AND v.content_fingerprint = m.content_fingerprint
                ORDER BY m.id DESC
                LIMIT ?
                """,
                (*params, model_key, int(dim), vector_scan_rows(dim)),
            ).fetchall()
        except sqlite3.DatabaseError as error:
            raise MemoryStoreError(CMP_MEMORY_FAILED, "failed to read memory vectors") from error
        return [StoredVector(int(row[0]), bytes(row[1]), float(row[2])) for row in rows]

    @_locked
    def active_memories_by_id(self, memory_ids: Sequence[int]) -> list[ApprovedMemory]:
        """Active non-recap rows for *memory_ids*, in the given order."""

        ids = [int(memory_id) for memory_id in dict.fromkeys(memory_ids)]
        if not ids:
            return []
        placeholders = ", ".join("?" for _ in ids)
        try:
            rows = self._connection.execute(
                f"{_APPROVED_MEMORY_SELECT} WHERE id IN ({placeholders}) "
                f"AND status = 'active' AND {NOT_RECAP_SQL}",
                tuple(ids),
            ).fetchall()
        except sqlite3.DatabaseError as error:
            raise MemoryStoreError(CMP_MEMORY_FAILED, "failed to read memories") from error
        by_id = {memory.id: memory for memory in self._approved_rows(rows)}
        return [by_id[memory_id] for memory_id in ids if memory_id in by_id]

    @_locked
    def vector_count(self, *, model_key: str | None = None) -> int:
        """Stored vectors, for one model key or all of them."""

        try:
            row = self._connection.execute(
                "SELECT COUNT(*) FROM memory_vectors"
                if model_key is None
                else "SELECT COUNT(*) FROM memory_vectors WHERE model_key = ?",
                () if model_key is None else (model_key,),
            ).fetchone()
        except sqlite3.DatabaseError as error:
            raise MemoryStoreError(CMP_MEMORY_FAILED, "failed to read memory vectors") from error
        return int(row[0] if row else 0)


__all__ = [
    "MAX_VECTOR_SCAN_FLOATS",
    "MAX_VECTOR_SCAN_ROWS",
    "StoredVector",
    "VectorTarget",
    "_MemoryVectorsMixin",
    "vector_scan_rows",
]
