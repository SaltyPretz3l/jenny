"""Optional embedding-based semantic recall for approved memories.

This module provides a vector similarity layer on top of the existing
lexical recall in ``MemoryStore``.  When an embedding engine is
available (e.g. a local Ollama model), memories are embedded at save
time and recall uses cosine similarity to rank candidates.

If no embedding engine is configured, all methods gracefully degrade
to no-ops so the existing BM25-style recall continues to work.

Vectors are stored as packed float32 BLOBs with a precomputed L2 norm
per row (schema v2).  Embeddings are a derived cache: at migration time
pre-v2 rows are preserved in a legacy table rather than dropped, and
are only discarded by a re-embed pass that requires an embedding
provider — so a user without a provider is never stranded with an
unrecoverable index.
"""

from __future__ import annotations

import logging
import math
import sqlite3
import threading
from array import array
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from inspect import signature
from pathlib import Path
from typing import Callable, Iterator, Protocol

from sidecar.ai.error_codes import CMP_MEMORY_SCHEMA_MIGRATION
from sidecar.exceptions import MemoryStoreError

logger = logging.getLogger(__name__)

EMBEDDING_SCHEMA_VERSION = 3
MAX_EMBEDDING_DIM = 4096
MAX_EMBEDDING_MODEL_NAME_CHARS = 128
MAX_EMBEDDING_ROWS = 10_000
EMBEDDING_PROVIDER_TIMEOUT_SECONDS = 10.0
# Upper bound on rows compared per similarity query.  Mirrors the
# aborted_by_timeout_cap pattern: exhaustion is latched on the result
# rather than silently truncating.
MAX_SIMILARITY_SCAN_ROWS = 5000

_LEGACY_TABLE = "memory_embeddings_legacy_v1"


class EmbeddingProvider(Protocol):
    """Protocol for embedding providers (Ollama, etc.)."""

    def embed(self, text: str, *, timeout_seconds: float) -> list[float]:
        """Return a fixed-size embedding vector for the given text."""
        ...


@dataclass(frozen=True)
class ScoredMemory:
    """A memory ID paired with its cosine similarity score."""

    memory_id: int
    similarity: float


@dataclass(frozen=True)
class SimilarityScan:
    """Result of a similarity query, including scan observability."""

    matches: list[ScoredMemory]
    scanned_rows: int
    aborted_by_scan_cap: bool

    @property
    def partial(self) -> bool:
        return self.aborted_by_scan_cap


def _pack_vector(embedding: list[float]) -> tuple[bytes, int, float]:
    """Pack to float32 bytes; the norm is computed on the stored precision."""
    packed = array("f", embedding)
    norm = math.sqrt(sum(value * value for value in packed))
    return packed.tobytes(), len(packed), norm


def _validate_vector(embedding: object) -> list[float]:
    if not isinstance(embedding, list) or not embedding:
        raise ValueError("embedding must be a non-empty list")
    if len(embedding) > MAX_EMBEDDING_DIM:
        raise ValueError("embedding exceeds the dimension limit")
    normalized: list[float] = []
    for value in embedding:
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError("embedding values must be finite numbers")
        number = float(value)
        if not math.isfinite(number):
            raise ValueError("embedding values must be finite numbers")
        normalized.append(number)
    return normalized


