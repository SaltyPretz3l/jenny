from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest

from sidecar.ai.memory import store_migrations
from sidecar.ai.memory.contracts import (
    MAX_FAMILY_KEY_CHARS,
    MAX_LESSON_TEXT_CHARS,
    MAX_PROVENANCE_CHARS,
    MAX_QUARANTINE_PAYLOAD_CHARS,
    MAX_SESSION_ID_CHARS,
    MAX_SOURCE_EXCERPT_CHARS,
    MAX_TITLE_CHARS,
    build_content_digest,
    normalize_spaces,
)
from sidecar.ai.memory.store import MemoryStore
from sidecar.ai.memory.store_migrations import (
    SCHEMA_VERSION,
    _execute_schema_script,
    run_migrations,
    v6_schema_script,
)

CREATED_AT = "2026-10-01T00:00:00+00:00"
UPDATED_AT = "2026-10-02T00:00:00+00:00"
CONTENT_LIMITS = {
    "title": MAX_TITLE_CHARS,
    "lesson_text": MAX_LESSON_TEXT_CHARS,
    "source_excerpt": MAX_SOURCE_EXCERPT_CHARS,
    "family_key": MAX_FAMILY_KEY_CHARS,
    "provenance": MAX_PROVENANCE_CHARS,
}


def _create_v6_database(path: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(path)
    connection.row_factory = sqlite3.Row
    _execute_schema_script(connection, v6_schema_script(), version=6)
    assert connection.execute("PRAGMA user_version").fetchone()[0] == 6
    return connection


def _insert_approved(
    connection: sqlite3.Connection, row_id: int, **overrides: object
) -> dict[str, object]:
    values: dict[str, object] = {
        "id": row_id,
        "session_id": "session-1",
        "title": "Tea",
        "lesson_text": f"The user prefers tea {row_id}.",
        "lesson_kind": "preference",
        "confidence": 0.9,
        "source_excerpt": "I prefer tea",
        "content_fingerprint": f"legacy-{row_id}",
        "family_key": "tea",
        "provenance": "user_approved",
        "created_at": CREATED_AT,
        "updated_at": UPDATED_AT,
    }
    values.update(overrides)
    connection.execute(
        """
        INSERT INTO memories (
            id, session_id, title, lesson_text, lesson_kind, confidence,
            source_excerpt, content_fingerprint, family_key, provenance,
            created_at, updated_at
        ) VALUES (
            :id, :session_id, :title, :lesson_text, :lesson_kind, :confidence,
            :source_excerpt, :content_fingerprint, :family_key, :provenance,
            :created_at, :updated_at
        )
        """,
        values,
    )
    return values


def _assert_digest_only(payload: str, original: dict[str, object]) -> None:
    decoded = json.loads(payload)
    assert set(decoded) == {"row_digest", "value_count", "value_types"}
    assert decoded["row_digest"].startswith("sha256:")
    assert decoded["value_count"] == len(original)
    assert len(decoded["value_types"]) == len(original)
    for field in ("title", "lesson_text", "source_excerpt"):
        text = str(original[field])
        if text.strip():
            assert text not in payload


def test_approved_content_survives_v7_limits_and_store_reopens(tmp_path: Path) -> None:
    path = tmp_path / "memory.db"
    connection = _create_v6_database(path)
    original_text = {
        "title": "T" * 150,
        "lesson_text": "L" * 300,
        "source_excerpt": "E" * (MAX_SOURCE_EXCERPT_CHARS + 1),
        "family_key": "F" * (MAX_FAMILY_KEY_CHARS + 1),
        "provenance": "P" * (MAX_PROVENANCE_CHARS + 1),
    }
    try:
        _insert_approved(connection, 7, **original_text)
        short = _insert_approved(connection, 8)
        invalid = _insert_approved(
            connection, 9, confidence=float("inf"), lesson_text="Private invalid lesson"
        )
        connection.commit()

        assert run_migrations(connection) is True
        assert connection.execute("PRAGMA user_version").fetchone()[0] == SCHEMA_VERSION
        rows = {
            row["id"]: dict(row)
            for row in connection.execute("SELECT * FROM memories").fetchall()
        }
        assert set(rows) == {7, 8}
        for field, limit in CONTENT_LIMITS.items():
            assert len(rows[7][field]) == limit
            assert rows[7][field] == original_text[field][:limit]
        assert rows[7]["content_fingerprint"] == build_content_digest(
            "preference", original_text["lesson_text"][:MAX_LESSON_TEXT_CHARS]
        )
        assert rows[7]["created_at"] == CREATED_AT
        assert rows[7]["updated_at"] == UPDATED_AT
        short["content_fingerprint"] = build_content_digest(
            str(short["lesson_kind"]), str(short["lesson_text"])
        )
        assert {field: rows[8][field] for field in short} == short
        quarantine = connection.execute(
            "SELECT source_table, source_row_id, reason_code, raw_payload "
            "FROM memory_quarantine ORDER BY source_row_id"
        ).fetchall()
        assert len(quarantine) == 2
        assert tuple(quarantine[0])[:3] == ("memories", "7", "truncated_v7_row")
        assert json.loads(quarantine[0]["raw_payload"])["preserved"] == {
            field: original_text[field]
            for field in ("title", "lesson_text", "source_excerpt")
        }
        assert tuple(quarantine[1])[:3] == (
            "memories", "9", "invalid_or_duplicate_v7_row"
        )
        _assert_digest_only(quarantine[1]["raw_payload"], invalid)
        assert run_migrations(connection) is False
    finally:
        connection.close()

    store = MemoryStore(path)
    try:
        memories = {memory.id: memory for memory in store.get_all_memories()}
        assert set(memories) == {7, 8}
        assert memories[7].lesson_text == original_text["lesson_text"][:MAX_LESSON_TEXT_CHARS]
        assert memories[7].title == original_text["title"][:MAX_TITLE_CHARS]
        assert memories[8].lesson_text == short["lesson_text"]
    finally:
        store.close()


def test_each_content_field_truncates_after_normalization(tmp_path: Path) -> None:
    connection = _create_v6_database(tmp_path / "memory.db")
    originals = {}
    try:
        for row_id, (field, limit) in enumerate(CONTENT_LIMITS.items(), start=1):
            # Unicode and extra whitespace must survive in the recovery payload.
            originals[row_id] = _insert_approved(
                connection, row_id, **{field: " \t" + "\u00e9" * (limit + 1) + "\n "}
            )
        connection.commit()
        run_migrations(connection)
        rows = connection.execute("SELECT * FROM memories ORDER BY id").fetchall()
        assert len(rows) == len(CONTENT_LIMITS)
        for row, (field, limit) in zip(rows, CONTENT_LIMITS.items(), strict=True):
            original = originals[row["id"]]
            assert row[field] == normalize_spaces(original[field])[:limit]
            payload = connection.execute(
                "SELECT raw_payload FROM memory_quarantine "
                "WHERE source_row_id = ? AND reason_code = 'truncated_v7_row'",
                (str(row["id"]),),
            ).fetchone()[0]
            assert "\u00e9" in payload or field not in ("title", "lesson_text", "source_excerpt")
            assert json.loads(payload)["preserved"] == {
                key: original[key] for key in ("title", "lesson_text", "source_excerpt")
            }
    finally:
        connection.close()


@pytest.mark.parametrize(
    "overrides",
    [
        {"session_id": " "},
        {"session_id": "S" * (MAX_SESSION_ID_CHARS + 1)},
        {"title": " "},
        {"lesson_text": " "},
        {"lesson_kind": " "},
        {"confidence": float("-inf")},
    ],
)
def test_invalid_approved_rows_remain_digest_only(
    tmp_path: Path, overrides: dict[str, object]
) -> None:
    connection = _create_v6_database(tmp_path / "memory.db")
    try:
        original = _insert_approved(
            connection, 1, source_excerpt="Private excerpt", **overrides
        )
        connection.commit()
        run_migrations(connection)
        assert connection.execute("SELECT COUNT(*) FROM memories").fetchone()[0] == 0
        row = connection.execute("SELECT * FROM memory_quarantine").fetchone()
        assert row["reason_code"] == "invalid_or_duplicate_v7_row"
        _assert_digest_only(row["raw_payload"], original)
    finally:
        connection.close()


def test_truncated_digest_collision_keeps_the_original_text_in_quarantine(
    tmp_path: Path,
) -> None:
    connection = _create_v6_database(tmp_path / "memory.db")
    try:
        prefix = "L" * MAX_LESSON_TEXT_CHARS
        _insert_approved(connection, 1, lesson_text=prefix + "private suffix")
        _insert_approved(connection, 2, lesson_text=prefix)
        connection.commit()
        run_migrations(connection)
        assert [row[0] for row in connection.execute("SELECT id FROM memories")] == [2]
        row = connection.execute("SELECT * FROM memory_quarantine").fetchone()
        assert row["reason_code"] == "invalid_or_duplicate_v7_row"
        assert row["source_row_id"] == "1"
        payload = json.loads(row["raw_payload"])
        assert payload["preserved"]["lesson_text"] == prefix + "private suffix"
    finally:
        connection.close()


def test_long_original_text_is_preserved_in_valid_json_parts(tmp_path: Path) -> None:
    connection = _create_v6_database(tmp_path / "memory.db")
    try:
        lesson = ("Long lesson sentence number one. " * 120) + "UNIQUE-SUFFIX-END"
        _insert_approved(connection, 7, lesson_text=lesson)
        connection.commit()
        run_migrations(connection)
        rows = connection.execute(
            "SELECT reason_code, raw_payload FROM memory_quarantine ORDER BY id"
        ).fetchall()
        payloads = [json.loads(row["raw_payload"]) for row in rows]
        assert rows[0]["reason_code"] == "truncated_v7_row"
        assert all(row["reason_code"] == "truncated_v7_row_part" for row in rows[1:])
        assert all(len(row["raw_payload"]) <= MAX_QUARANTINE_PAYLOAD_CHARS for row in rows)
        lesson_parts = sorted(
            (part for part in payloads[1:] if part["field"] == "lesson_text"),
            key=lambda part: part["part"],
        )
        assert payloads[0]["preserved_parts"]["lesson_text"] == {
            "parts": len(lesson_parts), "complete": True,
        }
        assert len(lesson_parts) > 1
        assert "".join(part["text"] for part in lesson_parts) == lesson
        stored = connection.execute("SELECT lesson_text FROM memories WHERE id = 7").fetchone()
        assert stored[0] == normalize_spaces(lesson)[:MAX_LESSON_TEXT_CHARS]
    finally:
        connection.close()


def test_overlong_pending_candidate_is_still_dropped(tmp_path: Path) -> None:
    connection = _create_v6_database(tmp_path / "memory.db")
    try:
        lesson = "Pending private proposal " * 20
        connection.execute(
            """
            INSERT INTO pending_memory_candidates (
                session_id, source_request_id, title, lesson_text, lesson_kind,
                confidence, content_fingerprint, created_at, updated_at
            ) VALUES ('session-1', 'request-1', 'Proposal', ?, 'preference',
                0.9, 'legacy-pending', ?, ?)
            """,
            (lesson, CREATED_AT, UPDATED_AT),
        )
        connection.commit()
        run_migrations(connection)
        assert connection.execute(
            "SELECT COUNT(*) FROM pending_memory_candidates"
        ).fetchone()[0] == 0
        row = connection.execute("SELECT * FROM memory_quarantine").fetchone()
        assert row["source_table"] == "pending_memory_candidates"
        assert row["reason_code"] == "invalid_or_duplicate_v7_row"
        assert "preserved" not in json.loads(row["raw_payload"])
        assert lesson not in row["raw_payload"]
    finally:
        connection.close()


def test_approved_checkpoint_rolls_back_content_and_quarantine(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    connection = _create_v6_database(tmp_path / "memory.db")
    try:
        original = _insert_approved(connection, 1, lesson_text="L" * 300)
        connection.commit()

        def fail_at_approved_rows(stage: str) -> None:
            if stage == "approved_rows":
                raise RuntimeError("injected approved_rows failure")

        monkeypatch.setattr(store_migrations, "_migration_checkpoint", fail_at_approved_rows)
        with pytest.raises(RuntimeError, match="injected approved_rows failure"):
            run_migrations(connection)
        assert connection.in_transaction is False
        assert connection.execute("PRAGMA user_version").fetchone()[0] == 6
        assert dict(connection.execute("SELECT * FROM memories").fetchone()) == original
        assert connection.execute(
            "SELECT name FROM sqlite_master WHERE name IN ('memory_quarantine', 'memories_v7')"
        ).fetchall() == []
    finally:
        connection.close()
