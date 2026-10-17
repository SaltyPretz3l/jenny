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
from sidecar.ai.memory.contracts import build_text_digest
from sidecar.ai.memory.store import MemoryStore
from sidecar.ai.memory.store_shared import (
    MAX_ALL_MEMORIES_LIMIT,
    MEMORY_MAINTENANCE_SECONDS,
)
from sidecar.exceptions import MemoryStoreError
from tests._concurrency import join_all_or_fail
from tests.sidecar.ai.memory.memory_v9_helpers import forget_row, save_row, update_row


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
    store._connection.executemany(
        """
        INSERT INTO pending_memory_candidates (
            session_id, source_request_id, title, lesson_text, lesson_kind,
            confidence, source_excerpt, content_fingerprint,
            category, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                build_text_digest("old"),
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
                build_text_digest("fresh"),
                "",
                fresh_at,
                fresh_at,
            ),
        ),
    )
    store._connection.executemany(
        """
        INSERT INTO memories (
            session_id, title, lesson_text, lesson_kind, confidence,
            source_excerpt, content_fingerprint, origin, provenance,
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
                build_text_digest("approved old"),
                "legacy",
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
                build_text_digest("approved fresh"),
                "legacy",
                "unknown_legacy",
                fresh_at,
                fresh_at,
            ),
        ),
    )
    store._connection.commit()


def _run_maintenance_now(
    store: MemoryStore,
    *,
    max_age_days: int,
    max_rows_per_table: int,
    max_db_bytes: int,
) -> dict[str, object]:
    with store._lock:
        report = store._perform_maintenance(
            max_age_days=max_age_days,
            max_rows_per_table=max_rows_per_table,
            max_db_bytes=max_db_bytes,
            apply_age_retention=True,
        )
        store._successful_mutations = 0
        store._last_maintenance_monotonic = time.monotonic()
        return report


