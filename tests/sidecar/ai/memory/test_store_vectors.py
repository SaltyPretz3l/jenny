"""Schema v10 memory vectors and the ``memory.embed_step`` indexer (row 58 W4)."""

from __future__ import annotations

import sqlite3
from collections.abc import Iterator
from pathlib import Path

import pytest

from sidecar.ai.memory.service import MemoryService
from sidecar.ai.memory.store import SCHEMA_VERSION, MemoryStore
from sidecar.ai.memory.store_reflection import ReflectionCursor
from tests.sidecar.ai.memory.fake_embedder import FakeEmbedder, FakeProvider, StepClock
from tests.sidecar.ai.memory.memory_v9_helpers import (
    PROJECT,
    WallClock,
    next_operation_id,
    remember,
    saved_id,
)

CHAT = "chat-1"


@pytest.fixture
def store(tmp_path: Path) -> Iterator[MemoryStore]:
    memory_store = MemoryStore(tmp_path / "memory.db", clock=WallClock())
    try:
        yield memory_store
    finally:
        memory_store.close()


def _service(store: MemoryStore, embedder: object | None = None, *, enabled: bool = True):
    return MemoryService(store, hybrid_recall_enabled=enabled, embedder_source=lambda: embedder)


def _vectors(store: MemoryStore) -> list[tuple[int, str, str, int]]:
    return store._connection.execute(
        "SELECT memory_id, content_fingerprint, model_key, dim FROM memory_vectors ORDER BY memory_id"
    ).fetchall()


def _schema_names(store: MemoryStore, kind: str) -> set[str]:
    return {
        str(row[0])
        for row in store._connection.execute(
            "SELECT name FROM sqlite_master WHERE type = ?", (kind,)
        ).fetchall()
    }


def test_fresh_store_is_v10_with_the_vector_table_and_its_triggers(store: MemoryStore) -> None:
    assert SCHEMA_VERSION == 10
    assert store._connection.execute("PRAGMA user_version").fetchone() == (10,)
    assert "memory_vectors" in _schema_names(store, "table")
    assert {"memory_vectors_invalidate", "memory_vectors_delete"} <= _schema_names(
        store, "trigger"
    )
    columns = [
        row[1] for row in store._connection.execute("PRAGMA table_info(memory_vectors)")
    ]
    assert columns == [
        "memory_id", "content_fingerprint", "model_key", "dim", "norm", "blob", "created_at",
    ]


def test_embed_step_embeds_active_rows_with_the_document_template(store: MemoryStore) -> None:
    first = saved_id(remember(store, "The user drives an old automobile.", title="Car"))
    second = saved_id(remember(store, "Prefers tabs.", title="Tabs"))
    embedder = FakeEmbedder()

    result = _service(store, embedder).embed_step(budget_seconds=1.5, batch=16)

    assert result == {"ok": True, "embedded": 2, "remaining": 0}
    assert sorted(embedder.provider.texts) == sorted([
        "doc: Car | Car\nThe user drives an old automobile.",
        "doc: Tabs | Tabs\nPrefers tabs.",
    ])
    rows = _vectors(store)
    assert [row[0] for row in rows] == [first, second]
    assert {row[2] for row in rows} == {"fake-hash-64"}
    assert {row[3] for row in rows} == {64}
    # A second step has nothing left to do.
    assert _service(store, embedder).embed_step(budget_seconds=1.5, batch=16) == {
        "ok": True, "embedded": 0, "remaining": 0,
    }


def test_embed_step_stops_at_its_budget_and_reports_what_remains(store: MemoryStore) -> None:
    for index in range(5):
        remember(store, f"Durable note number {index}.")
    clock = StepClock(step=1.0)
    embedder = FakeEmbedder(provider=FakeProvider(on_call=clock.tick))

    result = _service(store, embedder).embed_step(budget_seconds=1.5, batch=1, clock=clock)

    assert result == {"ok": True, "embedded": 2, "remaining": 3}
    assert len(_vectors(store)) == 2


def test_embed_step_flag_off_and_embedder_off_are_reasons_not_errors(store: MemoryStore) -> None:
    remember(store, "Prefers tabs.")
    assert _service(store, FakeEmbedder(), enabled=False).embed_step() == {
        "ok": True, "embedded": 0, "remaining": 0, "reason": "hybrid_off",
    }
    result = _service(store, None).embed_step()
    assert result["reason"] == "embedder_off" and result["embedded"] == 0
    assert _vectors(store) == []


def test_embed_step_failure_keeps_rows_pending(store: MemoryStore) -> None:
    remember(store, "Prefers tabs.")
    embedder = FakeEmbedder(provider=FakeProvider(fail=True))
    result = _service(store, embedder).embed_step()
    assert result == {"ok": True, "embedded": 0, "remaining": 1, "reason": "embedder_error"}


