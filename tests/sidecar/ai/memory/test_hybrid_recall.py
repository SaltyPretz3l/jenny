"""Hybrid (lexical + vector) memory recall behind ``memory_hybrid_recall`` (row 58 W4 S6)."""

from __future__ import annotations

import time
from collections.abc import Iterator
from pathlib import Path

import pytest

from sidecar.ai.memory import hybrid_recall, store_vectors
from sidecar.ai.memory.contracts import (
    ALWAYS_ON_BUDGET_CHARS,
    ALWAYS_ON_HEADING_RESERVE,
    ALWAYS_ON_ROW_OVERHEAD,
    MemoryPolicy,
)
from sidecar.ai.memory.hybrid_recall import fuse_rankings
from sidecar.ai.memory.service import PROMPT_RECALL_DEADLINE_SECONDS, MemoryService
from sidecar.ai.memory.store import ApprovedMemory, MemoryStore
from sidecar.ai.memory.store_reflection import ReflectionCursor
from sidecar.ai.memory.store_vectors import (
    MAX_VECTOR_SCAN_ROWS,
    StoredVector,
    vector_scan_rows,
)
from sidecar.ai.semantic.vectors import pack_vector
from tests.sidecar.ai.memory.fake_embedder import FakeEmbedder, FakeProvider, embed_text
from tests.sidecar.ai.memory.memory_v9_helpers import (
    PROJECT,
    WallClock,
    next_operation_id,
    remember,
    saved_id,
)

CHAT = "chat-1"
CAR = "The user drives an old automobile."
QUERY = "which car"


@pytest.fixture
def store(tmp_path: Path) -> Iterator[MemoryStore]:
    memory_store = MemoryStore(tmp_path / "memory.db", clock=WallClock())
    try:
        yield memory_store
    finally:
        memory_store.close()


def _service(store: MemoryStore, embedder: object | None, *, enabled: bool = True):
    return MemoryService(store, hybrid_recall_enabled=enabled, embedder_source=lambda: embedder)


def _prompt(service: MemoryService, query: str, **kwargs: object) -> list[ApprovedMemory]:
    memories, _recaps = service.recall_for_prompt_with_recaps(
        query, policy=MemoryPolicy(project_id=PROJECT), scope_session_id=CHAT, **kwargs
    )
    return memories


def _seed(store: MemoryStore) -> dict[str, int]:
    ids = {
        "car": saved_id(remember(store, CAR)),
        "tabs": saved_id(remember(store, "Prefers tabs for indentation.")),
        "dog": saved_id(remember(store, "The family has a hound named Rex.")),
    }
    for index in range(6):
        remember(store, f"Unrelated durable note {index} about invoices.")
    return ids


def _put_vector(store: MemoryStore, memory_id: int, text: str, model_key: str = "fake-hash-64"):
    blob, dim, norm = pack_vector(embed_text(text))
    fingerprint = store._connection.execute(
        "SELECT content_fingerprint FROM memories WHERE id = ?", (memory_id,)
    ).fetchone()[0]
    store._connection.execute(
        "INSERT OR REPLACE INTO memory_vectors VALUES (?, ?, ?, ?, ?, ?, ?)",
        (memory_id, fingerprint, model_key, dim, norm, blob, "2026-10-15T00:00:00+00:00"),
    )
    store._connection.commit()


def test_hybrid_off_is_the_lexical_result_unchanged(store: MemoryStore) -> None:
    _seed(store)
    embedder = FakeEmbedder()
    _service(store, embedder).embed_step()
    lexical = store.recall_memories(
        "tabs indentation", limit=5, project_id=PROJECT, include_general=True,
        scope_session_id=CHAT,
    )
    assert lexical

    off = _prompt(_service(store, embedder, enabled=False), "tabs indentation")
    unavailable = _prompt(_service(store, None), "tabs indentation")

    assert off == lexical
    assert unavailable == lexical
    assert embedder.provider.texts[-1].startswith("doc:")  # no query was embedded


def test_hybrid_finds_a_paraphrase_lexical_recall_misses(store: MemoryStore) -> None:
    ids = _seed(store)
    service = _service(store, FakeEmbedder())
    service.embed_step()
    assert store.recall_memories(QUERY, limit=5, project_id=PROJECT) == []

    recalled = _prompt(service, QUERY)

    assert [memory.id for memory in recalled][:1] == [ids["car"]]
    assert recalled[0].lesson_text == CAR


