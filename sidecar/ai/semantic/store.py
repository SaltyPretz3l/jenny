"""SQLite store for the semantic catalog (roots, documents, chunks, vectors).

The index is a derived cache: an unreadable file is renamed aside and rebuilt,
while a newer schema is refused (``CatalogStoreError``). Every write runs in a
``BEGIN IMMEDIATE`` transaction under one RLock; caps stop additions and are
reported, nothing is evicted silently.
"""

from __future__ import annotations

import logging
import sqlite3
import threading
from collections.abc import Callable, Iterable, Iterator, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from sidecar.ai.error_codes import CMP_CATALOG_INDEX_UNAVAILABLE
from sidecar.ai.semantic.vectors import pack_vector
from sidecar.exceptions import CompanionError

logger = logging.getLogger(__name__)

SEMANTIC_CATALOG_SCHEMA_VERSION = 1
MAX_CATALOG_ROOTS = 32
MAX_CATALOG_DOCUMENTS = 20_000
MAX_CATALOG_CHUNKS = 20_000
MAX_CHUNKS_PER_DOCUMENT = 400
DOCUMENT_STATUSES = ("pending", "indexed", "failed", "skipped")
_VECTOR_FETCH_PAGE = 512

_SCHEMA = (
    "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    """CREATE TABLE IF NOT EXISTS roots (
        root_key TEXT PRIMARY KEY, path TEXT NOT NULL, scan_complete_at TEXT)""",
    """CREATE TABLE IF NOT EXISTS documents (
        doc_id INTEGER PRIMARY KEY,
        root_key TEXT NOT NULL REFERENCES roots(root_key) ON DELETE CASCADE,
        rel_path TEXT NOT NULL, size INTEGER, mtime_ns INTEGER, sha256 TEXT,
        status TEXT NOT NULL CHECK(status IN ('pending','indexed','failed','skipped')),
        reason TEXT, seen_scan INTEGER NOT NULL DEFAULT 0, updated_at TEXT,
        UNIQUE(root_key, rel_path))""",
    """CREATE TABLE IF NOT EXISTS chunks (
        chunk_id INTEGER PRIMARY KEY,
        doc_id INTEGER NOT NULL REFERENCES documents(doc_id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL, locator TEXT NOT NULL, text TEXT NOT NULL,
        UNIQUE(doc_id, ordinal))""",
    """CREATE TABLE IF NOT EXISTS vectors (
        chunk_id INTEGER NOT NULL REFERENCES chunks(chunk_id) ON DELETE CASCADE,
        model_key TEXT NOT NULL, dim INTEGER NOT NULL, norm REAL NOT NULL,
        blob BLOB NOT NULL, PRIMARY KEY(chunk_id, model_key))""",
    "CREATE INDEX IF NOT EXISTS idx_documents_status ON documents(status, updated_at)",
    "CREATE INDEX IF NOT EXISTS idx_vectors_model ON vectors(model_key, chunk_id)",
)


class CatalogStoreError(CompanionError):
    """Raised when the catalog index cannot be used (``CMP_CATALOG_INDEX_UNAVAILABLE``)."""


@dataclass(frozen=True)
class RootRow:
    root_key: str
    path: str
    scan_complete_at: str | None


@dataclass(frozen=True)
class DocumentStat:
    size: int | None
    mtime_ns: int | None
    seen: bool


@dataclass(frozen=True)
class ScanEntry:
    rel_path: str
    size: int
    mtime_ns: int


@dataclass(frozen=True)
class PendingDocument:
    doc_id: int
    root_key: str
    root_path: str
    rel_path: str
    sha256: str | None
    chunk_count: int


@dataclass(frozen=True)
class ChunkInput:
    ordinal: int
    locator: str
    text: str


@dataclass(frozen=True)
class EmbeddableChunk:
    chunk_id: int
    text: str
    rel_path: str
    doc_id: int = 0


@dataclass(frozen=True)
class VectorRow:
    chunk_id: int
    blob: bytes
    norm: float
    text: str
    locator: str
    rel_path: str
    root_path: str


def empty_root_counts() -> dict[str, Any]:
    return {"documents": 0, **dict.fromkeys(DOCUMENT_STATUSES, 0), "skipped_reasons": {}}


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _placeholders(count: int) -> str:
    return ",".join("?" for _ in range(count))


class CatalogStore:
    """Bounded SQLite catalog index; safe to share across worker threads."""

    def __init__(self, db_path: Path, *, read_only: bool = False) -> None:
        """Open (creating or migrating) the index; ``read_only`` opens an existing file only.

        A read-only store (the knowledge_search reader in the builtin tools
        subprocess) never creates, migrates or sets aside a file: the main
        sidecar owns the writer, and a reader must not race it.
        """
        self._db_path = Path(db_path)
        self._lock = threading.RLock()
        self._closed = False
        if read_only:
            try:
                self._connection = self._open_read_only()
            except (sqlite3.Error, OSError) as error:
                raise CatalogStoreError(
                    CMP_CATALOG_INDEX_UNAVAILABLE,
                    f"catalog index unavailable ({type(error).__name__})",
                ) from error
            return
        try:
            self._db_path.parent.mkdir(parents=True, exist_ok=True)
            try:
                self._connection = self._open_and_migrate()
            except sqlite3.OperationalError:
                raise  # locked/unopenable is not corruption: never set a healthy file aside
            except sqlite3.DatabaseError as error:
                self._set_aside_corrupt_file(error)
                self._connection = self._open_and_migrate()
        except (sqlite3.Error, OSError) as error:
            raise CatalogStoreError(
                CMP_CATALOG_INDEX_UNAVAILABLE, f"catalog index unavailable ({type(error).__name__})"
            ) from error

    # -- lifecycle -----------------------------------------------------------

    def _open_and_migrate(self) -> sqlite3.Connection:
        connection = sqlite3.connect(str(self._db_path), timeout=5.0, check_same_thread=False)
        try:
            connection.execute("PRAGMA busy_timeout=5000")
            connection.execute("PRAGMA foreign_keys=ON")
            self._migrate(connection)
            connection.execute("PRAGMA journal_mode=WAL")
            connection.execute("PRAGMA synchronous=NORMAL")
        except BaseException:
            connection.close()
            raise
        return connection

    def _open_read_only(self) -> sqlite3.Connection:
        if not self._db_path.is_file():
            raise FileNotFoundError("catalog index not built yet")
        uri = f"{self._db_path.resolve().as_uri()}?mode=ro"
        connection = sqlite3.connect(uri, uri=True, timeout=5.0, check_same_thread=False)
        try:
            connection.execute("PRAGMA busy_timeout=5000")
            if self._read_version(connection) != SEMANTIC_CATALOG_SCHEMA_VERSION:
                raise sqlite3.DatabaseError("catalog index schema mismatch")
        except BaseException:
            connection.close()
            raise
        return connection

    @staticmethod
    def _read_version(connection: sqlite3.Connection) -> int:
        row = connection.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'"
        ).fetchone()
        if row is None:
            return 0
        value = connection.execute(
            "SELECT value FROM meta WHERE key = 'schema_version'"
        ).fetchone()
        try:
            return int(value[0]) if value else 0
        except (TypeError, ValueError):
            return 0

    def _migrate(self, connection: sqlite3.Connection) -> None:
        version = self._read_version(connection)
        if version > SEMANTIC_CATALOG_SCHEMA_VERSION:
            raise CatalogStoreError(
                CMP_CATALOG_INDEX_UNAVAILABLE, "catalog index schema is newer than this app"
            )
        connection.execute("BEGIN IMMEDIATE")
        try:
            for statement in _SCHEMA:
                connection.execute(statement)
            connection.execute(
                "INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)",
                (str(SEMANTIC_CATALOG_SCHEMA_VERSION),),
            )
            connection.commit()
        except BaseException:
            connection.rollback()
            raise

    def _set_aside_corrupt_file(self, error: sqlite3.DatabaseError) -> None:
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
        for suffix in ("", "-wal", "-shm"):
            source = Path(f"{self._db_path}{suffix}")
            if source.exists():
                source.replace(Path(f"{self._db_path}.corrupt-{stamp}{suffix}"))
        logger.warning(
            "semantic catalog index was unreadable and is rebuilt from scratch",
            extra={"error_type": type(error).__name__, "set_aside_suffix": f".corrupt-{stamp}"},
        )

    def close(self) -> None:
        """Close the connection (idempotent) so the files can be moved or deleted."""
        with self._lock:
            if self._closed:
                return
            self._closed = True
            self._connection.close()

    @property
    def closed(self) -> bool:
        return self._closed

    def size_bytes(self) -> int:
        """Best-effort on-disk size of the index, including WAL/SHM files."""
        total = 0
        for suffix in ("", "-wal", "-shm"):
            try:
                total += Path(f"{self._db_path}{suffix}").stat().st_size
            except OSError:
                continue
        return total

    @property
    def schema_version(self) -> int:
        with self._lock:
            return self._read_version(self._connection)

    @contextmanager
    def _write(self) -> Iterator[sqlite3.Connection]:
        with self._lock:
            self._connection.execute("BEGIN IMMEDIATE")
            try:
                yield self._connection
                self._connection.commit()
            except BaseException:
                self._connection.rollback()
                raise

    def _scalar(self, sql: str, params: Sequence[object] = ()) -> int:
        with self._lock:
            row = self._connection.execute(sql, tuple(params)).fetchone()
        return int(row[0]) if row and row[0] is not None else 0

    # -- roots ---------------------------------------------------------------

    def roots(self) -> list[RootRow]:
        with self._lock:
            rows = self._connection.execute(
                "SELECT root_key, path, scan_complete_at FROM roots ORDER BY root_key"
            ).fetchall()
        return [RootRow(str(key), str(path), complete) for key, path, complete in rows]

    def add_root(self, root_key: str, path: str) -> bool:
        """Insert a root unless the root cap is reached; existing roots stay."""
        with self._write() as connection:
            if connection.execute(
                "SELECT 1 FROM roots WHERE root_key = ?", (root_key,)
            ).fetchone():
                connection.execute("UPDATE roots SET path = ? WHERE root_key = ?", (path, root_key))
                return True
            count = connection.execute("SELECT COUNT(*) FROM roots").fetchone()[0]
            if int(count) >= MAX_CATALOG_ROOTS:
                return False
            connection.execute(
                "INSERT INTO roots (root_key, path, scan_complete_at) VALUES (?, ?, NULL)",
                (root_key, path),
            )
            return True

    def delete_roots(self, root_keys: Iterable[str] | None) -> int:
        """Delete the given roots (all when ``None``) with their rows and scan state.

        Returns the number of documents removed by the cascade.
        """
        with self._write() as connection:
            if root_keys is None:
                documents = connection.execute("SELECT COUNT(*) FROM documents").fetchone()[0]
                connection.execute("DELETE FROM roots")
                return int(documents)
            keys = list(root_keys)
            if not keys:
                return 0
            marks = _placeholders(len(keys))
            documents = connection.execute(
                f"SELECT COUNT(*) FROM documents WHERE root_key IN ({marks})", keys
            ).fetchone()[0]
            connection.execute(f"DELETE FROM roots WHERE root_key IN ({marks})", keys)
            return int(documents)

    def begin_rescan(self, root_key: str) -> None:
        """Start a fresh scan cycle: forget which files the last scan saw."""
        with self._write() as connection:
            connection.execute(
                "UPDATE documents SET seen_scan = 0 WHERE root_key = ?", (root_key,)
            )
            connection.execute(
                "UPDATE roots SET scan_complete_at = NULL WHERE root_key = ?", (root_key,)
            )

    def complete_scan(self, root_key: str) -> int:
        """Close a scan cycle: drop documents it did not see; returns the purge count."""
        with self._write() as connection:
            purged = connection.execute(
                "DELETE FROM documents WHERE root_key = ? AND seen_scan = 0", (root_key,)
            ).rowcount
            connection.execute(
                "UPDATE roots SET scan_complete_at = ? WHERE root_key = ?", (_utc_now(), root_key)
            )
        return int(purged)

    # -- documents -----------------------------------------------------------

    def document_stats(self, root_key: str) -> dict[str, DocumentStat]:
        with self._lock:
            rows = self._connection.execute(
                "SELECT rel_path, size, mtime_ns, seen_scan FROM documents WHERE root_key = ?",
                (root_key,),
            ).fetchall()
        return {str(rel): DocumentStat(size, mtime, bool(seen)) for rel, size, mtime, seen in rows}

    def apply_scan(self, root_key: str, entries: Sequence[ScanEntry]) -> int:
        """Upsert scanned files (changed/new -> pending, all -> seen).

        Returns how many new files were dropped because the document cap is
        reached; they are retried by later scans once space exists.
        """
        dropped = 0
        now = _utc_now()
        with self._write() as connection:
            total = int(connection.execute("SELECT COUNT(*) FROM documents").fetchone()[0])
            capacity = (
                connection.execute("SELECT COUNT(*) FROM chunks").fetchone()[0] < MAX_CATALOG_CHUNKS
            )
            for entry in entries:
                row = connection.execute(
                    "SELECT doc_id, size, mtime_ns FROM documents"
                    " WHERE root_key = ? AND rel_path = ?",
                    (root_key, entry.rel_path),
                ).fetchone()
                if row is None:
                    if total >= MAX_CATALOG_DOCUMENTS:
                        dropped += 1
                        continue
                    connection.execute(
                        "INSERT INTO documents (root_key, rel_path, size, mtime_ns, status,"
                        " seen_scan, updated_at) VALUES (?, ?, ?, ?, 'pending', 1, ?)",
                        (root_key, entry.rel_path, entry.size, entry.mtime_ns, now),
                    )
                    total += 1
                elif (row[1], row[2]) != (entry.size, entry.mtime_ns):
                    connection.execute(
                        "UPDATE documents SET size = ?, mtime_ns = ?, status = 'pending',"
                        " reason = NULL, seen_scan = 1, updated_at = ? WHERE doc_id = ?",
                        (entry.size, entry.mtime_ns, now, row[0]),
                    )
                else:
                    # Retry embed failures and, when space exists, cap skips
                    # once per scan cycle.
                    connection.execute(
                        "UPDATE documents SET seen_scan = 1,"
                        " status = CASE WHEN reason = 'embed_failed'"
                        " OR (? AND status = 'skipped' AND reason = 'cap_reached')"
                        " THEN 'pending' ELSE status END,"
                        " reason = CASE WHEN reason = 'embed_failed'"
                        " OR (? AND status = 'skipped' AND reason = 'cap_reached')"
                        " THEN NULL ELSE reason END WHERE doc_id = ?",
                        (capacity, capacity, row[0]),
                    )
        return dropped

    def pending_documents(self, limit: int) -> list[PendingDocument]:
        with self._lock:
            rows = self._connection.execute(
                """SELECT d.doc_id, d.root_key, r.path, d.rel_path, d.sha256,
                       (SELECT COUNT(*) FROM chunks c WHERE c.doc_id = d.doc_id)
                   FROM documents d JOIN roots r ON r.root_key = d.root_key
                   WHERE d.status = 'pending'
                   ORDER BY d.updated_at ASC, d.doc_id ASC LIMIT ?""",
                (int(limit),),
            ).fetchall()
        return [PendingDocument(*row) for row in rows]

    def mark_document(
        self, doc_id: int, status: str, reason: str | None, *, sha256: str | None = None
    ) -> None:
        """Set a terminal status; non-indexed outcomes drop the document's chunks."""
        if status not in DOCUMENT_STATUSES:
            raise ValueError("unknown document status")
        with self._write() as connection:
            if status != "indexed":
                connection.execute("DELETE FROM chunks WHERE doc_id = ?", (doc_id,))
            connection.execute(
                "UPDATE documents SET status = ?, reason = ?, sha256 = COALESCE(?, sha256),"
                " updated_at = ? WHERE doc_id = ?",
                (status, reason, sha256, _utc_now(), doc_id),
            )

    def replace_chunks(self, doc_id: int, chunks: Sequence[ChunkInput], sha256: str) -> bool:
        """Swap a document's chunks (vectors cascade); False when the chunk cap is hit."""
        with self._write() as connection:
            connection.execute("DELETE FROM chunks WHERE doc_id = ?", (doc_id,))
            total = int(connection.execute("SELECT COUNT(*) FROM chunks").fetchone()[0])
            if total + len(chunks) > MAX_CATALOG_CHUNKS:
                status, reason = "skipped", "cap_reached"
            else:
                connection.executemany(
                    "INSERT INTO chunks (doc_id, ordinal, locator, text) VALUES (?, ?, ?, ?)",
                    [(doc_id, c.ordinal, c.locator, c.text) for c in chunks],
                )
                status, reason = "indexed", None
            connection.execute(
                "UPDATE documents SET status = ?, reason = ?, sha256 = ?, updated_at = ?"
                " WHERE doc_id = ?",
                (status, reason, sha256, _utc_now(), doc_id),
            )
        return status == "indexed"

    # -- vectors -------------------------------------------------------------

    def chunks_missing_vectors(self, model_key: str, limit: int) -> list[EmbeddableChunk]:
        with self._lock:
            rows = self._connection.execute(
                """SELECT c.chunk_id, c.text, d.rel_path, c.doc_id FROM chunks c
                   JOIN documents d ON d.doc_id = c.doc_id
                   WHERE NOT EXISTS (SELECT 1 FROM vectors v
                                     WHERE v.chunk_id = c.chunk_id AND v.model_key = ?)
                   ORDER BY c.chunk_id ASC LIMIT ?""",
                (model_key, int(limit)),
            ).fetchall()
        return [
            EmbeddableChunk(int(cid), str(text), str(rel), int(doc_id))
            for cid, text, rel, doc_id in rows
        ]

    def count_missing_vectors(self, model_key: str) -> int:
        return self._scalar(
            """SELECT COUNT(*) FROM chunks c WHERE NOT EXISTS (
                   SELECT 1 FROM vectors v WHERE v.chunk_id = c.chunk_id AND v.model_key = ?)""",
            (model_key,),
        )

    def store_vectors(self, model_key: str, rows: Sequence[tuple[int, list[float]]]) -> int:
        """Persist normalized vectors; chunks replaced meanwhile are skipped."""
        stored = 0
        with self._write() as connection:
            for chunk_id, vector in rows:
                blob, dim, norm = pack_vector(vector)
                stored += connection.execute(
                    "INSERT OR REPLACE INTO vectors (chunk_id, model_key, dim, norm, blob)"
                    " SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM chunks WHERE chunk_id = ?)",
                    (chunk_id, model_key, dim, norm, blob, chunk_id),
                ).rowcount
        return stored

    def drop_other_models(self, model_key: str) -> int:
        with self._write() as connection:
            return int(
                connection.execute(
                    "DELETE FROM vectors WHERE model_key != ?", (model_key,)
                ).rowcount
            )

    def vector_rows(
        self,
        model_key: str,
        root_keys: Sequence[str],
        *,
        dim: int,
        cap: int,
        expired: Callable[[], bool],
    ) -> tuple[list[VectorRow], bool]:
        """Newest-first vectors for ``model_key`` within ``root_keys``.

        Returns ``(rows, partial)``; partial when the scan cap or the deadline
        stopped the read before every candidate row was fetched.
        """
        if not root_keys:
            return [], False
        sql = f"""SELECT v.chunk_id, v.blob, v.norm, c.text, c.locator, d.rel_path, r.path
                  FROM vectors v JOIN chunks c ON c.chunk_id = v.chunk_id
                  JOIN documents d ON d.doc_id = c.doc_id
                  JOIN roots r ON r.root_key = d.root_key
                  WHERE v.model_key = ? AND v.dim = ?
                    AND d.root_key IN ({_placeholders(len(root_keys))})
                  ORDER BY v.chunk_id DESC LIMIT ?"""
        rows: list[VectorRow] = []
        with self._lock:
            cursor = self._connection.execute(sql, (model_key, dim, *root_keys, cap + 1))
            try:
                while True:
                    if expired():
                        return rows, True
                    page = cursor.fetchmany(_VECTOR_FETCH_PAGE)
                    if not page:
                        return rows, False
                    rows.extend(VectorRow(*row) for row in page)
                    if len(rows) > cap:
                        return rows[:cap], True
            finally:
                cursor.close()

    # -- status --------------------------------------------------------------

    def counts(self, model_key: str) -> dict[str, int]:
        with self._lock:
            by_status = dict(
                self._connection.execute(
                    "SELECT status, COUNT(*) FROM documents GROUP BY status"
                ).fetchall()
            )
        counts = {status: int(by_status.get(status, 0)) for status in DOCUMENT_STATUSES}
        counts["roots"] = self._scalar("SELECT COUNT(*) FROM roots")
        counts["documents"] = sum(int(value) for value in by_status.values())
        counts["chunks"] = self._scalar("SELECT COUNT(*) FROM chunks")
        counts["embedded"] = self._scalar(
            "SELECT COUNT(*) FROM vectors WHERE model_key = ?", (model_key,)
        )
        return counts

    def root_counts(self, model_key: str | None = None) -> dict[str, dict[str, Any]]:
        """Per-root document counts; ``unsupported_type`` skips are not counted.

        With ``model_key``, an extracted document whose chunks are not all
        embedded for that model still counts as pending, so a folder reads as
        done only once it is searchable by meaning.
        """
        with self._lock:
            rows = self._connection.execute(
                """SELECT root_key, status, reason, COUNT(*) FROM documents
                   WHERE NOT (status = 'skipped' AND reason IS 'unsupported_type')
                   GROUP BY root_key, status, reason"""
            ).fetchall()
            unembedded = (
                self._connection.execute(
                    """SELECT d.root_key, COUNT(DISTINCT d.doc_id) FROM documents d
                       JOIN chunks c ON c.doc_id = d.doc_id
                       LEFT JOIN vectors v ON v.chunk_id = c.chunk_id AND v.model_key = ?
                       WHERE d.status = 'indexed' AND v.chunk_id IS NULL
                       GROUP BY d.root_key""",
                    (model_key,),
                ).fetchall()
                if model_key is not None
                else []
            )
        result: dict[str, dict[str, Any]] = {}
        for root_key, status, reason, documents in rows:
            entry = result.setdefault(str(root_key), empty_root_counts())
            entry[str(status)] += int(documents)
            entry["documents"] += int(documents)
            if status == "skipped" and reason:
                reasons = entry["skipped_reasons"]
                reasons[str(reason)] = reasons.get(str(reason), 0) + int(documents)
        for root_key, waiting in unembedded:
            root_entry = result.get(str(root_key))
            if root_entry is not None:
                moved = min(int(waiting), root_entry["indexed"])
                root_entry["indexed"] -= moved
                root_entry["pending"] += moved
        return result

    def model_keys(self) -> dict[str, int]:
        with self._lock:
            rows = self._connection.execute(
                "SELECT model_key, COUNT(*) FROM vectors GROUP BY model_key"
            ).fetchall()
        return {str(key): int(count) for key, count in rows}

    def count_skipped_for_cap(self) -> int:
        return self._scalar(
            "SELECT COUNT(*) FROM documents WHERE status = 'skipped' AND reason = 'cap_reached'"
        )