def test_a_model_key_switch_drops_old_vectors_and_reembeds(store: MemoryStore) -> None:
    remember(store, "Prefers tabs.")
    remember(store, "Uses pytest.")
    _service(store, FakeEmbedder(model_key="model-a")).embed_step()
    assert {row[2] for row in _vectors(store)} == {"model-a"}

    result = _service(store, FakeEmbedder(model_key="model-b")).embed_step(batch=1, clock=_frozen)
    assert {row[2] for row in _vectors(store)} == {"model-b"}
    assert result["embedded"] == 2 and result["remaining"] == 0


def _frozen() -> float:
    return 0.0


def test_an_edit_invalidates_the_vector_and_the_next_step_reembeds(store: MemoryStore) -> None:
    memory_id = saved_id(remember(store, "Prefers tabs.", origin="user"))
    service = _service(store, FakeEmbedder())
    service.embed_step()
    before = _vectors(store)

    store.update(
        operation_id=next_operation_id(), project_id=PROJECT, memory_id=memory_id,
        text="Prefers spaces.", expected_revision=None, origin="user",
    )
    assert _vectors(store) == []
    assert service.embed_step()["embedded"] == 1
    after = _vectors(store)
    assert after[0][0] == memory_id and after[0][1] != before[0][1]


def test_a_title_only_edit_also_invalidates(store: MemoryStore) -> None:
    memory_id = saved_id(remember(store, "Prefers tabs.", origin="user"))
    _service(store, FakeEmbedder()).embed_step()
    store.update(
        operation_id=next_operation_id(), project_id=PROJECT, memory_id=memory_id,
        title="Indentation", expected_revision=None, origin="user",
    )
    assert _vectors(store) == []


def test_forget_erase_purge_and_archive_drop_the_vector(store: MemoryStore) -> None:
    forgotten = saved_id(remember(store, "Forget me.", origin="user"))
    erased = saved_id(remember(store, "Erase me.", origin="user"))
    chat_note = saved_id(remember(store, "Chat only.", scope_session_id=CHAT))
    kept = saved_id(remember(store, "Keep me.", project_id="project_beta"))
    archived = saved_id(remember(store, "Archive me.", project_id="project_gamma"))
    service = _service(store, FakeEmbedder())
    assert service.embed_step()["embedded"] == 5

    store.forget(
        operation_id=next_operation_id(), project_id=PROJECT, memory_id=forgotten,
        expected_revision=None, origin="user",
    )
    assert store.erase(project_id=PROJECT, memory_id=erased) is True
    store.purge_session(CHAT)
    store.archive_project("project_gamma")

    assert [row[0] for row in _vectors(store)] == [kept]
    assert {forgotten, erased, chat_note, archived}.isdisjoint(row[0] for row in _vectors(store))


def test_the_delete_trigger_holds_without_foreign_keys(tmp_path: Path) -> None:
    path = tmp_path / "memory.db"
    store = MemoryStore(path, clock=WallClock())
    memory_id = saved_id(remember(store, "Prefers tabs."))
    _service(store, FakeEmbedder()).embed_step()
    store.close()

    connection = sqlite3.connect(str(path))
    try:
        assert connection.execute("PRAGMA foreign_keys").fetchone() == (0,)
        connection.execute("DELETE FROM memories WHERE id = ?", (memory_id,))
        connection.commit()
        assert connection.execute("SELECT COUNT(*) FROM memory_vectors").fetchone() == (0,)
    finally:
        connection.close()


def test_recap_rows_are_never_embedded(store: MemoryStore) -> None:
    store.apply_reflection(
        session_id=CHAT, project_id=PROJECT, capture="auto", expected_fingerprint=None,
        cursor=ReflectionCursor(2, "m-2", "sha256:" + "b" * 64, "inc_1", 1),
        proposals=(), recap="A chat about tabs.", is_policy_stale=lambda: False,
    )
    remember(store, "Prefers tabs.")
    result = _service(store, FakeEmbedder()).embed_step()
    assert result == {"ok": True, "embedded": 1, "remaining": 0}
    recap_ids = {
        row[0] for row in store._connection.execute(
            "SELECT id FROM memories WHERE provenance = 'reflection_recap'"
        )
    }
    assert recap_ids and recap_ids.isdisjoint(row[0] for row in _vectors(store))


def test_a_vector_never_lands_on_a_row_that_changed_mid_step(store: MemoryStore) -> None:
    memory_id = saved_id(remember(store, "Prefers tabs.", origin="user"))

    def edit_during_embed() -> None:
        store.update(
            operation_id=next_operation_id(), project_id=PROJECT, memory_id=memory_id,
            text="Prefers spaces.", expected_revision=None, origin="user",
        )

    provider = FakeProvider(on_call=edit_during_embed)
    result = _service(store, FakeEmbedder(provider=provider)).embed_step(batch=1)
    # The stale vector is discarded and the step ends; the next step re-embeds.
    assert result == {"ok": True, "embedded": 0, "remaining": 1}
    assert _vectors(store) == []