def test_hybrid_keeps_lexical_hits_and_adds_the_paraphrase(store: MemoryStore) -> None:
    ids = _seed(store)
    service = _service(store, FakeEmbedder())
    service.embed_step()

    recalled = [memory.id for memory in _prompt(service, "tabs and my car")]

    assert ids["tabs"] in recalled and ids["car"] in recalled
    assert len(recalled) <= 5


def test_a_slow_embedder_falls_back_to_lexical_within_the_deadline(store: MemoryStore) -> None:
    ids = _seed(store)
    _service(store, FakeEmbedder()).embed_step()
    slow = _service(store, FakeEmbedder(provider=FakeProvider(delay=0.3)))

    started = time.perf_counter()
    recalled = _prompt(slow, "tabs indentation")
    elapsed = time.perf_counter() - started

    assert recalled and recalled[0].id == ids["tabs"]
    assert elapsed < PROMPT_RECALL_DEADLINE_SECONDS + 0.05


def test_an_embedder_error_falls_back_to_lexical(store: MemoryStore) -> None:
    ids = _seed(store)
    _service(store, FakeEmbedder()).embed_step()
    failing = _service(store, FakeEmbedder(provider=FakeProvider(fail=True)))
    assert [memory.id for memory in _prompt(failing, "tabs indentation")][:1] == [ids["tabs"]]
    assert _prompt(failing, QUERY) == []


def test_no_time_left_skips_the_vector_leg(store: MemoryStore) -> None:
    _seed(store)
    embedder = FakeEmbedder()
    service = _service(store, embedder)
    service.embed_step()
    embedded_before = len(embedder.provider.texts)
    ticks = iter([0.0] + [0.2] * 50)  # the deadline is set at 0.0; 50 ms left after
    assert _prompt(service, QUERY, clock=lambda: next(ticks, 0.2)) == []
    assert len(embedder.provider.texts) == embedded_before


def test_the_vector_scan_cap_scales_with_the_dimension() -> None:
    # Reading and scoring 5,000 vectors of 1,024 floats took about 60 ms, past
    # the 40 ms the deadline keeps after the query embed; the cap is in floats.
    assert vector_scan_rows(64) == MAX_VECTOR_SCAN_ROWS
    assert vector_scan_rows(384) == MAX_VECTOR_SCAN_ROWS
    assert vector_scan_rows(1024) == 1875
    assert vector_scan_rows(4096) == 468