def test_write_transaction_rolls_back_commit_failure_and_allows_next_write(
    tmp_path: Path,
) -> None:
    store = MemoryStore(tmp_path / "memory.db")
    try:
        timestamp = datetime.now(timezone.utc).isoformat()
        store._connection.execute(
            """
            INSERT INTO pending_memory_candidates (
                session_id, source_request_id, title, lesson_text, lesson_kind,
                confidence, source_excerpt, content_fingerprint,
                category, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?)
            """,
            (
                "session-1",
                "request-1",
                "Tea",
                "The user likes tea.",
                "preference",
                0.8,
                "tea",
                build_text_digest("The user likes tea."),
                timestamp,
                timestamp,
            ),
        )
        store._connection.commit()
        proxy = _CommitFailOnceConnection(store._connection)
        store._connection = proxy  # type: ignore[assignment]

        with pytest.raises(MemoryStoreError, match="failed to write memory"):
            save_row(
                store,
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

        memory, created = save_row(
            store,
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
            "pending_memory_candidates": 1,
            "memory_operations": 0,
            "archived_memories": 0,
            "memory_session_markers": 0,
        }
        assert store._connection.execute(
            "SELECT COUNT(*) FROM pending_memory_candidates"
        ).fetchone()[0] == 1
        assert store._connection.execute(
            "SELECT COUNT(*) FROM memories"
        ).fetchone()[0] == 2
    finally:
        store.close()
def test_maintenance_count_cap_evicts_oldest_rows_first(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "memory.db")
    try:
        store._connection.executemany(
            """
            INSERT INTO pending_memory_candidates (
                session_id, source_request_id, title, lesson_text, lesson_kind,
                confidence, content_fingerprint, created_at, updated_at
            ) VALUES ('session', ?, ?, ?, 'preference', 0.5, ?, ?, ?)
            """,
            [
                (name, name, name, build_text_digest(name), *(stamp,) * 2)
                for name, stamp in (
                    ("oldest", "2026-01-01T00:00:00+00:00"),
                    ("middle", "2026-01-02T00:00:00+00:00"),
                    ("newest", "2026-01-03T00:00:00+00:00"),
                )
            ],
        )
        store._connection.commit()

        report = _run_maintenance_now(
            store,
            max_age_days=10_000,
            max_rows_per_table=2,
            max_db_bytes=1 << 40,
        )

        assert report["removed"]["pending_memory_candidates"] == 1
        rows = store._connection.execute(
            "SELECT source_request_id FROM pending_memory_candidates ORDER BY created_at ASC"
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
        store._connection.execute(
            """
            INSERT INTO pending_memory_candidates (
                session_id, source_request_id, title, lesson_text, lesson_kind,
                confidence, content_fingerprint, created_at, updated_at
            ) VALUES ('session', ?, ?, ?, 'preference', 0.5, ?, ?, ?)
            """,
            ("old", "old", "old", build_text_digest("old"), old_at, old_at),
        )
        store._connection.commit()
        proxy = _CommitFailOnceConnection(store._connection)
        store._connection = proxy  # type: ignore[assignment]

        with pytest.raises(MemoryStoreError, match="failed to maintain memory database"):
            _run_maintenance_now(
                store,
                max_age_days=180,
                max_rows_per_table=10_000,
                max_db_bytes=1 << 40,
            )
        assert proxy.rollback_count == 1
        assert proxy.execute("SELECT COUNT(*) FROM pending_memory_candidates").fetchone()[0] == 1

        report = _run_maintenance_now(
            store,
            max_age_days=180,
            max_rows_per_table=10_000,
            max_db_bytes=1 << 40,
        )
        assert report["removed"]["pending_memory_candidates"] == 1
        assert proxy.execute("SELECT COUNT(*) FROM pending_memory_candidates").fetchone()[0] == 0
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
                    store._connection.execute(
                        f"SELECT COUNT(*) FROM {table}"
                    ).fetchone()[0]
                )
                for table in ("pending_memory_candidates",)
            )
            return 2 if ephemeral_rows else 0

        monkeypatch.setattr(store, "_database_physical_bytes", _simulated_live_bytes)
        report = _run_maintenance_now(
            store,
            max_age_days=10_000,
            max_rows_per_table=10_000,
            max_db_bytes=1,
        )

        assert report["removed"]["pending_memory_candidates"] == 2
        assert "memories" not in report["removed"]
        assert store._connection.execute(
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

        store._successful_mutations = 99
        save_row(
            store,
            session_id="session",
            title="Tea",
            lesson_text="Tea",
            lesson_kind="preference",
            confidence=0.8,
            source_excerpt="tea",
        )
        assert len(calls) == 2

        store._last_maintenance_monotonic -= MEMORY_MAINTENANCE_SECONDS + 1
        store.get_all_memories()
        assert len(calls) == 2
        save_row(
            store,
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
                build_text_digest(f"tea-{index}"),
                "legacy",
                "unknown_legacy",
                now,
                now,
            )
            for index in range(MAX_ALL_MEMORIES_LIMIT + 100)
        ]
        store._connection.executemany(
            """
            INSERT INTO memories (
                session_id, title, lesson_text, lesson_kind, confidence,
                source_excerpt, content_fingerprint, origin, provenance,
                created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            rows,
        )
        store._connection.commit()
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
        store._recall_index_available = False
        assert store.recall_memories("green tea") == []
        assert 0 < scored <= MAX_ALL_MEMORIES_LIMIT
        if scored < MAX_ALL_MEMORIES_LIMIT:
            assert store._last_recall_partial is True
        assert len(
            store._candidate_rows_for_recall(
                query_tokens={"green", "tea"},
            )
        ) == MAX_ALL_MEMORIES_LIMIT

        plan = store._connection.execute(
            "EXPLAIN QUERY PLAN SELECT id FROM memories "
            "WHERE project_id = ? AND status = 'active' "
            "ORDER BY updated_at DESC, id DESC LIMIT ?",
            ("project_general", MAX_ALL_MEMORIES_LIMIT),
        ).fetchall()
        assert any("idx_memories_project_status_updated" in str(row) for row in plan)
    finally:
        store.close()


def test_capacity_pressure_rejects_growth_but_keeps_existing_approved(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = MemoryStore(tmp_path / "memory.db")
    try:
        first, _ = save_row(
            store,
            session_id="session",
            title="Tea",
            lesson_text="The user prefers tea.",
            lesson_kind="preference",
            confidence=0.9,
            source_excerpt="tea",
        )
        monkeypatch.setattr(store, "_database_physical_bytes", lambda: 1 << 40)

        with pytest.raises(MemoryStoreError) as exc_info:
            save_row(
                store,
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
            update_row(
                store,
                first.id,
                title="A much longer tea preference",
                lesson_text="The user strongly prefers tea every afternoon.",
            )
        assert update_error.value.code == CMP_MEMORY_CAPACITY_EXCEEDED
        assert [memory.id for memory in store.get_all_memories()] == [first.id]
        assert forget_row(store, first.id).status == "saved"
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
        saved, created = save_row(
            store,
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
        memory, _ = save_row(
            store,
            session_id="session",
            title="Tea",
            lesson_text="The user prefers tea.",
            lesson_kind="preference",
            confidence=0.9,
            source_excerpt="tea",
        )
        assert forget_row(store, memory.id).status == "saved"
        assert store.is_memory_suppressed(memory.content_fingerprint) is True

        restored, created = save_row(
            store,
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
        valid, _ = save_row(
            store,
            session_id="session",
            title="Tea",
            lesson_text="The user prefers tea.",
            lesson_kind="preference",
            confidence=0.9,
            source_excerpt="tea",
        )
        store._connection.execute("PRAGMA ignore_check_constraints=ON")
        store._connection.execute(
            """
            INSERT INTO memories (
                session_id, title, lesson_text, lesson_kind, confidence,
                source_excerpt, content_fingerprint, origin, provenance,
                created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "session", "broken", "broken", "preference", "not-a-number", "",
                f"sha256:{'f' * 64}", "legacy", "unknown_legacy",
                "2026-01-01T00:00:00+00:00", "2026-01-01T00:00:00+00:00",
            ),
        )
        store._connection.commit()

        assert [memory.id for memory in store.get_all_memories()] == [valid.id]
        status = store.status_snapshot()
        assert status["operational_counts"]["quarantined"] == 1
        payload = store._connection.execute(
            "SELECT raw_payload FROM memory_quarantine LIMIT 1"
        ).fetchone()[0]
        assert "broken" not in payload
    finally:
        store.close()


