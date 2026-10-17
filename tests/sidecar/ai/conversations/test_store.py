"""Conversation index store: schema, refusal, corrupt set-aside, atomic replace, purge, caps."""

from __future__ import annotations

import sqlite3
from contextlib import closing
from dataclasses import replace
from pathlib import Path

import pytest

from sidecar.ai.conversations import store as store_module
from sidecar.ai.conversations.store import (
    CONVERSATION_INDEX_SCHEMA_VERSION,
    ConversationIndexError,
    ConversationStore,
    MessageInput,
)
from tests.sidecar.ai.conversations.helpers import session


def _fts_rowids(db: ConversationStore, word: str) -> list[int]:
    with db._lock:
        rows = db._connection.execute(
            "SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?", (word,)
        ).fetchall()
    return sorted(int(row[0]) for row in rows)


def test_schema_is_created_and_reopened(tmp_path: Path) -> None:
    path = tmp_path / "conversation-index.db"
    first = ConversationStore(path)
    assert first.schema_version == CONVERSATION_INDEX_SCHEMA_VERSION
    assert first.replace_session(session("s1", ["hello there", "general kenobi"])) == 2
    first.close()

    reopened = ConversationStore(path)
    try:
        state = reopened.index_state()
        assert state["sessions"] == [{"session_id": "s1", "fingerprint": "fp-1"}]
        assert (state["count"], state["message_count"], state["vector_count"]) == (1, 2, 0)
        with reopened._lock:
            mode = reopened._connection.execute("PRAGMA journal_mode").fetchone()[0]
            keys = reopened._connection.execute("PRAGMA foreign_keys").fetchone()[0]
        assert (str(mode).lower(), keys) == ("wal", 1)
    finally:
        reopened.close()


def test_newer_schema_is_refused_and_left_in_place(tmp_path: Path) -> None:
    path = tmp_path / "conversation-index.db"
    with closing(sqlite3.connect(path)) as connection:
        connection.execute("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        connection.execute("INSERT INTO meta VALUES ('schema_version', '99')")
        connection.commit()

    with pytest.raises(ConversationIndexError, match="newer"):
        ConversationStore(path)

    assert path.exists()
    assert not list(tmp_path.glob("*.corrupt-*"))


def test_corrupt_file_is_renamed_and_recreated(tmp_path: Path) -> None:
    path = tmp_path / "conversation-index.db"
    path.write_bytes(b"this is not a sqlite database at all" * 64)

    db = ConversationStore(path)
    try:
        assert db.schema_version == CONVERSATION_INDEX_SCHEMA_VERSION
        assert db.index_state()["count"] == 0
    finally:
        db.close()
    assert len(list(tmp_path.glob("conversation-index.db.corrupt-*"))) == 1


def test_replace_swaps_rows_and_keeps_fts_in_step(tmp_path: Path) -> None:
    db = ConversationStore(tmp_path / "c.db")
    try:
        db.replace_session(session("s1", ["zebra stripes", "lion mane"]))
        db.store_vectors("model-a", [(rowid, [1.0, 0.0]) for rowid in _fts_rowids(db, "zebra")])
        assert db.index_state()["vector_count"] == 1

        indexed = db.replace_session(session("s1", ["giraffe neck", "   ", "lion"],
                                             fingerprint="fp-2"))

        assert indexed == 2  # the blank message is skipped
        assert _fts_rowids(db, "zebra") == []
        assert len(_fts_rowids(db, "giraffe")) == 1
        state = db.index_state()
        assert state["sessions"] == [{"session_id": "s1", "fingerprint": "fp-2"}]
        assert (state["message_count"], state["vector_count"]) == (2, 0)  # vectors cascade
    finally:
        db.close()


def test_failed_replace_leaves_the_old_rows(tmp_path: Path) -> None:
    db = ConversationStore(tmp_path / "c.db")
    try:
        db.replace_session(session("s1", ["original words"]))
        duplicate = MessageInput("dup", "user", "", "first")
        broken = replace(session("s1", ["new words"], fingerprint="fp-2"),
                         messages=(duplicate, duplicate))

        with pytest.raises(sqlite3.IntegrityError):
            db.replace_session(broken)

        assert db.index_state()["sessions"] == [{"session_id": "s1", "fingerprint": "fp-1"}]
        assert len(_fts_rowids(db, "original")) == 1
        assert _fts_rowids(db, "first") == []
    finally:
        db.close()


def test_purge_by_ids_and_all(tmp_path: Path) -> None:
    db = ConversationStore(tmp_path / "c.db")
    try:
        for name in ("s1", "s2", "s3"):
            db.replace_session(session(name, [f"apple {name}", "banana"]))

        assert db.purge(["s1", "missing"]) == 1
        assert [row["session_id"] for row in db.index_state()["sessions"]] == ["s2", "s3"]
        assert len(_fts_rowids(db, "banana")) == 2

        assert db.purge_all() == 2
        state = db.index_state()
        assert (state["count"], state["message_count"]) == (0, 0)
        assert _fts_rowids(db, "banana") == []
    finally:
        db.close()


def test_session_and_total_caps_refuse_new_rows(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(store_module, "MAX_SESSIONS", 2)
    monkeypatch.setattr(store_module, "MAX_TOTAL_MESSAGES", 5)
    db = ConversationStore(tmp_path / "c.db")
    try:
        assert db.replace_session(session("s1", ["a1", "a2"])) == 2
        assert db.replace_session(session("s2", ["b1", "b2"])) == 2
        assert db.replace_session(session("s3", ["c1"])) is None  # session cap
        assert db.replace_session(session("s2", ["b1", "b2", "b3", "b4"])) is None  # total cap
        assert db.replace_session(session("s2", ["b1", "b2", "b3"])) == 3  # replace fits
        state = db.index_state()
        assert (state["count"], state["message_count"]) == (2, 5)
    finally:
        db.close()


def test_index_state_lists_at_most_the_session_cap(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    db = ConversationStore(tmp_path / "c.db")
    try:
        for name in ("b", "a", "c"):
            db.replace_session(session(name, ["x1"]))
        monkeypatch.setattr(store_module, "MAX_SESSIONS", 2)

        state = db.index_state()

        assert [row["session_id"] for row in state["sessions"]] == ["a", "b"]
        assert state["count"] == 3
    finally:
        db.close()
