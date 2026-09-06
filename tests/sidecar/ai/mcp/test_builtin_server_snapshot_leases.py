from __future__ import annotations

import time

from sidecar.ai.mcp.builtin_snapshot_leases import SnapshotLeaseStore
from sidecar.ai.tools.contracts import ToolHandlerResult


def _read_result(path: str, *, scope: str = "full", digest: str = "a" * 64) -> ToolHandlerResult:
    snapshot: dict[str, object] = {
        "path": path,
        "scope": scope,
        "size_bytes": 4,
        "mtime_ns": 1,
    }
    if scope == "full":
        snapshot["sha256"] = digest
    return ToolHandlerResult(output="data", metadata={"read_snapshot": snapshot})


def test_full_read_receives_opaque_write_eligible_lease() -> None:
    store = SnapshotLeaseStore()

    result = store.decorate_read_result(session_id="session-a", result=_read_result("a.txt"))

    assert str(result.metadata["snapshot_id"]).startswith("snap_")
    assert result.metadata["snapshot_scope"] == "full"
    assert result.metadata["write_eligible"] is True
    assert result.metadata["content_display_truncated"] is False


def test_partial_read_never_receives_write_eligible_lease() -> None:
    store = SnapshotLeaseStore()

    result = store.decorate_read_result(
        session_id="session-a",
        result=_read_result("a.txt", scope="partial"),
    )

    assert "snapshot_id" not in result.metadata
    assert result.metadata["write_eligible"] is False


def test_lease_auto_injection_is_session_isolated() -> None:
    store = SnapshotLeaseStore()
    store.decorate_read_result(session_id="session-a", result=_read_result("a.txt"))

    own = store.inject(
        tool_name="write_file",
        session_id="session-a",
        arguments={"path": "a.txt", "content": "next"},
    )
    other = store.inject(
        tool_name="write_file",
        session_id="session-b",
        arguments={"path": "a.txt", "content": "next"},
    )

    assert own["expected_read_snapshot"]["sha256"] == "a" * 64  # type: ignore[index]
    assert "expected_read_snapshot" not in other


def test_successful_mutation_invalidates_lease() -> None:
    store = SnapshotLeaseStore()
    store.decorate_read_result(session_id="s", result=_read_result("a.txt"))
    store.invalidate_after(
        tool_name="edit_file",
        session_id="s",
        result=ToolHandlerResult(output="ok", metadata={"path": "a.txt"}),
    )

    prepared = store.inject(
        tool_name="edit_file",
        session_id="s",
        arguments={"file_path": "a.txt", "old_string": "a", "new_string": "b"},
    )

    assert "expected_read_snapshot" not in prepared


def test_move_file_invalidates_source_and_overwritten_destination_leases() -> None:
    store = SnapshotLeaseStore()
    store.decorate_read_result(session_id="s", result=_read_result("source.txt"))
    store.decorate_read_result(session_id="s", result=_read_result("destination.txt"))
    store.invalidate_after(
        tool_name="move_file",
        session_id="s",
        result=ToolHandlerResult(
            output="moved",
            metadata={
                "moves": [
                    {
                        "source": "source.txt",
                        "destination": "destination.txt",
                        "status": "moved",
                    }
                ]
            },
        ),
    )

    for path in ("source.txt", "destination.txt"):
        prepared = store.inject(
            tool_name="edit_file",
            session_id="s",
            arguments={"file_path": path},
        )
        assert "expected_read_snapshot" not in prepared


def test_partial_move_file_failure_invalidates_only_completed_moves() -> None:
    store = SnapshotLeaseStore()
    for path in ("moved.txt", "moved-destination.txt", "untouched.txt"):
        store.decorate_read_result(session_id="s", result=_read_result(path))
    store.invalidate_after(
        tool_name="move_file",
        session_id="s",
        result=ToolHandlerResult(
            output="partial failure",
            success=False,
            metadata={
                "moves": [
                    {
                        "source": "moved.txt",
                        "destination": "moved-destination.txt",
                        "status": "moved",
                    },
                    {
                        "source": "untouched.txt",
                        "destination": "never-created.txt",
                        "status": "failed",
                    },
                ]
            },
        ),
    )

    moved = store.inject(
        tool_name="edit_file",
        session_id="s",
        arguments={"file_path": "moved.txt"},
    )
    untouched = store.inject(
        tool_name="edit_file",
        session_id="s",
        arguments={"file_path": "untouched.txt"},
    )
    assert "expected_read_snapshot" not in moved
    assert "expected_read_snapshot" in untouched


def test_lru_and_ttl_evict_old_leases() -> None:
    store = SnapshotLeaseStore(max_leases=1, ttl_seconds=2)
    started = time.monotonic()
    first = _read_result("a.txt").metadata["read_snapshot"]
    second = _read_result("b.txt").metadata["read_snapshot"]
    assert isinstance(first, dict)
    assert isinstance(second, dict)
    store.register(session_id="s", path="a.txt", snapshot=first, now=started)
    store.register(session_id="s", path="b.txt", snapshot=second, now=started + 1)

    assert "expected_read_snapshot" not in store.inject(
        tool_name="write_file", session_id="s", arguments={"path": "a.txt"}
    )
    store._expire(started + 4)  # noqa: SLF001 - deterministic expiry contract.
    assert "expected_read_snapshot" not in store.inject(
        tool_name="write_file", session_id="s", arguments={"path": "b.txt"}
    )
