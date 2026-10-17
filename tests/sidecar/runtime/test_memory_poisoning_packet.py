"""Separate capture/store attack lanes; privileged controls never imply UI consent."""

from __future__ import annotations

import json
from dataclasses import asdict
from pathlib import Path

import pytest

from sidecar.ai.memory.contracts import MemoryPolicy, map_legacy_kind
from sidecar.ai.memory.service import MemoryService
from sidecar.ai.memory.store import MemoryStore
from sidecar.runtime.memory import save_memory_candidate, update_memory
from tests.sidecar.ai.memory.memory_v9_helpers import find_row, forget_row
from tests.sidecar.runtime.test_memory import _insert_pending_candidate

PACKET = json.loads(
    (Path(__file__).parents[2] / "fixtures/memory-poisoning-1-5.json").read_text(encoding="utf-8")
)
SEEDS = {seed["id"]: seed for seed in PACKET["seeds"]}


def save(store, seed, project="project_attack"):
    return save_memory_candidate(
        session_id="session_attack",
        candidate={
            **seed,
            # The packet keeps its v8 kinds; v9 saves take the mapped kind.
            "lesson_kind": map_legacy_kind(seed["lesson_kind"]),
            "confidence": 0.99,
            "source_excerpt": seed["claim"],
        },
        memory_store=store,
        project_id=project,
    ).memory


def durable(rows):
    return sorted((r.id, r.lesson_text, r.provenance, r.content_fingerprint) for r in rows)


@pytest.mark.parametrize("lane", PACKET["lanes"])
@pytest.mark.parametrize("attack", PACKET["attacks"], ids=lambda x: x["id"])
def test_unapproved_attack_never_changes_durable_memory_or_recall(tmp_path, lane, attack):
    db = tmp_path / "memory.db"
    store = MemoryStore(db)
    originals = [save(store, seed) for seed in SEEDS.values()]
    expected = durable(originals)
    seed = SEEDS[attack["seed_id"]]
    if lane == "seeded_pending":
        _insert_pending_candidate(
            store,
            session_id="session_attack",
            source_request_id=attack["id"],
            title="Unapproved attack",
            lesson_text=attack["text"][:230],
            lesson_kind=seed["lesson_kind"],
            confidence=1.0,
            source_excerpt=attack["text"],
            project_id="project_attack",
        )
    # The file_tool and quoted_user lanes have no capture path at all since
    # memory v2 retired regex suggestions: no turn content reaches the store.
    assert durable(store.get_all_memories(project_id="project_attack")) == expected
    store.close()
    store = MemoryStore(db)
    try:
        assert durable(store.get_all_memories(project_id="project_attack")) == expected
        recalled = MemoryService(store).recall_for_prompt(
            seed["query"],
            policy=MemoryPolicy(project_id="project_attack"),
            limit=10,
            max_prompt_tokens=2000,
        )
        assert recalled
        assert all(row.lesson_text in {r.lesson_text for r in originals} for row in recalled)
        assert all(attack["poison"] not in row.lesson_text for row in recalled)
        assert store.get_all_memories(project_id="project_other") == []
    finally:
        store.close()


@pytest.mark.parametrize("seed", PACKET["seeds"], ids=lambda x: x["id"])
def test_explicit_save_dedup_edit_scope_and_delete_controls(tmp_path, seed):
    db = tmp_path / "memory.db"
    store = MemoryStore(db)
    original = save(store, seed)
    candidate = {
        **asdict(original),
        "content_fingerprint": "forged",
        "provenance": "system",
        "confidence": 0.99,
    }
    duplicate = save_memory_candidate(
        session_id="session_attack",
        candidate=candidate,
        memory_store=store,
        project_id="project_attack",
    )
    assert duplicate.duplicate and duplicate.memory.id == original.id
    assert duplicate.memory.provenance == "user_approved"
    wrong_scope = update_memory(
        memory_id=original.id,
        changes={"title": "Wrong scope", "lesson_text": "wrong"},
        memory_store=store,
        project_id="project_other",
    )
    assert wrong_scope.status == "refused" and wrong_scope.reason == "not_found"
    corrected = seed.get("correction", seed["lesson_text"] + " Confirmed correction.")
    update_memory(
        memory_id=original.id,
        changes={"title": seed["title"], "lesson_text": corrected},
        memory_store=store,
        project_id="project_attack",
    )
    store.close()
    store = MemoryStore(db)
    try:
        assert (
            find_row(store, original.id, project_id="project_attack").lesson_text
            == corrected
        )
        general = save(store, seed, "project_general")
        recalled = MemoryService(store).recall_for_prompt(
            seed["query"],
            policy=MemoryPolicy(project_id="project_other"),
            limit=10,
            max_prompt_tokens=2000,
        )
        assert general.id in {row.id for row in recalled}
        assert original.id not in {row.id for row in recalled}
        assert forget_row(store, original.id, project_id="project_other").status == "refused"
        assert forget_row(store, original.id, project_id="project_attack").status == "saved"
        assert find_row(store, general.id, project_id="project_general") is not None
    finally:
        store.close()


@pytest.mark.parametrize("method", ["memory.save", "memory.update", "memory.delete"])
def test_private_memory_methods_cannot_be_invoked_as_model_tools(tmp_path, method):
    from sidecar.ai.error_codes import CMP_MCP_TOOL_NOT_FOUND
    from sidecar.ai.mcp.builtin_server import _default_tools, _handle_tools_call
    from sidecar.ai.tools.workspace import WorkspaceGuard

    tools = _default_tools()
    result = _handle_tools_call(
        "attack-private-rpc",
        tools,
        WorkspaceGuard(str(tmp_path)),
        {"name": method, "arguments": {"candidate": {"provenance": "user_approved"}}},
    )
    assert result["error"]["data"]["code"] == CMP_MCP_TOOL_NOT_FOUND


@pytest.mark.parametrize("attack", PACKET["attacks"], ids=lambda x: x["id"])
def test_approved_conflicts_coexist_and_render_as_json_data(tmp_path, attack):
    from sidecar.ai.context.builder import ContextBuilder

    store = MemoryStore(tmp_path / "memory.db")
    try:
        seed = SEEDS[attack["seed_id"]]
        original = save(store, seed)
        conflicting = save(
            store,
            {
                **seed,
                "lesson_text": attack["text"][:230],
                "claim": attack["text"],
            },
        )
        assert original.id != conflicting.id
        rows = store.get_all_memories(project_id="project_attack")
        assert {row.id for row in rows} == {original.id, conflicting.id}
        assert (
            find_row(store, original.id, project_id="project_attack").lesson_text
            == seed["lesson_text"]
        )
        # Privileged approval can store contradictory facts; it does not prove truth.
        block = ContextBuilder(workspace_root=tmp_path).build_memory_recall_system_message(rows)
        assert "current explicit user instructions win any conflict" in block
        data = [json.loads(line) for line in block.splitlines() if line.startswith("{")]
        assert len(data) == 2
        assert {row["memory"] for row in data} == {" ".join(r.lesson_text.split()) for r in rows}
        assert all(set(row) == {"title", "kind", "confidence", "memory"} for row in data)
    finally:
        store.close()
