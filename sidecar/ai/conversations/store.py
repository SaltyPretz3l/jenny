"""SQLite store for the conversation index (sessions, messages, FTS5, vectors).

A derived cache with the semantic catalog store's conventions: an unreadable
file is renamed aside and rebuilt, a newer schema is refused
(``ConversationIndexError``), every write runs in one ``BEGIN IMMEDIATE``
transaction under one RLock, and caps refuse additions instead of evicting.
Message text never reaches a log.
"""

from __future__ import annotations

import logging
import sqlite3
import threading
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from sidecar.ai.semantic.vectors import pack_vector

logger = logging.getLogger(__name__)

CONVERSATION_INDEX_SCHEMA_VERSION = 1
MAX_SESSIONS = 5_000
MAX_MESSAGES_PER_SESSION = 500
MAX_TOTAL_MESSAGES = 300_000
MAX_TEXT_CHARS = 2_000
MAX_TITLE_CHARS = 200
MAX_ID_CHARS = 128
MAX_TIMESTAMP_CHARS = 64

_SCHEMA = (
    "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    """CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY, project_id TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL,
        fingerprint TEXT NOT NULL, indexed_at TEXT NOT NULL)""",
    # AUTOINCREMENT: a replaced message never reuses a rowid, so a vector
    # computed for old text can never attach to a newer message.
    """CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
        message_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('user','assistant')),
        created_at TEXT NOT NULL DEFAULT '', text TEXT NOT NULL,
        UNIQUE(session_id, message_id))""",
    "CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id)",
    """CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        text, content='messages', content_rowid='id',
        tokenize='unicode61 remove_diacritics 2')""",
    """CREATE TRIGGER IF NOT EXISTS messages_fts_insert AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
    END""",
    """CREATE TRIGGER IF NOT EXISTS messages_fts_delete AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
    END""",
    """CREATE TRIGGER IF NOT EXISTS messages_fts_update AFTER UPDATE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
        INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
    END""",
    """CREATE TABLE IF NOT EXISTS message_vectors (
        message_rowid INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
        model_key TEXT NOT NULL, dim INTEGER NOT NULL, norm REAL NOT NULL,
        blob BLOB NOT NULL)""",
    "CREATE INDEX IF NOT EXISTS idx_message_vectors_model ON message_vectors(model_key)",
)


class ConversationIndexError(RuntimeError):
    """Raised when the index cannot be used (answered as ``index_unavailable``)."""


@dataclass(frozen=True)
class MessageInput:
    message_id: str
    role: str
    created_at: str
    text: str


@dataclass(frozen=True)
class SessionInput:
    session_id: str
    project_id: str
    title: str
    updated_at: str
    fingerprint: str
    messages: tuple[MessageInput, ...]


@dataclass(frozen=True)
class MessageRow:
    """One indexed message with its session title (search result material)."""

    rowid: int
    session_id: str
    title: str
    message_id: str
    role: str
    created_at: str
    text: str


@dataclass(frozen=True)
class EmbeddableMessage:
    rowid: int
    text: str
    title: str


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _placeholders(count: int) -> str:
    return ",".join("?" for _ in range(count))


def _scope_sql(project_id: str | None, exclude: Sequence[str]) -> str:
    """The scope filter; ``project_id=None`` spans every project (the primary chat)."""
    project = "" if project_id is None else " AND s.project_id = ?"
    excluded = f" AND s.session_id NOT IN ({_placeholders(len(exclude))})" if exclude else ""
    return project + excluded


def _scope_params(project_id: str | None, exclude: Sequence[str]) -> tuple[str, ...]:
    return (*(() if project_id is None else (project_id,)), *exclude)


class ConversationStore:
    """Bounded SQLite conversation index; safe to share across worker threads."""

    def __init__(self, db_path: Path) -> None:
        self._db_path = Path(db_path)
        self._lock = threading.RLock()
        self._closed = False
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
            raise ConversationIndexError(
                f"conversation index unavailable ({type(error).__name__})"
            ) from error

    # -- lifecycle -----------------------------------------------------------

    def _open_and_migrate(self) -> sqlite3.Connection:
        connection = sqlite3.connect(
            str(self._db_path), timeout=5.0, check_same_thread=False, isolation_level=None
        )
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

    @staticmethod
    def _read_version(connection: sqlite3.Connection) -> int:
        row = connection.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'"
        ).fetchone()
        if row is None:
            return 0
        value = connection.execute("SELECT value FROM meta WHERE key = 'schema_version'").fetchone()
        try:
            return int(value[0]) if value else 0
        except (TypeError, ValueError):
            return 0

    def _migrate(self, connection: sqlite3.Connection) -> None:
        if self._read_version(connection) > CONVERSATION_INDEX_SCHEMA_VERSION:
            raise ConversationIndexError("conversation index schema is newer than this app")
        connection.execute("BEGIN IMMEDIATE")
        try:
            for statement in _SCHEMA:
                connection.execute(statement)
            connection.execute(
                "INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)",
                (str(CONVERSATION_INDEX_SCHEMA_VERSION),),
            )
            connection.execute("COMMIT")
        except BaseException:
            connection.execute("ROLLBACK")
            raise

    def _set_aside_corrupt_file(self, error: sqlite3.DatabaseError) -> None:
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
        for suffix in ("", "-wal", "-shm"):
            source = Path(f"{self._db_path}{suffix}")
            if source.exists():
                source.replace(Path(f"{self._db_path}.corrupt-{stamp}{suffix}"))
        logger.warning(
            "conversation index was unreadable and is rebuilt from scratch",
            extra={"error_type": type(error).__name__, "set_aside_suffix": f".corrupt-{stamp}"},
        )

    def close(self) -> None:
        """Close the connection (idempotent) so Electron can move or delete the files."""
        with self._lock:
            if self._closed:
                return
            self._closed = True
            self._connection.close()

    @property
    def closed(self) -> bool:
        return self._closed

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
                self._connection.execute("COMMIT")
            except BaseException:
                self._connection.execute("ROLLBACK")
                raise

    def _scalar(self, sql: str, params: Sequence[object] = ()) -> int:
        with self._lock:
            row = self._connection.execute(sql, tuple(params)).fetchone()
        return int(row[0]) if row and row[0] is not None else 0

    # -- sessions ------------------------------------------------------------

    def index_state(self) -> dict[str, Any]:
        """Known sessions (by id, at most ``MAX_SESSIONS``) with their fingerprints."""
        with self._lock:
            rows = self._connection.execute(
                "SELECT session_id, fingerprint FROM sessions ORDER BY session_id LIMIT ?",
                (MAX_SESSIONS,),
            ).fetchall()
            return {
                "sessions": [{"session_id": sid, "fingerprint": fp} for sid, fp in rows],
                "count": self._scalar("SELECT COUNT(*) FROM sessions"),
                "message_count": self._scalar("SELECT COUNT(*) FROM messages"),
                "vector_count": self._scalar("SELECT COUNT(*) FROM message_vectors"),
            }

    def replace_session(self, session: SessionInput) -> int | None:
        """Atomically swap one session's rows; ``None`` when a cap refuses it.

        Blank messages are skipped. Vectors of the old rows go with them
        (cascade); a failure rolls back and leaves the old rows in place.
        """
        rows = [
            (session.session_id, message.message_id, ordinal, message.role,
             message.created_at, message.text)
            for ordinal, message in enumerate(session.messages)
            if message.text.strip()
        ]
        with self._write() as connection:
            existing = connection.execute(
                "SELECT COUNT(*) FROM messages WHERE session_id = ?", (session.session_id,)
            ).fetchone()[0]
            known = connection.execute(
                "SELECT 1 FROM sessions WHERE session_id = ?", (session.session_id,)
            ).fetchone()
            if known is None and (
                connection.execute("SELECT COUNT(*) FROM sessions").fetchone()[0] >= MAX_SESSIONS
            ):
                return None
            total = connection.execute("SELECT COUNT(*) FROM messages").fetchone()[0]
            if total - int(existing) + len(rows) > MAX_TOTAL_MESSAGES:
                return None
            connection.execute("DELETE FROM messages WHERE session_id = ?", (session.session_id,))
            connection.execute(
                "INSERT OR REPLACE INTO sessions (session_id, project_id, title, updated_at,"
                " fingerprint, indexed_at) VALUES (?, ?, ?, ?, ?, ?)",
                (session.session_id, session.project_id, session.title, session.updated_at,
                 session.fingerprint, _utc_now()),
            )
            connection.executemany(
                "INSERT INTO messages (session_id, message_id, ordinal, role, created_at, text)"
                " VALUES (?, ?, ?, ?, ?, ?)",
                rows,
            )
        return len(rows)

    def purge(self, session_ids: Sequence[str]) -> int:
        """Delete the given sessions (messages first, so the FTS triggers fire)."""
        ids = list(dict.fromkeys(session_ids))
        if not ids:
            return 0
        marks = _placeholders(len(ids))
        with self._write() as connection:
            connection.execute(f"DELETE FROM messages WHERE session_id IN ({marks})", ids)
            return int(connection.execute(
                f"DELETE FROM sessions WHERE session_id IN ({marks})", ids
            ).rowcount)

    def purge_all(self) -> int:
        """Delete every session, then VACUUM so the freed pages leave the disk."""
        with self._lock:
            with self._write() as connection:
                connection.execute("DELETE FROM messages")
                removed = int(connection.execute("DELETE FROM sessions").rowcount)
            self._connection.execute("VACUUM")
        return removed

    # -- search reads --------------------------------------------------------

    def lexical_rows(
        self, match: str, project_id: str | None, exclude: Sequence[str], *, cap: int
    ) -> list[tuple[MessageRow, str, float]]:
        """``(row, snippet, bm25)`` best first for an FTS5 ``match``, at most ``cap`` rows.

        The rows carry no message text (``text`` is empty): the snippet is the
        part a caller shows.
        """
        sql = (
            "SELECT m.id, m.session_id, s.title, m.message_id, m.role, m.created_at, '',"
            " snippet(messages_fts, 0, '', '', '…', 24), bm25(messages_fts)"
            " FROM messages_fts JOIN messages m ON m.id = messages_fts.rowid"
            " JOIN sessions s ON s.session_id = m.session_id"
            f" WHERE messages_fts MATCH ?{_scope_sql(project_id, exclude)}"
            " ORDER BY bm25(messages_fts), m.id DESC LIMIT ?"
        )
        with self._lock:
            rows = self._connection.execute(
                sql, (match, *_scope_params(project_id, exclude), int(cap))
            ).fetchall()
        return [(MessageRow(*row[:7]), str(row[7]), float(row[8])) for row in rows]

    def vector_rows(
        self, model_key: str, dim: int, project_id: str | None, exclude: Sequence[str], *,
        cap: int,
    ) -> list[tuple[int, bytes, float]]:
        """Newest-first ``(message rowid, blob, norm)`` in scope, at most ``cap`` rows."""
        sql = (
            "SELECT v.message_rowid, v.blob, v.norm FROM message_vectors v"
            " JOIN messages m ON m.id = v.message_rowid"
            " JOIN sessions s ON s.session_id = m.session_id"
            f" WHERE v.model_key = ? AND v.dim = ?{_scope_sql(project_id, exclude)}"
            " ORDER BY v.message_rowid DESC LIMIT ?"
        )
        with self._lock:
            rows = self._connection.execute(
                sql, (model_key, dim, *_scope_params(project_id, exclude), int(cap))
            ).fetchall()
        return [(int(rowid), bytes(blob), float(norm)) for rowid, blob, norm in rows]

    def message_rows(self, rowids: Sequence[int]) -> dict[int, MessageRow]:
        if not rowids:
            return {}
        with self._lock:
            rows = self._connection.execute(
                "SELECT m.id, m.session_id, s.title, m.message_id, m.role, m.created_at, m.text"
                " FROM messages m JOIN sessions s ON s.session_id = m.session_id"
                f" WHERE m.id IN ({_placeholders(len(rowids))})",
                tuple(rowids),
            ).fetchall()
        return {int(row[0]): MessageRow(*row) for row in rows}

    # -- vectors -------------------------------------------------------------

    def messages_missing_vectors(self, model_key: str, limit: int) -> list[EmbeddableMessage]:
        with self._lock:
            rows = self._connection.execute(
                "SELECT m.id, m.text, s.title FROM messages m"
                " JOIN sessions s ON s.session_id = m.session_id"
                " WHERE NOT EXISTS (SELECT 1 FROM message_vectors v"
                "  WHERE v.message_rowid = m.id AND v.model_key = ?)"
                " ORDER BY m.id ASC LIMIT ?",
                (model_key, int(limit)),
            ).fetchall()
        return [EmbeddableMessage(int(rowid), str(text), str(title)) for rowid, text, title in rows]

    def count_missing_vectors(self, model_key: str | None) -> int:
        """Messages without a vector for ``model_key`` (``None``: without any vector)."""
        if model_key is None:
            return self._scalar(
                "SELECT COUNT(*) FROM messages m WHERE NOT EXISTS ("
                " SELECT 1 FROM message_vectors v WHERE v.message_rowid = m.id)"
            )
        return self._scalar(
            "SELECT COUNT(*) FROM messages m WHERE NOT EXISTS ("
            " SELECT 1 FROM message_vectors v WHERE v.message_rowid = m.id AND v.model_key = ?)",
            (model_key,),
        )

    def store_vectors(self, model_key: str, rows: Sequence[tuple[int, list[float]]]) -> int:
        """Persist vectors; a message replaced meanwhile (rowid gone) is skipped."""
        stored = 0
        with self._write() as connection:
            for rowid, vector in rows:
                blob, dim, norm = pack_vector(vector)
                stored += connection.execute(
                    "INSERT OR REPLACE INTO message_vectors"
                    " (message_rowid, model_key, dim, norm, blob) SELECT ?, ?, ?, ?, ?"
                    " WHERE EXISTS (SELECT 1 FROM messages WHERE id = ?)",
                    (rowid, model_key, dim, norm, blob, rowid),
                ).rowcount
        return stored

    def drop_other_models(self, model_key: str) -> int:
        with self._write() as connection:
            return int(connection.execute(
                "DELETE FROM message_vectors WHERE model_key != ?", (model_key,)
            ).rowcount)

    def vector_model_keys(self) -> dict[str, int]:
        with self._lock:
            rows = self._connection.execute(
                "SELECT model_key, COUNT(*) FROM message_vectors GROUP BY model_key"
            ).fetchall()
        return {str(key): int(count) for key, count in rows}

