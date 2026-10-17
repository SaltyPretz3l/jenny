"""memory.apply's store transaction, the reflection cursor and recap rows (row 58 W2)."""

from __future__ import annotations

import hashlib
import json
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

from sidecar.ai.memory.contracts import MemoryPolicy, RecentChat
from sidecar.ai.memory.reflection_checks import check_reflection_output
from sidecar.ai.memory.reflection_epochs import PolicyEpochFence
from sidecar.ai.memory.service import MemoryService
from sidecar.ai.memory.store import MemoryStore
from sidecar.ai.memory.store_reflection import (
    RECAP_PROVENANCE,
    ReflectionCursor,
    ReflectionItem,
)
from tests.sidecar.ai.memory.memory_v9_helpers import (
    PROJECT,
    WallClock,
    forget_row,
    operation_count,
    pending_rows,
    remember,
    saved_id,
    suppression_count,
)

CHAT = "sess_1_abc"


def _fp(seed: str) -> str:
    return "sha256:" + hashlib.sha256(seed.encode()).hexdigest()


FP1, FP2 = _fp("one"), _fp("two")


@pytest.fixture
def store(tmp_path: Path) -> Iterator[MemoryStore]:
    memory_store = MemoryStore(tmp_path / "memory.db", clock=WallClock())
    try:
        yield memory_store
    finally:
        memory_store.close()


def _cursor(fingerprint: str = FP1, count: int = 4) -> ReflectionCursor:
    return ReflectionCursor(
        message_count=count,
        last_message_id=f"m-{count}",
        window_fingerprint=fingerprint,
        session_incarnation="inc_abc123",
        turn_generation=3,
    )


ITEMS = (
    ReflectionItem(text="Prefers tabs over spaces.", kind="preference", source_message_id="m-1"),
    ReflectionItem(text="Sister Ana lives in Lisbon.", kind="person", source_message_id="m-3"),
)


def _apply(store: MemoryStore, **overrides: Any) -> dict[str, Any]:
    params: dict[str, Any] = {
        "session_id": CHAT,
        "project_id": PROJECT,
        "capture": "auto",
        "expected_fingerprint": None,
        "cursor": _cursor(),
        "proposals": ITEMS,
        "recap": "A chat about Python formatting.",
        "is_policy_stale": lambda: False,
    }
    params.update(overrides)
    return store.apply_reflection(**params)


def _rows(store: MemoryStore) -> list[tuple[Any, ...]]:
    return store._connection.execute(
        "SELECT id, origin, provenance, status, scope_session_id, source_message_ids, lesson_text"
        " FROM memories ORDER BY id"
    ).fetchall()


def _cursor_row(store: MemoryStore) -> tuple[Any, ...] | None:
    return store._connection.execute(
        "SELECT * FROM memory_reflection_cursor WHERE session_id = ?", (CHAT,)
    ).fetchone()


def test_apply_writes_reflection_rows_with_ledger_operations_and_moves_the_cursor(
    store: MemoryStore,
) -> None:
    result = _apply(store)

    assert result["status"] == "applied" and "reason" not in result
    assert result["queued"] == 0 and result["skipped"] == 0
    saved = result["saved"]
    assert [item["operation_id"] for item in saved] == [
        f"reflect:{CHAT}:{FP1[7:23]}:0", f"reflect:{CHAT}:{FP1[7:23]}:1"
    ]
    assert [item["kind"] for item in saved] == ["preference", "person"]
    assert saved[0]["text_preview"] == "Prefers tabs over spaces."
    assert all(item["undoable"] is True for item in saved)
    rows = {row[6]: row for row in _rows(store)}
    tabs = rows["Prefers tabs over spaces."]
    assert tabs[1:6] == ("reflection", "reflection", "active", "", '["m-1"]')
    recap = rows["A chat about Python formatting."]
    assert recap[1:5] == ("reflection", RECAP_PROVENANCE, "active", CHAT)
    state = store.reflection_state(CHAT)
    assert state == {
        "cursor": {
            "project_id": PROJECT,
            "message_count": 4,
            "last_message_id": "m-4",
            "window_fingerprint": FP1,
            "session_incarnation": "inc_abc123",
            "turn_generation": 3,
            "updated_at": state["cursor"]["updated_at"],
        },
        "purged": False,
    }
    undone = store.undo(
        operation_id=saved[0]["operation_id"], undo_operation_id="undo-1", project_id=PROJECT
    )
    assert undone.status == "saved"