def test_recall_quarantines_malformed_candidate_and_returns_valid_match(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "memory.db")
    try:
        valid, _ = save_row(
            store,
            session_id="session",
            title="Tea",
            lesson_text="The user prefers tea.",
            lesson_kind="preference",
            confidence=0.9,
            source_excerpt="tea",
        )
        store._connection.execute("PRAGMA ignore_check_constraints=ON")
        store._connection.execute(
            """
            INSERT INTO memories (
                session_id, title, lesson_text, lesson_kind, confidence,
                source_excerpt, content_fingerprint, origin, provenance,
                created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "session", "Corrupt tea", "Tea preference", "preference", "nan-text",
                "tea", f"sha256:{'e' * 64}", "legacy", "unknown_legacy",
                "2026-01-01T00:00:00+00:00", "2026-01-01T00:00:00+00:00",
            ),
        )
        store._connection.commit()

        assert [memory.id for memory in store.recall_memories("tea")] == [valid.id]
        assert store.status_snapshot()["operational_counts"]["quarantined"] == 1
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
            store._quarantine_malformed_row(
                source_table="legacy_rows",
                row=(row_id, "private content"),
                reason_code="invalid_row",
            )

        rows = store._connection.execute(
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
            save_row(
                store,
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
                    build_text_digest(lesson),
                    "legacy",
                    "unknown_legacy",
                    timestamp,
                    timestamp,
                )
            )
        store._connection.executemany(
            """
            INSERT INTO memories (
                session_id, title, lesson_text, lesson_kind, confidence,
                source_excerpt, content_fingerprint, origin, provenance,
                created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            rows,
        )
        store._connection.commit()

        recalled = store.recall_memories("heliotrope zebra", limit=1)
        assert len(recalled) == 1
        assert recalled[0].lesson_text == "The deployment codename is heliotrope zebra."
    finally:
        store.close()


def _seed_tea_rows(store: MemoryStore, count: int) -> None:
    now = datetime.now(timezone.utc)
    rows = [
        (
            f"session-{index}",
            f"Tea {index}",
            "The user prefers green tea.",
            "preference",
            0.5 + index / 100,
            "tea",
            build_text_digest(f"deadline-tea-{index}"),
            "legacy",
            "unknown_legacy",
            (now - timedelta(minutes=index)).isoformat(),
            (now - timedelta(minutes=index)).isoformat(),
        )
        for index in range(count)
    ]
    store._connection.executemany(
        """
        INSERT INTO memories (
            session_id, title, lesson_text, lesson_kind, confidence,
            source_excerpt, content_fingerprint, origin, provenance,
            created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        rows,
    )
    store._connection.commit()


class _StepClock:
    """Returns 0.0 for the first ``fresh_calls`` reads, then a time past any deadline."""

    def __init__(self, fresh_calls: int) -> None:
        self.fresh_calls = fresh_calls
        self.reads = 0

    def __call__(self) -> float:
        self.reads += 1
        return 0.0 if self.reads <= self.fresh_calls else 1_000.0


def _record_scores(
    monkeypatch: pytest.MonkeyPatch,
) -> list[tuple[float, str, int]]:
    scored: list[tuple[float, str, int]] = []
    original = MemoryStore._score_memory_row

    def _score(self: MemoryStore, row: Any, **kwargs: Any) -> float | None:
        score = original(self, row, **kwargs)
        if score is not None and score > 0.0:
            scored.append((score, str(row[11]), int(row[0])))
        return score

    monkeypatch.setattr(MemoryStore, "_score_memory_row", _score)
    return scored


def test_recall_deadline_expiry_returns_best_matches_scored_so_far(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = MemoryStore(tmp_path / "memory.db")
    try:
        _seed_tea_rows(store, 40)
        store._recall_index_available = False
        scored = _record_scores(monkeypatch)
        # One read computes the deadline, then one read per scoring iteration:
        # ten rows are scored before the clock jumps past the deadline.
        clock = _StepClock(fresh_calls=1 + 10)

        recalled = store.recall_memories("green tea", limit=5, clock=clock)

        assert store._last_recall_partial is True
        assert len(scored) == 10
        assert 0 < len(recalled) < 40
        expected = [memory_id for _, _, memory_id in sorted(scored, reverse=True)[:5]]
        assert [memory.id for memory in recalled] == expected
        assert store.status_snapshot()["recall_partial"] is True
    finally:
        store.close()


def test_recall_deadline_expiring_after_scoring_keeps_complete_result(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = MemoryStore(tmp_path / "memory.db")
    try:
        _seed_tea_rows(store, 5)
        store._recall_index_available = False
        scored = _record_scores(monkeypatch)
        # The clock stays fresh for the deadline read and all five loop reads,
        # then expires for anything that reads it during or after the sort.
        clock = _StepClock(fresh_calls=1 + 5)

        recalled = store.recall_memories("green tea", limit=5, clock=clock)

        assert store._last_recall_partial is False
        assert len(scored) == 5
        expected = [memory_id for _, _, memory_id in sorted(scored, reverse=True)]
        assert [memory.id for memory in recalled] == expected
    finally:
        store.close()


def test_recall_honors_caller_supplied_deadline(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = MemoryStore(tmp_path / "memory.db")
    try:
        _seed_tea_rows(store, 5)
        store._recall_index_available = False
        scored = _record_scores(monkeypatch)

        recalled = store.recall_memories(
            "green tea", limit=5, deadline=0.5, clock=lambda: 1.0
        )

        assert recalled == []
        assert scored == []
        assert store._last_recall_partial is True
    finally:
        store.close()
