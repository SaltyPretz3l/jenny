from __future__ import annotations

import sqlite3
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import pytest

import sidecar.ai.memory.store as memory_store_module
import sidecar.ai.memory.store_approved as memory_store_approved_module
from sidecar.ai.error_codes import CMP_MEMORY_CAPACITY_EXCEEDED
from sidecar.ai.memory.contracts import (
    build_content_digest,
)
from sidecar.ai.memory.store import MemoryStore
from sidecar.ai.memory.store_shared import (
    MAX_ALL_MEMORIES_LIMIT,
    MEMORY_MAINTENANCE_SECONDS,
)
from sidecar.exceptions import MemoryStoreError
from tests._concurrency import join_all_or_fail


class _CommitFailOnceConnection:
    def __init__(self, connection: sqlite3.Connection) -> None:
        self._connection = connection
        self.fail_next_commit = True
        self.rollback_count = 0

    def __getattr__(self, name: str) -> Any:
        return getattr(self._connection, name)

    def commit(self) -> None:
        if self.fail_next_commit:
            self.fail_next_commit = False
            raise sqlite3.OperationalError("injected commit failure")
        self._connection.commit()

    def rollback(self) -> None:
        self.rollback_count += 1
        self._connection.rollback()


def _insert_retention_rows(store: MemoryStore, *, old_at: str, fresh_at: str) -> None:
    store._connection.executemany(  # noqa: SLF001
        """
        INSERT INTO memory_extraction_runs (
            session_id, request_id, status, attempt_count, started_at,
            completed_at, failure_code, created_at, updated_at
        ) VALUES (?, ?, 'completed', 1, ?, ?, '', ?, ?)
        """,
        (
            ("session-old", "run-old", old_at, old_at, old_at, old_at),
            ("session-fresh", "run-fresh", fresh_at, fresh_at, fresh_at, fresh_at),
        ),
    )
    store._connection.executemany(  # noqa: SLF001
        """
        INSERT INTO pending_memory_candidates (
            session_id, source_request_id, title, lesson_text, lesson_kind,
            confidence, source_excerpt, content_fingerprint, family_key,
            category, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            (
                "session-old",
                "request-old",
                "old",
                "old",
                "preference",
                0.5,
                "",
                build_content_digest("preference", "old"),
                "",
                "",
                old_at,
                old_at,
            ),
            (
                "session-fresh",
                "request-fresh",
                "fresh",
                "fresh",
                "preference",
                0.5,
                "",
                build_content_digest("preference", "fresh"),
                "",
                "",
                fresh_at,
                fresh_at,
            ),
        ),
    )
    store._connection.executemany(  # noqa: SLF001
        """
        INSERT INTO memories (
            session_id, title, lesson_text, lesson_kind, confidence,
            source_excerpt, content_fingerprint, family_key, provenance,
            created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            (
                "session-old",
                "old",
                "old",
                "preference",
                0.5,
                "",
                build_content_digest("preference", "approved old"),
                "",
                "unknown_legacy",
                old_at,
                old_at,
            ),
            (
                "session-fresh",
                "fresh",
                "fresh",
                "preference",
                0.5,
                "",
                build_content_digest("preference", "approved fresh"),
                "",
                "unknown_legacy",
                fresh_at,
                fresh_at,
            ),
        ),
    )
    store._connection.commit()  # noqa: SLF001


def _run_maintenance_now(
    store: MemoryStore,
    *,
    max_age_days: int,
    max_rows_per_table: int,
    max_db_bytes: int,
) -> dict[str, object]:
    with store._lock:  # noqa: SLF001
        report = store._perform_maintenance(  # noqa: SLF001
            max_age_days=max_age_days,
            max_rows_per_table=max_rows_per_table,
            max_db_bytes=max_db_bytes,
            apply_age_retention=True,
        )
        store._successful_mutations = 0  # noqa: SLF001
        store._last_maintenance_monotonic = time.monotonic()  # noqa: SLF001
        return report