def test_reflection_state_is_empty_before_and_purged_after_a_chat_delete(
    store: MemoryStore,
) -> None:
    assert store.reflection_state(CHAT) == {"cursor": None, "purged": False}
    _apply(store)

    store.purge_session(CHAT)

    assert store.reflection_state(CHAT) == {"cursor": None, "purged": True}


def test_a_replayed_apply_writes_nothing_new(store: MemoryStore) -> None:
    _apply(store)
    rows, operations = _rows(store), operation_count(store)

    stale = _apply(store)
    same_window = _apply(store, expected_fingerprint=FP1)

    assert stale == {"status": "refused", "reason": "cursor_moved", "saved": [], "queued": 0,
                     "skipped": 0}
    assert same_window["status"] == "applied"
    assert same_window["saved"] == [] and same_window["skipped"] == 2
    assert _rows(store) == rows
    assert operation_count(store) == operations


@pytest.mark.parametrize("reason", ["session_purged", "project_archived", "policy_stale",
                                    "cursor_moved"])
def test_every_fence_refusal_rolls_back_everything(store: MemoryStore, reason: str) -> None:
    _apply(store, proposals=(), recap="")
    before_cursor = _cursor_row(store)
    overrides: dict[str, Any] = {"expected_fingerprint": FP1, "cursor": _cursor(FP2, 6)}
    if reason == "session_purged":
        store.purge_session(CHAT)
        before_cursor = None
    elif reason == "project_archived":
        store.archive_project(PROJECT)
    elif reason == "policy_stale":
        overrides["is_policy_stale"] = lambda: True
    else:
        overrides["expected_fingerprint"] = _fp("elsewhere")
    rows, operations = _rows(store), operation_count(store)

    result = _apply(store, **overrides)

    assert result == {"status": "refused", "reason": reason, "saved": [], "queued": 0,
                      "skipped": 0}
    assert _rows(store) == rows
    assert operation_count(store) == operations
    assert _cursor_row(store) == before_cursor
    assert pending_rows(store, project_id=PROJECT) == []


def test_ask_capture_queues_pending_candidates_with_origin_reflection(store: MemoryStore) -> None:
    result = _apply(store, capture="ask", recap="")

    assert result["status"] == "applied"
    assert result["saved"] == [] and result["queued"] == 2 and result["skipped"] == 0
    pending = pending_rows(store, project_id=PROJECT, session_id=CHAT)
    assert sorted(row.lesson_text for row in pending) == [
        "Prefers tabs over spaces.", "Sister Ana lives in Lisbon."
    ]
    assert {row.origin for row in pending} == {"reflection"}
    assert _rows(store) == []
    again = _apply(store, capture="ask", recap="", expected_fingerprint=FP1)
    assert again["queued"] == 0 and again["skipped"] == 2


def test_suppressed_duplicate_and_unsafe_items_are_skipped_not_failures(
    store: MemoryStore,
) -> None:
    forgotten = saved_id(remember(store, "Prefers tabs over spaces.", origin="user"))
    forget_row(store, forgotten, project_id=PROJECT)
    remember(store, "Sister Ana lives in Lisbon.", origin="user")
    items = (*ITEMS, ReflectionItem(text="Key is sk-abcdefghijklmnop", kind="fact",
                                    source_message_id="m-1"),
             ReflectionItem(text="Rides a red bike daily.", kind="routine",
                            source_message_id="m-3"))

    result = _apply(store, proposals=items, recap="")

    assert result["status"] == "applied"
    assert result["skipped"] == 3
    assert [item["text_preview"] for item in result["saved"]] == ["Rides a red bike daily."]