def _positive_int(value: object, *, field: str, maximum: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ValueError(f"{field} must be a positive integer")
    return min(value, maximum)


def _model_name(value: object) -> str:
    normalized = str(value or "").strip()
    if len(normalized) > MAX_EMBEDDING_MODEL_NAME_CHARS:
        raise ValueError("model_name exceeds its limit")
    return normalized


def _unpack_vector(blob: object) -> array | None:
    if not isinstance(blob, bytes) or len(blob) % 4 != 0:
        return None
    unpacked = array("f")
    unpacked.frombytes(blob)
    return unpacked


class EmbeddingStore:
    """SQLite-backed vector store for memory embeddings."""

    def __init__(self, db_path: Path) -> None:
        self._db_path = db_path
        db_path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._connection = sqlite3.connect(
            str(db_path),
            timeout=5.0,
            check_same_thread=False,
        )
        self._connection.execute("PRAGMA busy_timeout=5000")
        try:
            self._migrate()
            self._connection.execute("PRAGMA journal_mode=WAL")
            self._connection.execute("PRAGMA synchronous=NORMAL")
            self._connection.execute("PRAGMA wal_autocheckpoint=1000")
            self._connection.execute("PRAGMA journal_size_limit=16777216")
        except Exception:
            self._connection.close()
            raise

    def _migrate(self) -> None:
        stored_version = self._read_schema_version()
        if stored_version > EMBEDDING_SCHEMA_VERSION:
            raise MemoryStoreError(
                CMP_MEMORY_SCHEMA_MIGRATION,
                "future embedding schema is not supported",
            )
        try:
            self._connection.execute("BEGIN IMMEDIATE")
            self._connection.execute("""
            CREATE TABLE IF NOT EXISTS embedding_meta (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
            )
            """)
            if stored_version != EMBEDDING_SCHEMA_VERSION and self._table_exists(
                "memory_embeddings"
            ):
            # Derived cache with a mismatched schema (older *or* future —
            # forward_policy is rewrite_metadata_on_upgrade): preserve the
            # rows for a provider-gated re-embed pass instead of dropping
            # outright.
                if self._table_exists(_LEGACY_TABLE):
                    self._connection.execute("DROP TABLE memory_embeddings")
                else:
                    self._connection.execute(
                        f"ALTER TABLE memory_embeddings RENAME TO {_LEGACY_TABLE}"
                    )
            self._connection.execute("""
            CREATE TABLE IF NOT EXISTS memory_embeddings (
                memory_id  INTEGER PRIMARY KEY CHECK(memory_id > 0),
                embedding  BLOB NOT NULL,
                dim        INTEGER NOT NULL CHECK(dim BETWEEN 1 AND 4096),
                norm       REAL NOT NULL CHECK(norm >= 0.0),
                model_name TEXT NOT NULL DEFAULT '' CHECK(length(model_name) <= 128),
                created_at TEXT NOT NULL DEFAULT ''
            )
            """)
            self._connection.execute("""
            CREATE INDEX IF NOT EXISTS idx_memory_embeddings_model
            ON memory_embeddings (model_name)
            """)
            self._connection.execute(
                """
            INSERT OR REPLACE INTO embedding_meta (key, value)
            VALUES ('schema_version', ?)
                """,
                (str(EMBEDDING_SCHEMA_VERSION),),
            )
            self._connection.commit()
        except Exception:
            self._connection.rollback()
            raise

    def _read_schema_version(self) -> int:
        if not self._table_exists("embedding_meta"):
            return 0
        row = self._connection.execute(
            "SELECT value FROM embedding_meta WHERE key = 'schema_version'"
        ).fetchone()
        try:
            return int(row[0]) if row else 0
        except (TypeError, ValueError):
            return 0

    def _table_exists(self, name: str) -> bool:
        row = self._connection.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
            (name,),
        ).fetchone()
        return row is not None

    def close(self) -> None:
        with self._lock:
            self._connection.close()

    @contextmanager
    def _write_transaction(self) -> Iterator[None]:
        try:
            self._connection.execute("BEGIN IMMEDIATE")
            yield
            self._connection.commit()
        except BaseException:
            try:
                self._connection.rollback()
            except sqlite3.DatabaseError:
                logger.warning("embedding transaction rollback failed")
            raise

    def store_embedding(
        self,
        memory_id: int,
        embedding: list[float],
        model_name: str = "",
    ) -> None:
        """Persist an embedding vector for a memory."""
        safe_memory_id = _positive_int(memory_id, field="memory_id", maximum=2**63 - 1)
        safe_embedding = _validate_vector(embedding)
        safe_model_name = _model_name(model_name)
        blob, dim, norm = _pack_vector(safe_embedding)
        with self._lock:
            with self._write_transaction():
                self._connection.execute(
                    """
                    INSERT OR REPLACE INTO memory_embeddings
                        (memory_id, embedding, dim, norm, model_name, created_at)
                    VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (
                        safe_memory_id,
                        blob,
                        dim,
                        norm,
                        safe_model_name,
                        datetime.now(timezone.utc).isoformat(),
                    ),
                )
                row = self._connection.execute(
                    "SELECT COUNT(*) FROM memory_embeddings"
                ).fetchone()
                excess = max(int(row[0]) - MAX_EMBEDDING_ROWS, 0) if row else 0
                if excess:
                    self._connection.execute(
                        """
                        DELETE FROM memory_embeddings WHERE memory_id IN (
                            SELECT memory_id FROM memory_embeddings
                            ORDER BY created_at ASC, memory_id ASC LIMIT ?
                        )
                        """,
                        (excess,),
                    )

    def get_embedding(self, memory_id: int) -> list[float] | None:
        safe_memory_id = _positive_int(memory_id, field="memory_id", maximum=2**63 - 1)
        with self._lock:
            row = self._connection.execute(
            "SELECT embedding FROM memory_embeddings WHERE memory_id = ?",
                (safe_memory_id,),
            ).fetchone()
        if not row:
            return None
        unpacked = _unpack_vector(row[0])
        return list(unpacked) if unpacked is not None else None

    def delete_embedding(self, memory_id: int) -> None:
        safe_memory_id = _positive_int(memory_id, field="memory_id", maximum=2**63 - 1)
        with self._lock:
            with self._write_transaction():
                self._connection.execute(
                    "DELETE FROM memory_embeddings WHERE memory_id = ?",
                    (safe_memory_id,),
                )

    def find_similar(
        self,
        query_embedding: list[float],
        limit: int = 5,
        min_similarity: float = 0.3,
        model_name: str = "",
        scan_cap: int | None = None,
    ) -> SimilarityScan:
        """Find the most similar memories by cosine similarity.

        Only rows stored under the same ``model_name`` (and matching
        dimensionality) are compared — vectors from different embedding
        models produce meaningless similarities.
        """
        safe_limit = _positive_int(limit, field="limit", maximum=100)
        cap = (
            MAX_SIMILARITY_SCAN_ROWS
            if scan_cap is None
            else _positive_int(scan_cap, field="scan_cap", maximum=MAX_SIMILARITY_SCAN_ROWS)
        )
        if isinstance(min_similarity, bool) or not isinstance(min_similarity, (int, float)):
            raise ValueError("min_similarity must be finite and between -1 and 1")
        safe_similarity = float(min_similarity)
        if not math.isfinite(safe_similarity) or not -1.0 <= safe_similarity <= 1.0:
            raise ValueError("min_similarity must be finite and between -1 and 1")
        query = array("f", _validate_vector(query_embedding))
        query_norm = math.sqrt(sum(value * value for value in query))
        if not len(query) or query_norm == 0.0:
            return SimilarityScan(matches=[], scanned_rows=0, aborted_by_scan_cap=False)

        with self._lock:
            rows = self._connection.execute(
            """
            SELECT memory_id, embedding, norm FROM memory_embeddings
            WHERE model_name = ? AND dim = ?
            ORDER BY memory_id DESC
            LIMIT ?
            """,
                (_model_name(model_name), len(query), cap + 1),
            ).fetchall()

        aborted_by_scan_cap = len(rows) > cap
        if aborted_by_scan_cap:
            rows = rows[:cap]
            logger.warning("Similarity scan aborted at cap (%d rows)", cap)

        scored: list[ScoredMemory] = []
        for memory_id, blob, norm in rows:
            stored = _unpack_vector(blob)
            if stored is None or len(stored) != len(query) or not norm:
                continue
            dot = sum(a * b for a, b in zip(query, stored))
            sim = dot / (query_norm * norm)
            if not math.isfinite(float(norm)) or not math.isfinite(sim):
                continue
            if sim >= safe_similarity:
                scored.append(ScoredMemory(memory_id=memory_id, similarity=sim))

        scored.sort(key=lambda s: s.similarity, reverse=True)
        return SimilarityScan(
            matches=scored[:safe_limit],
            scanned_rows=len(rows),
            aborted_by_scan_cap=aborted_by_scan_cap,
        )

    def count(self) -> int:
        with self._lock:
            row = self._connection.execute("SELECT COUNT(*) FROM memory_embeddings").fetchone()
        return row[0] if row else 0

    def purge_orphans(self, valid_memory_ids: set[int]) -> int:
        safe_ids = {value for value in valid_memory_ids if isinstance(value, int) and value > 0}
        with self._lock:
            rows = self._connection.execute("SELECT memory_id FROM memory_embeddings").fetchall()
            orphans = [int(row[0]) for row in rows if int(row[0]) not in safe_ids]
            if not orphans:
                return 0
            with self._write_transaction():
                self._connection.executemany(
                    "DELETE FROM memory_embeddings WHERE memory_id = ?",
                    ((memory_id,) for memory_id in orphans),
                )
            return len(orphans)

    def legacy_memory_ids(self) -> list[int]:
        """Memory ids preserved from a pre-v2 schema, pending re-embed."""
        with self._lock:
            if not self._table_exists(_LEGACY_TABLE):
                return []
            rows = self._connection.execute(
                f"SELECT memory_id FROM {_LEGACY_TABLE}"  # noqa: S608 - fixed identifier
            ).fetchall()
        return [row[0] for row in rows]

    def remove_legacy_row(self, memory_id: int) -> None:
        """Discard one preserved pre-v2 row (re-embedded or memory gone)."""
        safe_memory_id = _positive_int(memory_id, field="memory_id", maximum=2**63 - 1)
        with self._lock:
            if not self._table_exists(_LEGACY_TABLE):
                return
            with self._write_transaction():
                self._connection.execute(
                    f"DELETE FROM {_LEGACY_TABLE} WHERE memory_id = ?",  # noqa: S608
                    (safe_memory_id,),
                )

    def drop_legacy_rows(self) -> None:
        """Discard preserved pre-v2 rows once a re-embed pass has run."""
        with self._lock:
            with self._write_transaction():
                self._connection.execute(f"DROP TABLE IF EXISTS {_LEGACY_TABLE}")


def _provider_supports_deadline(provider: EmbeddingProvider | None) -> bool:
    if provider is None:
        return False
    try:
        signature(provider.embed).bind("probe", timeout_seconds=1.0)
    except (AttributeError, TypeError, ValueError):
        return False
    return True


class SemanticRecallService:
    """Combines embedding similarity with lexical recall for ranking."""

    def __init__(
        self,
        embedding_store: EmbeddingStore,
        provider: EmbeddingProvider | None = None,
    ) -> None:
        self._store = embedding_store
        self._provider = provider if _provider_supports_deadline(provider) else None
        self._last_recall_partial = False

    @property
    def available(self) -> bool:
        return self._provider is not None

    @property
    def last_recall_partial(self) -> bool:
        return self._last_recall_partial

    def embed_memory(
        self,
        memory_id: int,
        text: str,
        model_name: str = "",
    ) -> bool:
        """Embed and store a memory. Returns False if provider unavailable."""
        if not self._provider:
            return False
        try:
            embedding = self._provider.embed(
                text,
                timeout_seconds=EMBEDDING_PROVIDER_TIMEOUT_SECONDS,
            )
            if not embedding:
                return False
            self._store.store_embedding(memory_id, embedding, model_name)
            return True
        except Exception as error:
            logger.debug(
                "semantic embedding failed",
                extra={"memory_id": memory_id, "error_type": type(error).__name__},
            )
            return False

    def reembed_legacy(
        self,
        get_text: Callable[[int], str | None],
        model_name: str = "",
    ) -> int:
        """Re-embed rows preserved from a pre-v2 schema, then drop them.

        No-op when no provider is configured: the legacy rows stay
        preserved so a later provider configuration can still recover
        the index.  A row is discarded when it re-embeds successfully or
        its memory no longer has text; rows hit by a transient provider
        failure stay pending so a later pass can retry them.  Returns
        the number of memories re-embedded.
        """
        if not self._provider:
            return 0
        reembedded = 0
        for memory_id in self._store.legacy_memory_ids():
            text = get_text(memory_id)
            if not text:
                self._store.remove_legacy_row(memory_id)
                continue
            if self.embed_memory(memory_id, text, model_name):
                self._store.remove_legacy_row(memory_id)
                reembedded += 1
        if not self._store.legacy_memory_ids():
            self._store.drop_legacy_rows()
        return reembedded

    def recall_similar(
        self,
        query: str,
        limit: int = 5,
        min_similarity: float = 0.3,
        model_name: str = "",
    ) -> list[ScoredMemory]:
        """Find memories semantically similar to the query."""
        if not self._provider:
            self._last_recall_partial = False
            return []
        try:
            query_embedding = self._provider.embed(
                query,
                timeout_seconds=EMBEDDING_PROVIDER_TIMEOUT_SECONDS,
            )
            if not query_embedding:
                return []
            scan = self._store.find_similar(
                query_embedding,
                limit=limit,
                min_similarity=min_similarity,
                model_name=model_name,
            )
            self._last_recall_partial = scan.partial
            return [] if scan.partial else scan.matches
        except Exception as error:
            self._last_recall_partial = True
            logger.debug(
                "semantic recall failed",
                extra={"error_type": type(error).__name__},
            )
            return []

    def delete_memory(self, memory_id: int) -> None:
        self._store.delete_embedding(memory_id)
