"""memory.erase, memory.operations, memory.embed_step, status fields and the archived list
over a real store (row 58 W4 S-MEM)."""

from __future__ import annotations

import logging
from collections.abc import Iterator
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

import sidecar.runtime.request_dispatch_memory as rdm
from sidecar.ai.memory.service import MemoryService
from sidecar.ai.memory.store import MemoryStore
from sidecar.protocol import (
    API_VERSION,
    INBOUND_VERSIONED_REQUEST_METHODS,
    MEMORY_EMBED_STEP_METHOD,
    MEMORY_ERASE_METHOD,
    MEMORY_OPERATIONS_METHOD,
)
from sidecar.runtime.server_auxiliary_workers import (
    AUXILIARY_FAMILY_BY_METHOD,
    DEFAULT_MAX_WORKERS_BY_FAMILY,
)
from tests.sidecar.ai.memory.fake_embedder import FakeEmbedder

LOGGER = logging.getLogger("test.request_dispatch_memory_settings")
PROJECT = "project_alpha"
INVALID_PARAMS = -32602


class _Rpc:
    def __init__(self, tmp_path: Path, *, hybrid: bool = True, embedder: Any = None) -> None:
        self.store = MemoryStore(tmp_path / "memory.db")
        self.service = MemoryService(
            self.store, hybrid_recall_enabled=hybrid, embedder_source=lambda: embedder
        )
        self.brain = SimpleNamespace(stack=SimpleNamespace(memory_service=self.service))

    def response(self, method: str, **params: Any) -> dict[str, Any]:
        outcome = rdm.process_memory_method(
            method, 7, {"accept_version": API_VERSION, **params}, True, self.brain, LOGGER
        )
        assert outcome is not None
        return outcome.response

    def result(self, method: str, **params: Any) -> dict[str, Any]:
        response = self.response(method, **params)
        assert "error" not in response, response
        return response["result"]

    def save(self, text: str, **params: Any) -> dict[str, Any]:
        return self.result(
            "memory.save", session_id="s-1", project_id=PROJECT,
            candidate={"lesson_text": text, "lesson_kind": "preference"}, **params,
        )


@pytest.fixture
def rpc(tmp_path: Path) -> Iterator[_Rpc]:
    harness = _Rpc(tmp_path, embedder=FakeEmbedder())
    try:
        yield harness
    finally:
        harness.store.close()


def test_new_methods_are_versioned_and_embed_step_runs_on_its_own_worker() -> None:
    assert (MEMORY_ERASE_METHOD, MEMORY_OPERATIONS_METHOD, MEMORY_EMBED_STEP_METHOD) == (
        "memory.erase", "memory.operations", "memory.embed_step",
    )
    for method in (MEMORY_ERASE_METHOD, MEMORY_OPERATIONS_METHOD, MEMORY_EMBED_STEP_METHOD):
        assert method in INBOUND_VERSIONED_REQUEST_METHODS
    assert AUXILIARY_FAMILY_BY_METHOD[MEMORY_EMBED_STEP_METHOD] == "memory_index"
    assert DEFAULT_MAX_WORKERS_BY_FAMILY["memory_index"] == 1
    assert MEMORY_ERASE_METHOD not in AUXILIARY_FAMILY_BY_METHOD
    assert MEMORY_OPERATIONS_METHOD not in AUXILIARY_FAMILY_BY_METHOD


def test_erase_hard_deletes_one_row_and_reports_not_found_after(rpc: _Rpc) -> None:
    memory_id = rpc.save("Prefers tabs.")["memory"]["id"]

    assert rpc.result(MEMORY_ERASE_METHOD, project_id=PROJECT, memory_id=memory_id) == {
        "api_version": API_VERSION, "status": "erased",
    }
    assert rpc.result(MEMORY_ERASE_METHOD, project_id=PROJECT, memory_id=memory_id)[
        "status"
    ] == "not_found"
    assert rpc.store._connection.execute("SELECT COUNT(*) FROM memories").fetchone() == (0,)
    for bad in ({"memory_id": memory_id}, {"project_id": PROJECT, "memory_id": "x"},
                {"project_id": PROJECT, "memory_id": True}, {"project_id": "nope", "memory_id": 1}):
        assert rpc.response(MEMORY_ERASE_METHOD, **bad)["error"]["code"] == INVALID_PARAMS


