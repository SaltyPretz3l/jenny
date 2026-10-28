"""Conversation search (lexical and hybrid) and the bounded embed step."""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest

from sidecar.ai.conversations.search import embed_step, search_conversations
from sidecar.ai.conversations.store import ConversationStore
from tests.sidecar.ai.conversations.helpers import FakeClock, SynonymProvider, handle, session
from tests.sidecar.ai.semantic.fakes import unavailable


@pytest.fixture
def db(tmp_path: Path) -> Iterator[ConversationStore]:
    store = ConversationStore(tmp_path / "conversation-index.db")
    yield store
    store.close()


def _search(db: ConversationStore, query: str, **extra: object) -> dict:
    params: dict = {
        "query": query, "project_id": "project_general", "exclude_session_ids": [],
        "limit": 5, "embedder": None,
    }
    params.update(extra)
    return search_conversations(db, **params)


def test_lexical_search_with_the_embedder_off(db: ConversationStore) -> None:
    db.replace_session(session("s1", ["we picked postgres for the ledger", "ok"], title="DB"))
    db.replace_session(session("s2", ["the cat sat on the mat"]))

    result = _search(db, "Which database? postgres ledger")

    assert result["ok"] is True and result["mode"] == "lexical"
    assert "reason" not in result
    [hit] = result["hits"]
    assert set(hit) == {"session_id", "title", "message_id", "role", "created_at",
                        "snippet", "score"}
    assert (hit["session_id"], hit["title"], hit["message_id"], hit["role"]) == (
        "s1", "DB", "s1-m0", "user")
    assert "postgres" in hit["snippet"] and len(hit["snippet"]) <= 280


def test_scope_isolates_projects_and_excluded_sessions(db: ConversationStore) -> None:
    db.replace_session(session("mine", ["rocket launch plan"], project_id="p1"))
    db.replace_session(session("other", ["rocket launch plan"], project_id="p2"))
    db.replace_session(session("current", ["rocket launch plan"], project_id="p1"))

    hits = _search(db, "rocket", project_id="p1", exclude_session_ids=["current"])["hits"]

    assert [hit["session_id"] for hit in hits] == ["mine"]


def test_no_project_spans_every_project_and_still_excludes(db: ConversationStore) -> None:
    # Row 69: the primary chat's all_projects search passes project_id=None.
    db.replace_session(session("mine", ["rocket launch plan"], project_id="p1"))
    db.replace_session(session("other", ["rocket launch plan"], project_id="p2"))
    db.replace_session(session("current", ["rocket launch plan"], project_id="p1"))

    hits = _search(db, "rocket", project_id=None, exclude_session_ids=["current"])["hits"]

    assert sorted(hit["session_id"] for hit in hits) == ["mine", "other"]


def test_hybrid_search_spans_every_project_without_a_project(db: ConversationStore) -> None:
    provider = SynonymProvider()
    db.replace_session(session("s1", ["car trouble"], project_id="p1"))
    db.replace_session(session("s2", ["car trouble again"], project_id="p2"))
    embed_step(db, handle(provider), budget_seconds=2.0, batch=8)

    narrow = _search(db, "automobile", project_id="p1", embedder=handle(provider))
    wide = _search(db, "automobile", project_id=None, embedder=handle(provider))

    assert [hit["session_id"] for hit in narrow["hits"]] == ["s1"]
    assert sorted(hit["session_id"] for hit in wide["hits"]) == ["s1", "s2"]


def test_at_most_two_hits_per_session(db: ConversationStore) -> None:
    db.replace_session(session("busy", ["orbit one", "orbit two", "orbit three", "orbit four"]))
    db.replace_session(session("quiet", ["orbit five"]))

    hits = _search(db, "orbit", limit=10)["hits"]

    by_session = [hit["session_id"] for hit in hits]
    assert by_session.count("busy") == 2 and by_session.count("quiet") == 1


def test_limit_and_snippet_clip(db: ConversationStore) -> None:
    long_text = "needle " + "hay " * 600
    for name in ("a", "b", "c"):
        db.replace_session(session(name, [long_text[:2000]]))

    hits = _search(db, "needle", limit=2)["hits"]

    assert len(hits) == 2
    assert all(len(hit["snippet"]) <= 280 for hit in hits)


