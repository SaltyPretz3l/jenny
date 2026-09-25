from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

import pytest

from sidecar.ai.memory.contracts import MemoryPolicy, build_content_digest
from sidecar.ai.memory.service import MemoryService
from sidecar.ai.memory.store import MemoryStore

PROJECT_ALPHA = "project_alpha"
PROJECT_BETA = "project_beta"


def _save(store: MemoryStore, *, project_id: str, session_id: str = "session-1"):
    return store.save_memory(
        session_id=session_id,
        title="Preference: tea",
        lesson_text="The user prefers tea.",
        lesson_kind="preference",
        confidence=0.9,
        source_excerpt="I prefer tea",
        project_id=project_id,
    )[0]


def test_memory_policy_validates_explicit_project_scope() -> None:
    assert MemoryPolicy().project_id == "project_general"
    assert MemoryPolicy(project_id=PROJECT_ALPHA).project_id == PROJECT_ALPHA
    with pytest.raises(ValueError, match="project_id is invalid"):
        MemoryPolicy(project_id="alpha")


def test_same_content_and_id_operations_are_isolated_by_project(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "memory.db")
    try:
        alpha = _save(store, project_id=PROJECT_ALPHA)
        beta = _save(store, project_id=PROJECT_BETA)

        assert alpha.id != beta.id
        assert alpha.project_id == PROJECT_ALPHA
        assert beta.project_id == PROJECT_BETA
        assert store.get_memory_by_id(alpha.id, project_id=PROJECT_BETA) is None
        assert store.delete_memory(alpha.id, project_id=PROJECT_BETA) is False
        assert store.delete_memory(alpha.id, project_id=PROJECT_ALPHA) is True
        assert store.get_memory_by_id(beta.id, project_id=PROJECT_BETA) == beta
        assert store.is_memory_suppressed(
            alpha.content_fingerprint, project_id=PROJECT_ALPHA
        )
        assert not store.is_memory_suppressed(
            alpha.content_fingerprint, project_id=PROJECT_BETA
        )
    finally:
        store.close()


def test_status_counts_follow_the_requested_scope(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "memory.db")
    try:
        _save(store, project_id=PROJECT_ALPHA)
        _save(store, project_id=PROJECT_BETA)
        _save(store, project_id="project_general")

        alpha = store.status_snapshot(project_id=PROJECT_ALPHA)
        assert alpha["counts"]["approved"] == 1
        assert alpha["counts_scope"] == "project"
        assert store.status_snapshot()["counts"]["approved"] == 1

        everything = store.status_snapshot(all_projects=True)
        assert everything["counts"]["approved"] == 3
        assert everything["counts_scope"] == "all"
        assert MemoryService(store).status(all_projects=True)["counts"]["approved"] == 3
    finally:
        store.close()


def test_pending_and_page_anchors_do_not_cross_projects(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "memory.db")
    try:
        now = datetime.now(timezone.utc).isoformat()
        for project_id, title in ((PROJECT_ALPHA, "Alpha"), (PROJECT_BETA, "Beta")):
            lesson = f"{title} preference."
            store._connection.execute(  # noqa: SLF001
                """
                INSERT INTO pending_memory_candidates (
                    session_id, source_request_id, title, lesson_text, lesson_kind,
                    confidence, source_excerpt, content_fingerprint, family_key,
                    category, created_at, updated_at, project_id
                ) VALUES ('session-1', ?, ?, ?, 'preference', 0.9, '', ?, '', '', ?, ?, ?)
                """,
                (
                    f"request-{title.lower()}",
                    title,
                    lesson,
                    build_content_digest("preference", lesson),
                    now,
                    now,
                    project_id,
                ),
            )
        store._connection.commit()  # noqa: SLF001

        alpha_rows, alpha_cursor = store.get_pending_candidates_page(
            limit=1, project_id=PROJECT_ALPHA
        )
        beta_rows, beta_cursor = store.get_pending_candidates_page(
            limit=1, project_id=PROJECT_BETA
        )

        assert [row.title for row in alpha_rows] == ["Alpha"]
        assert [row.title for row in beta_rows] == ["Beta"]
        assert alpha_cursor is None
        assert beta_cursor is None
        assert store.delete_pending_candidate(
            session_id="session-1",
            content_fingerprint=alpha_rows[0].content_fingerprint,
            project_id=PROJECT_BETA,
        ) is False
        assert store.delete_pending_candidate(
            session_id="session-1",
            content_fingerprint=alpha_rows[0].content_fingerprint,
            project_id=PROJECT_ALPHA,
        ) is True
        assert store.is_memory_suppressed(
            alpha_rows[0].content_fingerprint, project_id=PROJECT_ALPHA
        )
        assert not store.is_memory_suppressed(
            alpha_rows[0].content_fingerprint, project_id=PROJECT_BETA
        )
    finally:
        store.close()


def test_approved_paging_and_counts_are_project_scoped(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "memory.db")
    try:
        for index in range(3):
            store.save_memory(
                session_id=f"alpha-{index}",
                title=f"Alpha {index}",
                lesson_text=f"Alpha preference {index}.",
                lesson_kind="preference",
                confidence=0.9,
                source_excerpt="",
                project_id=PROJECT_ALPHA,
            )
        _save(store, project_id=PROJECT_BETA)

        first, cursor = store.get_memories_page(limit=2, project_id=PROJECT_ALPHA)
        assert len(first) == 2
        assert cursor is not None
        snapshot, after = cursor
        second, next_cursor = store.get_memories_page(
            limit=2,
            snapshot_max_id=snapshot,
            after_id=after,
            project_id=PROJECT_ALPHA,
        )
        assert len(second) == 1
        assert next_cursor is None
        assert all(row.project_id == PROJECT_ALPHA for row in [*first, *second])
        assert store.status_snapshot(project_id=PROJECT_ALPHA)["counts"]["approved"] == 3
        assert store.status_snapshot(project_id=PROJECT_BETA)["counts"]["approved"] == 1
    finally:
        store.close()


@pytest.mark.parametrize("use_fts", [True, False])
def test_recall_filters_project_before_bounded_candidates(
    tmp_path: Path, use_fts: bool
) -> None:
    store = MemoryStore(tmp_path / "memory.db")
    try:
        now = datetime.now(timezone.utc).isoformat()
        rows = []
        for index in range(1_005):
            lesson = f"Needle preference from alpha {index}."
            rows.append(
                (
                    f"session-{index}",
                    f"Alpha {index}",
                    lesson,
                    build_content_digest("preference", lesson),
                    now,
                    now,
                    PROJECT_ALPHA,
                )
            )
        target_lesson = "Needle preference from beta target."
        rows.append(
            (
                "session-target",
                "Beta target",
                target_lesson,
                build_content_digest("preference", target_lesson),
                now,
                now,
                PROJECT_BETA,
            )
        )
        store._connection.executemany(  # noqa: SLF001
            """
            INSERT INTO memories (
                session_id, title, lesson_text, lesson_kind, confidence,
                source_excerpt, content_fingerprint, family_key, provenance,
                created_at, updated_at, project_id
            ) VALUES (?, ?, ?, 'preference', 0.9, '', ?, '', 'user_approved', ?, ?, ?)
            """,
            rows,
        )
        store._connection.commit()  # noqa: SLF001
        store._recall_index_available = use_fts  # noqa: SLF001

        recalled = store.recall_memories(
            "needle beta target", limit=3, project_id=PROJECT_BETA
        )

        assert [memory.title for memory in recalled] == ["Beta target"]
        assert all(memory.project_id == PROJECT_BETA for memory in recalled)
    finally:
        store.close()