def test_recap_replace_archives_the_old_recap_without_a_suppression(store: MemoryStore) -> None:
    _apply(store, proposals=(), recap="First recap of the chat.")
    operations = operation_count(store)

    _apply(store, proposals=(), recap="Second recap of the chat.",
           expected_fingerprint=FP1, cursor=_cursor(FP2, 6))

    recaps = [row for row in _rows(store) if row[2] == RECAP_PROVENANCE]
    assert [(row[3], row[6]) for row in recaps] == [
        ("archived", "First recap of the chat."), ("active", "Second recap of the chat."),
    ]
    assert suppression_count(store) == 0
    assert operation_count(store) == operations + 1
    blank = _apply(store, proposals=(), recap="", expected_fingerprint=FP2,
                   cursor=_cursor(_fp("three"), 8))
    assert blank["status"] == "applied"
    # A blank recap keeps the chat's current one.
    assert [(row[3], row[6]) for row in _rows(store) if row[2] == RECAP_PROVENANCE] == [
        ("archived", "First recap of the chat."), ("active", "Second recap of the chat."),
    ]


def test_recap_rows_are_hidden_from_every_listing_and_recall(store: MemoryStore) -> None:
    _apply(store, proposals=(), recap="Recap mentioning zebras and Lisbon.")
    remember(store, "Zebras live in Lisbon zoo.", origin="user", scope_session_id=CHAT)
    service = MemoryService(store)

    def texts(rows: list[Any]) -> list[str]:
        return [row.lesson_text for row in rows]

    active, _ = store.list_active(project_id=PROJECT, scope_session_id=CHAT)
    recalled = store.recall_memories(
        "zebras Lisbon", project_id=PROJECT, include_general=True, scope_session_id=CHAT
    )
    prompt = service.recall_for_prompt(
        "zebras Lisbon", policy=MemoryPolicy(project_id=PROJECT), scope_session_id=CHAT
    )
    page, _ = store.get_memories_page(limit=50, project_id=PROJECT)
    assert texts(active) == ["Zebras live in Lisbon zoo."]
    assert store.status_snapshot(project_id=PROJECT)["counts"]["active"] == 1  # type: ignore[index]
    assert texts(recalled) == ["Zebras live in Lisbon zoo."]
    assert "Recap mentioning zebras and Lisbon." not in texts(prompt)
    assert "Recap mentioning zebras and Lisbon." not in texts(page)
    assert "Recap mentioning zebras and Lisbon." not in texts(
        store.get_all_memories(project_id=PROJECT)
    )
    _apply(store, proposals=(), recap="", expected_fingerprint=FP1, cursor=_cursor(FP2))
    archived, _ = store.list_archived(project_id=PROJECT, scope_session_id=CHAT)
    assert texts(archived) == []


def test_dedupe_rows_cover_the_project_and_general_without_recaps(store: MemoryStore) -> None:
    remember(store, "Project fact one.", origin="user")
    remember(store, "General fact one.", origin="user", project_id="project_general")
    remember(store, "Other project fact.", origin="user", project_id="project_beta")
    _apply(store, proposals=(), recap="Recap text here.")

    rows = store.reflection_dedupe_rows(project_id=PROJECT, limit=200)

    assert sorted(text for _digest, text in rows) == ["General fact one.", "Project fact one."]
    assert len(store.reflection_dedupe_rows(project_id=PROJECT, limit=1)) == 1


def test_policy_epoch_fence_tracks_the_max_per_source() -> None:
    fence = PolicyEpochFence(max_sources=2)

    assert fence.observe("a", 3) == 3
    assert fence.observe("a", 1) == 3
    assert fence.is_stale("a", 2) is True
    assert fence.is_stale("a", 3) is False
    assert fence.is_stale("b", 0) is False
    fence.observe("b", 1)
    fence.observe("c", 1)
    assert fence.is_stale("a", 0) is False  # evicted: a new source starts fresh