def test_hybrid_finds_a_paraphrase_the_words_miss(db: ConversationStore) -> None:
    provider = SynonymProvider()
    db.replace_session(session("s1", ["car trouble"]))
    db.replace_session(session("s2", ["lunch was tasty"]))
    assert embed_step(db, handle(provider), budget_seconds=2.0, batch=8)["embedded"] == 2

    lexical = _search(db, "automobile")
    hybrid = _search(db, "automobile", embedder=handle(provider))

    assert lexical["hits"] == []
    assert hybrid["mode"] == "hybrid"
    assert [hit["session_id"] for hit in hybrid["hits"]] == ["s1"]
    assert provider.calls[-1] == ["query: automobile"]


def test_hybrid_fuses_both_lists(db: ConversationStore) -> None:
    provider = SynonymProvider()
    db.replace_session(session("words", ["vehicle insurance renewal"]))
    db.replace_session(session("meaning", ["car car car"]))
    db.replace_session(session("noise", ["weather report"]))
    embed_step(db, handle(provider), budget_seconds=2.0, batch=8)

    hits = _search(db, "vehicle insurance", embedder=handle(provider))["hits"]

    assert [hit["session_id"] for hit in hits][:2] == ["words", "meaning"]
    assert hits[0]["score"] > hits[1]["score"] > 0


def test_embedder_failure_falls_back_to_lexical(db: ConversationStore) -> None:
    provider = SynonymProvider()
    db.replace_session(session("s1", ["vehicle notes"]))
    embed_step(db, handle(provider), budget_seconds=2.0, batch=8)
    provider.fail_with = unavailable()

    result = _search(db, "vehicle", embedder=handle(provider))

    assert (result["mode"], result["reason"]) == ("lexical", "embedder_unavailable")
    assert [hit["session_id"] for hit in result["hits"]] == ["s1"]


def test_vectors_of_another_model_are_ignored(db: ConversationStore) -> None:
    provider = SynonymProvider()
    db.replace_session(session("s1", ["my car broke down"]))
    embed_step(db, handle(provider, "model-a"), budget_seconds=2.0, batch=8)

    result = _search(db, "automobile", embedder=handle(provider, "model-b"))

    assert result["mode"] == "hybrid" and result["hits"] == []


def test_embed_step_respects_the_budget(db: ConversationStore) -> None:
    clock = FakeClock()
    provider = SynonymProvider(clock=clock, seconds_per_call=0.6)
    db.replace_session(session("s1", [f"message {n}" for n in range(6)], title="Plans"))

    result = embed_step(db, handle(provider), budget_seconds=1.0, batch=2, clock=clock)

    assert result == {"ok": True, "embedded": 4, "remaining": 2}
    assert provider.calls[0] == ["Plans | message 0", "Plans | message 1"]


def test_embed_step_switches_model_keys(db: ConversationStore) -> None:
    provider = SynonymProvider()
    db.replace_session(session("s1", ["one", "two", "three"]))
    embed_step(db, handle(provider, "model-a"), budget_seconds=2.0, batch=8)

    result = embed_step(db, handle(provider, "model-b"), budget_seconds=2.0, batch=2)

    assert result["embedded"] == 3 and result["remaining"] == 0
    assert db.vector_model_keys() == {"model-b": 3}
    assert db.index_state()["vector_count"] == 3


def test_embed_step_without_an_embedder(db: ConversationStore) -> None:
    db.replace_session(session("s1", ["one", "two"]))

    assert embed_step(db, None, budget_seconds=1.0, batch=4) == {
        "ok": True, "embedded": 0, "remaining": 2, "reason": "embedder_off"}


def test_embed_step_reports_an_embedder_failure(db: ConversationStore) -> None:
    provider = SynonymProvider()
    provider.fail_with = unavailable()
    db.replace_session(session("s1", ["one"]))

    result = embed_step(db, handle(provider), budget_seconds=1.0, batch=4)

    assert result == {"ok": True, "embedded": 0, "remaining": 1,
                      "reason": "embedder_unavailable"}
