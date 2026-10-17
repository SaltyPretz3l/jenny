"""W3 recap reads and chat-scope export/import through the real store."""
from pathlib import Path

import pytest

from sidecar.ai.memory.contracts import GENERAL_PROJECT_ID
from sidecar.ai.memory.service import MemoryService
from sidecar.ai.memory.store import MemoryStore
from sidecar.ai.memory.store_shared import RECAP_PROVENANCE

PROJECT = "project_alpha"


@pytest.fixture
def store(tmp_path: Path):
    instance = MemoryStore(tmp_path / "memory.db")
    yield instance
    instance.close()


def save(store, session, text, *, recap=False, project=PROJECT):
    return store.remember(operation_id=f"seed:{session}:{text[:20].replace(chr(32), chr(45))}", project_id=project,
        session_id=session, scope_session_id=session, text=text, kind="fact",
        origin="reflection" if recap else "user", provenance=RECAP_PROVENANCE if recap else "user_approved")


def test_recaps_follow_candidate_order_and_exact_project_and_active_status(store):
    save(store, "a", "Recap A", recap=True)
    save(store, "b", "Recap B", recap=True)
    save(store, "other", "Other project", recap=True, project="project_beta")
    save(store, "general", "General recap", recap=True, project=GENERAL_PROJECT_ID)
    old = save(store, "archived", "Archived recap", recap=True)
    store.forget(operation_id="forget:recap", project_id=PROJECT, memory_id=old.memory.id, expected_revision=1, origin="user")
    rows = store.recaps_for_sessions(project_id=PROJECT, session_ids=["b", "other", "general", "archived", "a"], limit=3)
    assert [(sid, text) for sid, text, _ in rows] == [("b", "Recap B"), ("a", "Recap A")]


def test_session_transfer_round_trips_without_user_origin_and_replay_imports_zero(store):
    save(store, "old", "Tea is green")
    save(store, "old", "We discussed tea", recap=True)
    exported = store.export_session("old")
    assert [(n["text"], n["kind"], n["origin"]) for n in exported["notes"]] == [("Tea is green", "fact", "user")]
    assert exported["recap"]["text"] == "We discussed tea"
    api = MemoryService(store).approved
    kwargs = dict(session_id="new", project_id=PROJECT, notes=exported["notes"], recap=exported["recap"]["text"])
    assert api.import_session(**kwargs) == {"status": "imported", "imported": 1, "skipped": 0}
    result = api.export_session("new")
    assert [(n["text"], n["kind"], n["origin"]) for n in result["notes"]] == [("Tea is green", "fact", "jenny")]
    assert result["recap"]["text"] == exported["recap"]["text"]
    assert api.import_session(**kwargs) == {"status": "imported", "imported": 0, "skipped": 1}
    store.purge_session("new")
    assert api.import_session(**kwargs) == {"status": "refused", "reason": "session_purged", "imported": 0, "skipped": 0}
    assert api.export_session("new") == {"notes": [], "recap": None}
    assert api.export_session("unknown") == {"notes": [], "recap": None}


def test_import_skips_suppressed_unsafe_invalid_kind_and_archived_project(store):
    row = save(store, "old", "Forgotten text")
    store.forget(operation_id="forget:note", project_id=PROJECT, memory_id=row.memory.id, expected_revision=1, origin="user")
    notes = [{"text": "Forgotten text", "kind": "fact"}, {"text": "sk-" + "x" * 80, "kind": "fact"}, {"text": "Unknown kind", "kind": "bogus"}, {"text": "A reflection note", "kind": "decision", "origin": "reflection"}]
    assert store.import_session(session_id="target", project_id=PROJECT, notes=notes) == {"status": "imported", "imported": 1, "skipped": 3}
    assert store.export_session("target")["notes"][0]["origin"] == "reflection"
    store.archive_project(PROJECT)
    assert store.import_session(session_id="archived", project_id=PROJECT, notes=notes)["reason"] == "project_archived"
    assert store.export_session("archived")["notes"] == []


def test_chat_sessions_includes_cursor_pending_archived_and_excludes_purged(store):
    from sidecar.ai.memory.store_reflection import ReflectionCursor
    store.apply_reflection(session_id="cursor-only", project_id=PROJECT, capture="auto", expected_fingerprint=None,
        cursor=ReflectionCursor(1, "m", "fingerprint", "inc", 1), proposals=[], recap="", is_policy_stale=lambda: False)
    save(store, "deleted", "Deleted note")
    store.purge_session("deleted")
    store.queue_candidate(session_id="pending", project_id=PROJECT, source_request_id="request", text="A pending note", kind="fact", origin="jenny")
    row = save(store, "archived", "Archived note")
    store.forget(operation_id="forget:archive", project_id=PROJECT, memory_id=row.memory.id, expected_revision=1, origin="user")
    api = MemoryService(store).approved
    assert api.chat_sessions() == {"session_ids": ["archived", "cursor-only", "pending"], "truncated": False}
    assert api.chat_sessions(limit=1) == {"session_ids": ["archived"], "truncated": True}


def test_chat_sessions_lists_sources_of_shared_rows_that_keep_their_source(store):
    for session, excerpt in (("shared-src", "said so"), ("bare", ""), ("gone", "said too")):
        store.remember(operation_id=f"seed:{session}", project_id=PROJECT, session_id=session,
            text=f"A shared note from {session}", kind="fact", origin="user", source_excerpt=excerpt)
    store.purge_session("gone")
    assert MemoryService(store).approved.chat_sessions()["session_ids"] == ["shared-src"]
