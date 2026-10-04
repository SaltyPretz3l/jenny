"""memory.move_project: the desktop's project delete moves memories to General."""

from __future__ import annotations

import logging
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import sidecar.runtime.request_dispatch_memory as rdm
from sidecar.ai.memory.contracts import GENERAL_PROJECT_ID
from sidecar.ai.memory.service import MemoryService
from sidecar.ai.memory.store import MemoryStore
from sidecar.ai.memory.unavailable import UnavailableMemoryStore
from sidecar.protocol import (
    API_VERSION,
    INBOUND_VERSIONED_REQUEST_METHODS,
    MEMORY_MOVE_PROJECT_METHOD,
)

LOGGER = logging.getLogger("test.request_dispatch_memory_move")


def _run(service: Any, params: Any, message_id: Any = 7):
    return rdm.process_memory_method(
        method=MEMORY_MOVE_PROJECT_METHOD,
        message_id=message_id,
        params=params,
        initialized=True,
        brain_container=SimpleNamespace(
            stack=SimpleNamespace(memory_service=service, memory_store=None)
        ),
        logger=LOGGER,
    )


def test_method_is_versioned_and_named() -> None:
    assert MEMORY_MOVE_PROJECT_METHOD == "memory.move_project"
    assert MEMORY_MOVE_PROJECT_METHOD in INBOUND_VERSIONED_REQUEST_METHODS


def test_move_project_moves_rows_and_reports_counts(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "memory.db")
    try:
        store.save_memory(
            session_id="session-1",
            title="Preference: tea",
            lesson_text="The user prefers tea.",
            lesson_kind="preference",
            confidence=0.9,
            source_excerpt="tea",
            project_id="project_alpha",
        )
        outcome = _run(
            MemoryService(store),
            {
                "accept_version": API_VERSION,
                "project_id": "project_alpha",
                "target_project_id": GENERAL_PROJECT_ID,
            },
        )
        assert outcome is not None
        result = outcome.response["result"]
        assert {key: result[key] for key in ("moved", "merged", "pending_moved")} == {
            "moved": 1,
            "merged": 0,
            "pending_moved": 0,
        }
        assert store.status_snapshot()["counts"]["approved"] == 1
    finally:
        store.close()


def test_move_project_rejects_bad_params_and_version(tmp_path: Path) -> None:
    store = MemoryStore(tmp_path / "memory.db")
    try:
        service = MemoryService(store)
        missing_target = _run(
            service, {"accept_version": API_VERSION, "project_id": "project_alpha"}
        )
        assert missing_target is not None
        assert missing_target.response["error"]["code"] == rdm.INVALID_PARAMS_CODE
        general_source = _run(
            service,
            {
                "accept_version": API_VERSION,
                "project_id": GENERAL_PROJECT_ID,
                "target_project_id": "project_alpha",
            },
        )
        assert general_source is not None
        assert general_source.response["error"]["code"] == rdm.INVALID_PARAMS_CODE
        wrong_version = _run(
            service,
            {
                "accept_version": "1999-01-01",
                "project_id": "project_alpha",
                "target_project_id": GENERAL_PROJECT_ID,
            },
        )
        assert wrong_version is not None
        assert "error" in wrong_version.response
    finally:
        store.close()


def test_move_project_reports_an_unavailable_store_as_failed(tmp_path: Path) -> None:
    service = MemoryService(
        UnavailableMemoryStore.from_failure(tmp_path / "broken.db", RuntimeError("boom"))
    )
    outcome = _run(
        service,
        {
            "accept_version": API_VERSION,
            "project_id": "project_alpha",
            "target_project_id": GENERAL_PROJECT_ID,
        },
    )
    assert outcome is not None
    assert outcome.response["error"]["code"] == rdm.INTERNAL_ERROR_CODE
    assert outcome.response["error"]["message"] == "memory.move_project failed"
