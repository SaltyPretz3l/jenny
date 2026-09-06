from __future__ import annotations

from dataclasses import replace
from pathlib import Path

import pytest

from sidecar.ai.memory.contracts import MemoryPolicy
from sidecar.ai.memory.service import MemoryService
from sidecar.ai.memory.store import ApprovedMemory
from sidecar.ai.memory.unavailable import UnavailableMemoryStore


def _memory(memory_id: int, *, kind: str = "preference", body: str = "Tea") -> ApprovedMemory:
    return ApprovedMemory(
        id=memory_id,
        session_id="session",
        title=f"Memory {memory_id}",
        lesson_text=body,
        lesson_kind=kind,
        confidence=0.9,
        source_excerpt="",
        content_fingerprint=f"sha256:{memory_id:064x}",
        family_key="",
        provenance="user_approved",
        created_at="2026-01-01T00:00:00+00:00",
        updated_at="2026-01-01T00:00:00+00:00",
    )


class _Store:
    def __init__(self) -> None:
        self.calls = 0
        self.recalled = [_memory(1), _memory(2)]
        self.style = replace(self.recalled[0], lesson_kind="response_style")

    def recall_memories(self, _query: str, *, limit: int) -> list[ApprovedMemory]:
        self.calls += 1
        return self.recalled[:limit]

    def get_recent_memories_by_kind(self, _kind: str, _limit: int) -> list[ApprovedMemory]:
        return [self.style]

    def status_snapshot(self) -> dict[str, object]:
        return {"available": True}


def test_disabled_policy_never_touches_store() -> None:
    store = _Store()
    service = MemoryService(store)  # type: ignore[arg-type]

    assert (
        service.recall_for_prompt(
            "tea",
            policy=MemoryPolicy(enabled=False),
        )
        == []
    )
    assert store.calls == 0


def test_recall_merges_style_deduplicates_and_honors_shared_budget() -> None:
    store = _Store()
    service = MemoryService(store)  # type: ignore[arg-type]

    recalled = service.recall_for_prompt(
        "tea",
        policy=MemoryPolicy(enabled=True, include_response_style=True),
        max_prompt_tokens=256,
    )

    assert [memory.id for memory in recalled] == [1, 2]
    assert recalled[0].lesson_kind == "response_style"


def test_recall_can_exclude_response_style_without_disabling_other_memory() -> None:
    store = _Store()
    service = MemoryService(store)  # type: ignore[arg-type]

    recalled = service.recall_for_prompt(
        "tea",
        policy=MemoryPolicy(enabled=True, include_response_style=False),
    )

    assert [memory.id for memory in recalled] == [1, 2]
    assert recalled[0].lesson_kind == "preference"


def test_unavailable_status_is_content_free() -> None:
    service = MemoryService(
        UnavailableMemoryStore(
            db_path=Path("not-returned.db"),
            reason_code="CMP-MEM-0005",
            reason="unavailable",
        )
    )

    status = service.status()
    assert status["available"] is False
    assert "not-returned.db" not in str(status)


def test_service_does_not_proxy_arbitrary_store_attributes() -> None:
    service = MemoryService(_Store())  # type: ignore[arg-type]

    with pytest.raises(AttributeError):
        assert service.calls is None  # type: ignore[attr-defined]