def test_write_transaction_rolls_back_commit_failure_and_allows_next_write(
    tmp_path: Path,
) -> None:
    store = MemoryStore(tmp_path / "memory.db")
    try:
        timestamp = datetime.now(timezone.utc).isoformat()
        store._connection.execute(  # noqa: SLF001
            """
            INSERT INTO pending_memory_candidates (
                session_id, source_request_id, title, lesson_text, lesson_kind,
                confidence, source_excerpt, content_fingerprint, family_key,
                category, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', '', ?, ?)
            """,
            (
                "session-1",
                "request-1",
                "Tea",
                "The user likes tea.",
                "preference",
                0.8,
                "tea",
                build_content_digest("preference", "The user likes tea."),
                timestamp,
                timestamp,
            ),
        )
        store._connection.commit()  # noqa: SLF001
        proxy = _CommitFailOnceConnection(store._connection)  # noqa: SLF001
        store._connection = proxy  # type: ignore[assignment]  # noqa: SLF001

        with pytest.raises(MemoryStoreError, match="failed to save memory"):
            store.save_memory(
                session_id="session-1",
                title="Tea",
                lesson_text="The user likes tea.",
                lesson_kind="preference",
                confidence=0.8,
                source_excerpt="tea",
            )

        assert proxy.rollback_count == 1
        assert proxy.execute("SELECT COUNT(*) FROM memories").fetchone()[0] == 0
        assert proxy.execute("SELECT COUNT(*) FROM pending_memory_candidates").fetchone()[0] == 1

        memory, created = store.save_memory(
            session_id="session-1",
            title="Tea",
            lesson_text="The user likes tea.",
            lesson_kind="preference",
            confidence=0.8,
            source_excerpt="tea",
        )
        assert created is True
        assert memory.title == "Tea"
        assert proxy.execute("SELECT COUNT(*) FROM pending_memory_candidates").fetchone()[0] == 0
    finally:
        store.close()
def test_maintenance_removes_only_old_derived_rows_and_keeps_approved(
    tmp_path: Path,
) -> None:
    store = MemoryStore(tmp_path / "memory.db")
    try:
        now = datetime.now(timezone.utc)
        _insert_retention_rows(
            store,
            old_at=(now - timedelta(days=181)).isoformat(),
            fresh_at=now.isoformat(),
        )

        report = _run_maintenance_now(
            store,
            max_age_days=180,
            max_rows_per_table=10_000,
            max_db_bytes=1 << 40,
        )

        assert report["removed"] == {
            "memory_extraction_runs": 1,
            "pending_memory_candidates": 1,
        }
        for table in report["removed"]:
            assert store._connection.execute(  # noqa: SLF001
                f"SELECT COUNT(*) FROM {table}"
            ).fetchone()[0] == 1
        assert store._connection.execute(  # noqa: SLF001
            "SELECT COUNT(*) FROM memories"
        ).fetchone()[0] == 2
    finally:
        store.close()
def test_maintenance_count_cap_evicts_oldest_rows_first(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "memory.db")
    try:
        store._connection.executemany(  # noqa: SLF001
            """
            INSERT INTO memory_extraction_runs (
                session_id, request_id, status, attempt_count, started_at,
                completed_at, failure_code, created_at, updated_at
            ) VALUES ('session', ?, 'completed', 1, ?, ?, '', ?, ?)
            """,
            (
                ("oldest", *("2026-01-01T00:00:00+00:00",) * 4),
                ("middle", *("2026-01-02T00:00:00+00:00",) * 4),
                ("newest", *("2026-01-03T00:00:00+00:00",) * 4),
            ),
        )
        store._connection.commit()  # noqa: SLF001

        report = _run_maintenance_now(
            store,
            max_age_days=10_000,
            max_rows_per_table=2,
            max_db_bytes=1 << 40,
        )

        assert report["removed"]["memory_extraction_runs"] == 1
        rows = store._connection.execute(  # noqa: SLF001
            "SELECT request_id FROM memory_extraction_runs ORDER BY created_at ASC"
        ).fetchall()
        assert rows == [("middle",), ("newest",)]
    finally:
        store.close()


def test_interrupted_maintenance_rolls_back_and_next_sweep_succeeds(
    tmp_path: Path,
) -> None:
    store = MemoryStore(tmp_path / "memory.db")
    try:
        old_at = (datetime.now(timezone.utc) - timedelta(days=181)).isoformat()
        store._connection.execute(  # noqa: SLF001
            """
            INSERT INTO memory_extraction_runs (
                session_id, request_id, status, attempt_count, started_at,
                completed_at, failure_code, created_at, updated_at
            ) VALUES ('session', ?, 'completed', 1, ?, ?, '', ?, ?)
            """,
            ("old", old_at, old_at, old_at, old_at),
        )
        store._connection.commit()  # noqa: SLF001
        proxy = _CommitFailOnceConnection(store._connection)  # noqa: SLF001
        store._connection = proxy  # type: ignore[assignment]  # noqa: SLF001

        with pytest.raises(MemoryStoreError, match="failed to maintain memory database"):
            _run_maintenance_now(
                store,
                max_age_days=180,
                max_rows_per_table=10_000,
                max_db_bytes=1 << 40,
            )
        assert proxy.rollback_count == 1
        assert proxy.execute("SELECT COUNT(*) FROM memory_extraction_runs").fetchone()[0] == 1

        report = _run_maintenance_now(
            store,
            max_age_days=180,
            max_rows_per_table=10_000,
            max_db_bytes=1 << 40,
        )
        assert report["removed"]["memory_extraction_runs"] == 1
        assert proxy.execute("SELECT COUNT(*) FROM memory_extraction_runs").fetchone()[0] == 0
    finally:
        store.close()