def test_the_vector_read_takes_fewer_rows_for_wider_vectors(
    store: MemoryStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    _seed(store)
    _service(store, FakeEmbedder()).embed_step()
    monkeypatch.setattr(store_vectors, "MAX_VECTOR_SCAN_FLOATS", 64 * 3)
    rows = store.vector_candidates(
        model_key="fake-hash-64", dim=64, project_id=PROJECT,
        include_general=True, scope_session_id=CHAT,
    )
    assert len(rows) == 3


def test_a_deadline_passed_during_the_vector_read_skips_scoring(
    store: MemoryStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    _seed(store)
    service = _service(store, FakeEmbedder())
    service.embed_step()
    now = [0.0]
    read = MemoryStore.vector_candidates

    def slow_read(self: MemoryStore, **kwargs: object) -> list[object]:
        rows = read(self, **kwargs)
        now[0] = 10.0
        return rows

    scored: list[int] = []
    monkeypatch.setattr(MemoryStore, "vector_candidates", slow_read)
    monkeypatch.setattr(hybrid_recall, "cosine_hits", lambda *_a, **_k: scored.append(1) or [])
    assert _prompt(service, QUERY, clock=lambda: now[0]) == []
    assert scored == []


def test_the_python_cosine_fallback_stops_at_the_deadline(monkeypatch: pytest.MonkeyPatch) -> None:
    # Without numpy, scoring the capped rows takes over 100 ms at 1,024 floats.
    monkeypatch.setattr(hybrid_recall, "load_numpy", lambda: None)
    blob, _dim, norm = pack_vector([1.0, 0.0])
    rows = [StoredVector(memory_id, blob, norm) for memory_id in range(1, 600)]
    checks: list[int] = []

    def expired() -> bool:
        checks.append(1)
        return True

    assert hybrid_recall.cosine_hits([1.0, 0.0], rows, expired=expired) == []
    assert checks == [1]
    assert hybrid_recall.cosine_hits([1.0, 0.0], rows[:3], expired=lambda: False) == [3, 2, 1]


def test_the_vector_leg_never_returns_out_of_scope_rows(store: MemoryStore) -> None:
    archived = saved_id(remember(store, "My automobile is red.", origin="user"))
    other_project = saved_id(remember(store, "Drives a blue automobile.", project_id="project_beta"))
    other_chat = saved_id(remember(store, "Rents an automobile.", scope_session_id="chat-2"))
    quarantined = saved_id(remember(store, "Owns a green automobile."))
    store.apply_reflection(
        session_id=CHAT, project_id=PROJECT, capture="auto", expected_fingerprint=None,
        cursor=ReflectionCursor(2, "m-2", "sha256:" + "c" * 64, "inc_1", 1),
        proposals=(), recap="A chat about an automobile.", is_policy_stale=lambda: False,
    )
    recap = store._connection.execute(
        "SELECT id FROM memories WHERE provenance = 'reflection_recap'"
    ).fetchone()[0]
    store.forget(
        operation_id=next_operation_id(), project_id=PROJECT, memory_id=archived,
        expected_revision=None, origin="user",
    )
    # Stale vectors written behind the store's back: the join must still filter them.
    for memory_id, text in (
        (archived, "My automobile is red."), (other_project, "Drives a blue automobile."),
        (other_chat, "Rents an automobile."), (recap, "A chat about an automobile."),
        (quarantined, "Owns a green automobile."),
    ):
        _put_vector(store, memory_id, text)
    row = store._connection.execute(
        "SELECT * FROM memories WHERE id = ?", (quarantined,)
    ).fetchone()
    store._quarantine_malformed_row(source_table="memories", row=row, reason_code="test")

    assert _prompt(_service(store, FakeEmbedder()), QUERY) == []


def test_status_reports_hybrid_state_vectors_and_the_always_on_budget(store: MemoryStore) -> None:
    _seed(store)
    on = _service(store, FakeEmbedder())
    on.embed_step()
    status = on.status(project_id=PROJECT)
    assert status["recall_hybrid"] == "on"
    assert status["vector_count"] == 9
    assert status["always_on_budget"] == {
        "budget_chars": ALWAYS_ON_BUDGET_CHARS,
        "heading_reserve": ALWAYS_ON_HEADING_RESERVE,
        "row_overhead": ALWAYS_ON_ROW_OVERHEAD,
    }
    assert ALWAYS_ON_BUDGET_CHARS == 1200 and ALWAYS_ON_HEADING_RESERVE == 144
    assert _service(store, FakeEmbedder(), enabled=False).status()["recall_hybrid"] == "off"
    assert _service(store, None).status()["recall_hybrid"] == "unavailable"


def test_reciprocal_rank_fusion_orders_by_both_legs_then_lexical_rank() -> None:
    def row(memory_id: int, updated: str = "2026-01-01") -> ApprovedMemory:
        return ApprovedMemory(
            id=memory_id, session_id="s", title="t", lesson_text=f"text {memory_id}",
            lesson_kind="fact", confidence=1.0, source_excerpt="",
            content_fingerprint=f"sha256:{memory_id:064x}", provenance="automatic",
            created_at=updated, updated_at=updated,
        )

    lexical = [row(1), row(2), row(3)]
    vector = [row(3), row(4)]
    fused = fuse_rankings(lexical, vector, limit=4)
    # 3 is in both legs; 2 and 4 tie at rank 2 of one leg and the lexical rank wins.
    assert [memory.id for memory in fused] == [3, 1, 2, 4]
    assert [memory.id for memory in fuse_rankings(lexical, vector, limit=2)] == [3, 1]
    assert fuse_rankings(lexical, [], limit=5) == lexical
    # A vector-only order is the vector rank; a cross-leg tie goes to the lexical row.
    newer, older = row(7, "2026-02-01"), row(8, "2026-01-01")
    assert [m.id for m in fuse_rankings([], [older, newer], limit=2)] == [8, 7]
    assert [m.id for m in fuse_rankings([newer], [older], limit=2)] == [7, 8]


def test_the_hybrid_flag_defaults_off_and_reads_config_or_env(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from sidecar.ai.config import parse_runtime_config

    monkeypatch.delenv("JENNY_ENABLE_MEMORY_HYBRID_RECALL", raising=False)
    assert parse_runtime_config({}).memory_hybrid_recall_enabled is False
    assert parse_runtime_config(
        {"memory_hybrid_recall_enabled": True}
    ).memory_hybrid_recall_enabled is True
    monkeypatch.setenv("JENNY_ENABLE_MEMORY_HYBRID_RECALL", "1")
    assert parse_runtime_config({}).memory_hybrid_recall_enabled is True