@pytest.mark.parametrize("capture", ["auto", "ask"])
def test_chat_reflection_notes_are_private_and_never_queued(
    store: MemoryStore, capture: str,
) -> None:
    chat_text = "Tried the parser migration with tabs."
    items = (ReflectionItem(text=chat_text, kind="decision", source_message_id="m-1",
                            scope="chat"), ITEMS[1])
    result = _apply(store, proposals=items, capture=capture, recap="")

    assert result["status"] == "applied"
    if capture == "ask":
        assert result["saved"] == [] and result["queued"] == 1 and result["skipped"] == 1
        assert [row.lesson_text for row in pending_rows(store, project_id=PROJECT)] == [
            ITEMS[1].text
        ]
        assert _rows(store) == []
        return
    assert result["queued"] == 0 and result["skipped"] == 0
    assert [item["scope"] for item in result["saved"]] == ["chat", "project"]
    rows = {row[6]: row for row in _rows(store)}
    assert rows[chat_text][1:6] == ("reflection", "reflection", "active", CHAT, '["m-1"]')
    assert rows[ITEMS[1].text][4] == ""
    for session, expected in [(CHAT, True), ("another-chat", False)]:
        recalled = store.recall_memories(
            "parser migration tabs", project_id=PROJECT, scope_session_id=session
        )
        assert (chat_text in [row.lesson_text for row in recalled]) is expected


def test_chat_dedupe_rows_drop_own_active_note_and_exclude_other_chat_state(
    store: MemoryStore,
) -> None:
    text = "Tried the parser migration with tabs."
    remember(store, text, origin="user", scope_session_id=CHAT)
    remember(store, "Other chat parser notes.", origin="user", scope_session_id="other")
    archived_result = remember(store, "Archived parser notes.", origin="user", scope_session_id=CHAT)
    archived = saved_id(archived_result)
    store.undo(operation_id=archived_result.operation_id,
               undo_operation_id="undo-chat-seed", project_id=PROJECT)
    assert archived not in [row.id for row in store.recall_memories(
        "parser", project_id=PROJECT, scope_session_id=CHAT
    )]
    _apply(store, proposals=(), recap="Parser recap is not a note.")
    rows = store.reflection_dedupe_rows(project_id=PROJECT, scope_session_id=CHAT)
    assert [content for _digest, content in rows] == [text]
    raw = json.dumps({"memories": [{"text": text, "kind": "decision", "from": 0,
                                   "scope": "chat"}], "recap": ""})
    own = check_reflection_output(raw, new_user_messages=[("m-1", text)],
                                  is_suppressed=lambda _: False, existing_rows=rows)
    other = check_reflection_output(
        raw, new_user_messages=[("m-1", text)], is_suppressed=lambda _: False,
        existing_rows=store.reflection_dedupe_rows(project_id=PROJECT, scope_session_id="other"),
    )
    assert own.proposals == [] and own.dropped["duplicate"] == 1
    assert len(other.proposals) == 1 and other.proposals[0].scope == "chat"


def test_w3_gate_delete_purge_leaves_nothing_to_recall(store: MemoryStore) -> None:
    """Row 58 W3 gate: delete -> purge -> no recall of the chat's notes or recap."""

    note = ReflectionItem(
        text="Working on the parser rewrite in this chat.", kind="decision",
        source_message_id="m-1", scope="chat",
    )
    assert _apply(store, proposals=(note,))["status"] == "applied"
    service = MemoryService(store)
    other = "sess_2_other"
    policy = MemoryPolicy(project_id=PROJECT, recent_chats=(RecentChat(CHAT, "Parser"),))

    memories, _ = service.recall_for_prompt_with_recaps(
        "parser rewrite", policy=policy, scope_session_id=CHAT
    )
    assert [memory.lesson_text for memory in memories] == [note.text]
    _, recaps = service.recall_for_prompt_with_recaps(
        "parser rewrite", policy=policy, scope_session_id=other
    )
    assert [recap.text for recap in recaps] == ["A chat about Python formatting."]

    store.purge_session(CHAT)

    memories, _ = service.recall_for_prompt_with_recaps(
        "parser rewrite", policy=policy, scope_session_id=CHAT
    )
    _, recaps = service.recall_for_prompt_with_recaps(
        "parser rewrite", policy=policy, scope_session_id=other
    )
    assert (memories, recaps) == ([], [])
    assert store.reflection_state(CHAT) == {"cursor": None, "purged": True}
    assert _apply(store, expected_fingerprint=None)["status"] == "refused"


def test_w3_gate_branch_session_has_no_cursor(store: MemoryStore) -> None:
    """Row 58 W3 gate: a branch is a new session id, so it starts with no cursor."""

    assert _apply(store)["status"] == "applied"
    assert store.reflection_state(CHAT)["cursor"] is not None
    assert store.reflection_state("sess_branch_of_1") == {"cursor": None, "purged": False}