def test_byte_ceiling_evicts_ephemeral_tables_before_approved_memories(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = MemoryStore(tmp_path / "memory.db")
    try:
        now = datetime.now(timezone.utc).isoformat()
        _insert_retention_rows(store, old_at=now, fresh_at=now)

        def _simulated_live_bytes() -> int:
            ephemeral_rows = sum(
                int(
                    store._connection.execute(  # noqa: SLF001
                        f"SELECT COUNT(*) FROM {table}"
                    ).fetchone()[0]
                )
                for table in (
                    "memory_extraction_runs",
                    "pending_memory_candidates",
                )
            )
            return 2 if ephemeral_rows else 0

        monkeypatch.setattr(store, "_database_physical_bytes", _simulated_live_bytes)
        report = _run_maintenance_now(
            store,
            max_age_days=10_000,
            max_rows_per_table=10_000,
            max_db_bytes=1,
        )

        assert report["removed"]["memory_extraction_runs"] == 2
        assert report["removed"]["pending_memory_candidates"] == 2
        assert "memories" not in report["removed"]
        assert store._connection.execute(  # noqa: SLF001
            "SELECT COUNT(*) FROM memories"
        ).fetchone()[0] == 2
    finally:
        store.close()


def test_maintenance_runs_at_startup_mutation_count_and_elapsed_operation(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[dict[str, object]] = []
    original = MemoryStore._perform_maintenance

    def _spy(self: MemoryStore, **kwargs: object) -> dict[str, object]:
        calls.append(dict(kwargs))
        return original(self, **kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr(MemoryStore, "_perform_maintenance", _spy)
    store = MemoryStore(tmp_path / "memory.db")
    try:
        assert len(calls) == 1
        assert calls[0]["apply_age_retention"] is False

        store._successful_mutations = 99  # noqa: SLF001
        store.save_memory(
            session_id="session",
            title="Tea",
            lesson_text="Tea",
            lesson_kind="preference",
            confidence=0.8,
            source_excerpt="tea",
        )
        assert len(calls) == 2

        store._last_maintenance_monotonic -= MEMORY_MAINTENANCE_SECONDS + 1  # noqa: SLF001
        store.get_all_memories()
        assert len(calls) == 2
        store.save_memory(
            session_id="session",
            title="Coffee",
            lesson_text="Coffee",
            lesson_kind="preference",
            confidence=0.8,
            source_excerpt="coffee",
        )
        assert len(calls) == 3
    finally:
        store.close()


def test_recall_scores_at_most_bounded_sql_candidates(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = MemoryStore(tmp_path / "memory.db")
    try:
        now = datetime.now(timezone.utc).isoformat()
        rows = [
            (
                f"session-{index}",
                f"Tea {index}",
                "The user prefers green tea.",
                "preference",
                0.8,
                "tea",
                build_content_digest("preference", f"tea-{index}"),
                "",
                "unknown_legacy",
                now,
                now,
            )
            for index in range(MAX_ALL_MEMORIES_LIMIT + 100)
        ]
        store._connection.executemany(  # noqa: SLF001
            """
            INSERT INTO memories (
                session_id, title, lesson_text, lesson_kind, confidence,
                source_excerpt, content_fingerprint, family_key, provenance,
                created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            rows,
        )
        store._connection.commit()  # noqa: SLF001
        scored = 0

        def _score(*_args: object, **_kwargs: object) -> float:
            nonlocal scored
            scored += 1
            return 0.0

        monkeypatch.setattr(MemoryStore, "_score_memory_row", _score)
        # This test validates the SQL candidate ceiling, not the production
        # 100 ms recall deadline. Keep CPU contention from expiring the deadline
        # before the first instrumented score call under the full xdist gate.
        monkeypatch.setattr(memory_store_approved_module, "RECALL_DEADLINE_SECONDS", 5.0)
        store._recall_index_available = False  # noqa: SLF001
        assert store.recall_memories("green tea") == []
        assert 0 < scored <= MAX_ALL_MEMORIES_LIMIT
        if scored < MAX_ALL_MEMORIES_LIMIT:
            assert store._last_recall_partial is True  # noqa: SLF001
        assert len(
            store._candidate_rows_for_recall(  # noqa: SLF001
                normalized_query="green tea",
                query_tokens={"green", "tea"},
            )
        ) == MAX_ALL_MEMORIES_LIMIT

        plan = store._connection.execute(  # noqa: SLF001
            "EXPLAIN QUERY PLAN SELECT id FROM memories "
            "ORDER BY updated_at DESC, id DESC LIMIT ?",
            (MAX_ALL_MEMORIES_LIMIT,),
        ).fetchall()
        assert any("idx_memories_updated_id" in str(row) for row in plan)
    finally:
        store.close()


def test_capacity_pressure_rejects_growth_but_keeps_existing_approved(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = MemoryStore(tmp_path / "memory.db")
    try:
        first, _ = store.save_memory(
            session_id="session",
            title="Tea",
            lesson_text="The user prefers tea.",
            lesson_kind="preference",
            confidence=0.9,
            source_excerpt="tea",
        )
        monkeypatch.setattr(store, "_database_physical_bytes", lambda: 1 << 40)

        with pytest.raises(MemoryStoreError) as exc_info:
            store.save_memory(
                session_id="session",
                title="Coffee",
                lesson_text="The user prefers coffee.",
                lesson_kind="preference",
                confidence=0.9,
                source_excerpt="coffee",
            )
        assert exc_info.value.code == CMP_MEMORY_CAPACITY_EXCEEDED
        assert exc_info.value.retryable is True
        with pytest.raises(MemoryStoreError) as update_error:
            store.update_memory(
                memory_id=first.id,
                title="A much longer tea preference",
                lesson_text="The user strongly prefers tea every afternoon.",
            )
        assert update_error.value.code == CMP_MEMORY_CAPACITY_EXCEEDED
        assert [memory.id for memory in store.get_all_memories()] == [first.id]
        assert store.delete_memory(first.id) is True
    finally:
        store.close()


def test_capacity_pressure_runs_derived_cleanup_before_rejecting_growth(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = MemoryStore(tmp_path / "memory.db")
    pressured = True
    cleanup_calls = 0

    def _physical_bytes() -> int:
        return (1 << 40) if pressured else 1024

    def _cleanup(**_kwargs: object) -> dict[str, object]:
        nonlocal cleanup_calls, pressured
        cleanup_calls += 1
        pressured = False
        return {"removed": {"entries": 1}, "physical_bytes": 1024}

    try:
        monkeypatch.setattr(store, "_database_physical_bytes", _physical_bytes)
        monkeypatch.setattr(store, "_perform_maintenance", _cleanup)
        saved, created = store.save_memory(
            session_id="session",
            title="Tea",
            lesson_text="The user prefers tea.",
            lesson_kind="preference",
            confidence=0.9,
            source_excerpt="tea",
        )

        assert created is True
        assert saved.title == "Tea"
        assert cleanup_calls == 1
    finally:
        store.close()


def test_forget_suppression_is_cleared_by_explicit_save(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "memory.db")
    try:
        memory, _ = store.save_memory(
            session_id="session",
            title="Tea",
            lesson_text="The user prefers tea.",
            lesson_kind="preference",
            confidence=0.9,
            source_excerpt="tea",
        )
        assert store.delete_memory(memory.id) is True
        assert store.is_memory_suppressed(memory.content_fingerprint) is True

        restored, created = store.save_memory(
            session_id="session",
            title="Tea",
            lesson_text="The user prefers tea.",
            lesson_kind="preference",
            confidence=0.9,
            source_excerpt="tea",
        )
        assert created is True
        assert store.is_memory_suppressed(restored.content_fingerprint) is False
    finally:
        store.close()


def test_malformed_row_is_quarantined_without_hiding_valid_rows(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "memory.db")
    try:
        valid, _ = store.save_memory(
            session_id="session",
            title="Tea",
            lesson_text="The user prefers tea.",
            lesson_kind="preference",
            confidence=0.9,
            source_excerpt="tea",
        )
        store._connection.execute("PRAGMA ignore_check_constraints=ON")  # noqa: SLF001
        store._connection.execute(  # noqa: SLF001
            """
            INSERT INTO memories (
                session_id, title, lesson_text, lesson_kind, confidence,
                source_excerpt, content_fingerprint, family_key, provenance,
                created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "session", "broken", "broken", "preference", "not-a-number", "",
                f"sha256:{'f' * 64}", "", "unknown_legacy",
                "2026-01-01T00:00:00+00:00", "2026-01-01T00:00:00+00:00",
            ),
        )
        store._connection.commit()  # noqa: SLF001

        assert [memory.id for memory in store.get_all_memories()] == [valid.id]
        status = store.status_snapshot()
        assert status["counts"]["quarantined"] == 1
        payload = store._connection.execute(  # noqa: SLF001
            "SELECT raw_payload FROM memory_quarantine LIMIT 1"
        ).fetchone()[0]
        assert "broken" not in payload
    finally:
        store.close()


def test_recall_quarantines_malformed_candidate_and_returns_valid_match(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "memory.db")
    try:
        valid, _ = store.save_memory(
            session_id="session",
            title="Tea",
            lesson_text="The user prefers tea.",
            lesson_kind="preference",
            confidence=0.9,
            source_excerpt="tea",
        )
        store._connection.execute("PRAGMA ignore_check_constraints=ON")  # noqa: SLF001
        store._connection.execute(  # noqa: SLF001
            """
            INSERT INTO memories (
                session_id, title, lesson_text, lesson_kind, confidence,
                source_excerpt, content_fingerprint, family_key, provenance,
                created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "session", "Corrupt tea", "Tea preference", "preference", "nan-text",
                "tea", f"sha256:{'e' * 64}", "", "unknown_legacy",
                "2026-01-01T00:00:00+00:00", "2026-01-01T00:00:00+00:00",
            ),
        )
        store._connection.commit()  # noqa: SLF001

        assert [memory.id for memory in store.recall_memories("tea")] == [valid.id]
        assert store.status_snapshot()["counts"]["quarantined"] == 1
    finally:
        store.close()


def test_quarantine_retains_only_the_bounded_newest_rows(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(memory_store_module, "MAX_QUARANTINE_ROWS", 2)
    store = MemoryStore(tmp_path / "memory.db")
    try:
        for row_id in ("oldest", "middle", "newest"):
            store._quarantine_malformed_row(  # noqa: SLF001
                source_table="legacy_rows",
                row=(row_id, "private content"),
                reason_code="invalid_row",
            )

        rows = store._connection.execute(  # noqa: SLF001
            "SELECT source_row_id FROM memory_quarantine ORDER BY id"
        ).fetchall()
        assert [row[0] for row in rows] == ["middle", "newest"]
    finally:
        store.close()


def test_concurrent_connections_upsert_one_approved_row(tmp_path: Path) -> None:
    path = tmp_path / "memory.db"
    first = MemoryStore(path)
    second = MemoryStore(path)
    errors: list[BaseException] = []
    barrier = threading.Barrier(2)

    def _save(store: MemoryStore) -> None:
        try:
            barrier.wait(timeout=5)
            store.save_memory(
                session_id="session",
                title="Tea",
                lesson_text="The user prefers tea.",
                lesson_kind="preference",
                confidence=0.9,
                source_excerpt="tea",
            )
        except BaseException as error:  # noqa: BLE001
            errors.append(error)

    threads = [threading.Thread(target=_save, args=(store,)) for store in (first, second)]
    for thread in threads:
        thread.start()
    # A bare bounded join returns the same way for a finished worker and a hung
    # one, so a save that deadlocks would leave errors empty and pass this test.
    join_all_or_fail(threads, timeout=10, what="concurrent save workers")
    try:
        assert errors == []
        assert len(first.get_all_memories()) == 1
    finally:
        first.close()
        second.close()


def test_fts_recalls_only_relevant_memory_when_it_is_older_than_500_rows(
    tmp_path: Path,
) -> None:
    store = MemoryStore(tmp_path / "memory.db")
    try:
        rows = []
        for index in range(10_000):
            exact = index == 0
            lesson = (
                "The deployment codename is heliotrope zebra."
                if exact
                else f"Unrelated durable note number {index}."
            )
            timestamp = f"2026-01-{1 if exact else 2:02d}T00:00:00+00:00"
            rows.append(
                (
                    f"session-{index}",
                    "Deployment codename" if exact else f"Note {index}",
                    lesson,
                    "preference",
                    0.9,
                    "",
                    build_content_digest("preference", lesson),
                    "",
                    "unknown_legacy",
                    timestamp,
                    timestamp,
                )
            )
        store._connection.executemany(  # noqa: SLF001
            """
            INSERT INTO memories (
                session_id, title, lesson_text, lesson_kind, confidence,
                source_excerpt, content_fingerprint, family_key, provenance,
                created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            rows,
        )
        store._connection.commit()  # noqa: SLF001

        recalled = store.recall_memories("heliotrope zebra", limit=1)
        assert len(recalled) == 1
        assert recalled[0].lesson_text == "The deployment codename is heliotrope zebra."
    finally:
        store.close()
