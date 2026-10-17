"""W3 limit A: a chat note and its recap with the same text are independent rows."""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest

from sidecar.ai.memory.contracts import build_text_digest, recap_text_digest
from sidecar.ai.memory.store import MemoryStore
from sidecar.ai.memory.store_reflection import RECAP_PROVENANCE, ReflectionCursor
from tests.sidecar.ai.memory.memory_v9_helpers import PROJECT, WallClock, remember

CHAT = "chat-1"
TEXT = "A chat about tabs and spaces."


@pytest.fixture
def store(tmp_path: Path) -> Iterator[MemoryStore]:
    memory_store = MemoryStore(tmp_path / "memory.db", clock=WallClock())
    try:
        yield memory_store
    finally:
        memory_store.close()


def _apply_recap(store: MemoryStore, recap: str, seed: str = "d") -> None:
    result = store.apply_reflection(
        session_id=CHAT, project_id=PROJECT, capture="auto", expected_fingerprint=None,
        cursor=ReflectionCursor(2, "m-2", "sha256:" + seed * 64, "inc_1", 1),
        proposals=(), recap=recap, is_policy_stale=lambda: False,
    )
    assert result["status"] == "applied", result


def _recaps(store: MemoryStore) -> list[tuple[str, str, str]]:
    return store._connection.execute(
        "SELECT lesson_text, content_fingerprint, status FROM memories WHERE provenance = ?",
        (RECAP_PROVENANCE,),
    ).fetchall()


def test_recap_digest_is_salted_and_never_equals_a_note_digest() -> None:
    assert recap_text_digest(TEXT) != build_text_digest(TEXT)
    assert recap_text_digest(TEXT) == recap_text_digest(f"  {TEXT} ")
    # The salt is not a text prefix a note could reproduce.
    assert recap_text_digest(TEXT) != build_text_digest(f"recap {TEXT}")


def test_a_chat_note_does_not_block_the_recap_with_the_same_text(store: MemoryStore) -> None:
    note = remember(store, TEXT, scope_session_id=CHAT)
    assert note.status == "saved" and not note.duplicate

    _apply_recap(store, TEXT)

    assert _recaps(store) == [(TEXT, recap_text_digest(TEXT), "active")]
    visible, _cursor = store.list_active(project_id=PROJECT, scope_session_id=CHAT)
    assert [row.provenance for row in visible] == ["automatic"]
    recalled = store.recall_memories(
        "tabs spaces", limit=5, project_id=PROJECT, scope_session_id=CHAT
    )
    assert [row.id for row in recalled] == [note.memory.id]


def test_a_recap_does_not_make_the_same_chat_note_a_duplicate(store: MemoryStore) -> None:
    _apply_recap(store, TEXT)

    note = remember(store, TEXT, scope_session_id=CHAT)

    assert note.status == "saved" and note.duplicate is False
    assert note.memory is not None and note.memory.provenance != RECAP_PROVENANCE
    assert note.memory.content_fingerprint == build_text_digest(TEXT)
    assert len(_recaps(store)) == 1


def test_a_replaced_recap_keeps_its_salted_identity(store: MemoryStore) -> None:
    _apply_recap(store, TEXT, seed="d")
    store.apply_reflection(
        session_id=CHAT, project_id=PROJECT, capture="auto",
        expected_fingerprint="sha256:" + "d" * 64,
        cursor=ReflectionCursor(4, "m-4", "sha256:" + "e" * 64, "inc_1", 2),
        proposals=(), recap="A later summary.", is_policy_stale=lambda: False,
    )
    assert sorted(_recaps(store)) == sorted([
        (TEXT, recap_text_digest(TEXT), "archived"),
        ("A later summary.", recap_text_digest("A later summary."), "active"),
    ])