def test_operations_lists_content_free_rows_with_the_undo_rule(rpc: _Rpc) -> None:
    first = rpc.save("Prefers tabs.")
    second = rpc.save("Uses pytest.")
    forgotten = rpc.result(
        "memory.delete", project_id=PROJECT, memory_id=second["memory"]["id"]
    )
    rpc.result(
        "memory.update", project_id=PROJECT, memory_id=first["memory"]["id"],
        lesson_text="Prefers spaces.",
    )

    result = rpc.result(MEMORY_OPERATIONS_METHOD, project_id=PROJECT)
    operations = result["operations"]

    assert [set(item) for item in operations] == [{
        "operation_id", "op", "origin", "memory_id", "result_revision", "created_at",
        "expires_at", "undone_at", "undoable",
    }] * 4
    by_id = {item["operation_id"]: item for item in operations}
    assert by_id[forgotten["operation_id"]]["op"] == "forget"
    assert by_id[forgotten["operation_id"]]["undoable"] is True
    # The remember of the edited row moved on (revision 2): undo would conflict.
    assert by_id[first["operation_id"]]["undoable"] is False
    # The remember of the forgotten row: the row is archived now, so not undoable.
    assert by_id[second["operation_id"]]["undoable"] is False
    serialized = repr(result)
    assert "tabs" not in serialized and "pytest" not in serialized

    rpc.result("memory.undo", project_id=PROJECT, operation_id=forgotten["operation_id"])
    after = {item["operation_id"]: item for item in rpc.result(
        MEMORY_OPERATIONS_METHOD, project_id=PROJECT, limit=50)["operations"]}
    assert after[forgotten["operation_id"]]["undoable"] is False
    assert after[forgotten["operation_id"]]["undone_at"] is not None
    assert len(rpc.result(MEMORY_OPERATIONS_METHOD, project_id=PROJECT, limit=1)[
        "operations"]) == 1
    for bad in ({}, {"project_id": PROJECT, "limit": 0}, {"project_id": PROJECT, "limit": 51},
                {"project_id": PROJECT, "limit": True}):
        assert rpc.response(MEMORY_OPERATIONS_METHOD, **bad)["error"]["code"] == INVALID_PARAMS


def test_status_gains_hybrid_vectors_and_the_always_on_budget(rpc: _Rpc) -> None:
    rpc.save("Prefers tabs.")
    rpc.result(MEMORY_EMBED_STEP_METHOD)
    status = rpc.result("memory.status", project_id=PROJECT)
    assert status["recall_hybrid"] == "on"
    assert status["vector_count"] == 1
    assert status["always_on_budget"] == {
        "budget_chars": 1200, "heading_reserve": 144, "row_overhead": 16,
    }


def test_embed_step_validates_its_bounds_and_returns_the_step_result(rpc: _Rpc) -> None:
    rpc.save("Prefers tabs.")
    rpc.save("Uses pytest.")
    assert rpc.result(MEMORY_EMBED_STEP_METHOD, budget_seconds=1.0, batch=1) == {
        "api_version": API_VERSION, "ok": True, "embedded": 2, "remaining": 0,
    }
    for bad in ({"budget_seconds": 0.05}, {"budget_seconds": 5.5}, {"batch": 0},
                {"batch": 33}, {"batch": 1.5}, {"budget_seconds": True}, {"budget_seconds": "1"}):
        assert rpc.response(MEMORY_EMBED_STEP_METHOD, **bad)["error"]["code"] == INVALID_PARAMS


def test_embed_step_with_the_flag_off_says_so(tmp_path: Path) -> None:
    harness = _Rpc(tmp_path, hybrid=False, embedder=FakeEmbedder())
    try:
        assert harness.result(MEMORY_EMBED_STEP_METHOD) == {
            "api_version": API_VERSION, "ok": True, "embedded": 0, "remaining": 0,
            "reason": "hybrid_off",
        }
        assert harness.result("memory.status", project_id=PROJECT)["recall_hybrid"] == "off"
    finally:
        harness.store.close()


def test_archived_list_pages_one_project(rpc: _Rpc) -> None:
    kept = rpc.save("Prefers tabs.")["memory"]["id"]
    forgotten = rpc.save("Uses pytest.")["memory"]["id"]
    other = rpc.result(
        "memory.save", session_id="s-1", project_id="project_beta",
        candidate={"lesson_text": "Beta note.", "lesson_kind": "fact"},
    )["memory"]["id"]
    rpc.result("memory.delete", project_id=PROJECT, memory_id=forgotten)
    rpc.result("memory.delete", project_id="project_beta", memory_id=other)

    page = rpc.result("memory.list", status="archived", scope="project", project_id=PROJECT)

    assert [row["id"] for row in page["memories"]] == [forgotten]
    assert page["memories"][0]["status"] == "archived"
    assert page["next_cursor"] is None
    assert kept not in [row["id"] for row in page["memories"]]
    assert rpc.response(
        "memory.list", status="archived", scope="all", project_id=PROJECT
    )["error"]["code"] == INVALID_PARAMS
