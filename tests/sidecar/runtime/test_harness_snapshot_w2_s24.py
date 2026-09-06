from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

from sidecar.ai.config import RuntimeConfig
from sidecar.ai.context.builder import ContextBuilder
from sidecar.ai.memory.store import MemoryStore
from sidecar.runtime.harness_snapshot import HarnessSnapshotBuilder


def _builder(user_data: Path, memory_store: MemoryStore) -> HarnessSnapshotBuilder:
    return HarnessSnapshotBuilder(
        config=RuntimeConfig(
            engine_type="mock",
            model="mock-v1",
            electron_state_root=str(user_data),
            memory_db_path=str(user_data / "sidecar-memory.db"),
        ),
        router=SimpleNamespace(tools_status={}, tool_schemas=[]),
        engine=SimpleNamespace(),
        mcp_client=SimpleNamespace(),
        memory_store=memory_store,
        context_builder=ContextBuilder(None),
    )


def test_harness_snapshot_preserves_and_counts_source_removed_provenance(
    tmp_path: Path,
) -> None:
    memory_store = MemoryStore(tmp_path / "sidecar-memory.db")
    try:
        memory_store.save_memory(
            session_id="session-1",
            title="Removed source",
            lesson_text="Keep this lesson without its source.",
            lesson_kind="project_context",
            confidence=0.9,
            source_excerpt="",
            provenance="source_removed",
        )

        snapshot = _builder(tmp_path, memory_store).inspect(sections=["memories"])

        assert snapshot["memories"]["approved"][0]["provenance"] == "source_removed"
        assert snapshot["memories"]["counts"]["provenance"] == {
            "user_approved": 0,
            "automatic": 0,
            "source_removed": 1,
            "unknown_legacy": 0,
        }
    finally:
        memory_store.close()


def _tool_message(
    kind: str,
    *,
    timestamp: str,
    parent_stream_id: str | None,
    is_error: bool | None = None,
) -> dict[str, object]:
    metadata: dict[str, object] = {
        "call_id": "reused-call",
        "tool_name": "read_file",
    }
    if parent_stream_id is not None:
        metadata["parent_stream_id"] = parent_stream_id
    if kind == "tool_use":
        metadata["approval_state"] = "auto"
        return {"kind": kind, "timestamp": timestamp, "tool_call": metadata}
    metadata["is_error"] = is_error is True
    return {"kind": kind, "timestamp": timestamp, "tool_result": metadata}


def _history_for_messages(tmp_path: Path, messages: list[dict[str, object]]) -> dict[str, object]:
    (tmp_path / "sessions.json").write_text(
        json.dumps(
            {
                "sessions": {
                    "session-1": {
                        "title": "Repeated calls",
                        "messages": messages,
                    }
                }
            }
        ),
        encoding="utf-8",
    )
    memory_store = MemoryStore(tmp_path / "sidecar-memory.db")
    try:
        return _builder(tmp_path, memory_store)._load_tool_history(history_limit=5)
    finally:
        memory_store.close()


def test_tool_history_keeps_reused_call_id_separate_across_parent_streams(
    tmp_path: Path,
) -> None:
    history = _history_for_messages(
        tmp_path,
        [
            _tool_message(
                "tool_use",
                timestamp="2026-08-23T10:00:00Z",
                parent_stream_id="stream-1",
            ),
            _tool_message(
                "tool_result",
                timestamp="2026-08-23T10:00:01Z",
                parent_stream_id="stream-1",
                is_error=False,
            ),
            _tool_message(
                "tool_use",
                timestamp="2026-08-23T10:01:00Z",
                parent_stream_id="stream-2",
            ),
            _tool_message(
                "tool_result",
                timestamp="2026-08-23T10:01:01Z",
                parent_stream_id="stream-2",
                is_error=True,
            ),
        ],
    )["read_file"]

    assert history["use_count"] == 2
    assert history["success_count"] == 1
    assert history["error_count"] == 1


def test_tool_history_uses_message_position_for_legacy_reused_call_ids(
    tmp_path: Path,
) -> None:
    history = _history_for_messages(
        tmp_path,
        [
            _tool_message(
                "tool_use",
                timestamp="2026-08-23T10:00:00Z",
                parent_stream_id=None,
            ),
            _tool_message(
                "tool_result",
                timestamp="2026-08-23T10:00:01Z",
                parent_stream_id=None,
                is_error=False,
            ),
            _tool_message(
                "tool_use",
                timestamp="2026-08-23T10:01:00Z",
                parent_stream_id=None,
            ),
            _tool_message(
                "tool_result",
                timestamp="2026-08-23T10:01:01Z",
                parent_stream_id=None,
                is_error=True,
            ),
        ],
    )["read_file"]

    assert history["use_count"] == 2
    assert history["success_count"] == 1
    assert history["error_count"] == 1
