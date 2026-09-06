from __future__ import annotations

from types import SimpleNamespace

from sidecar.ai.routing.tool_execution_snapshots import (
    freeze_effective_execution_inputs,
    update_read_snapshot_cache,
)
from sidecar.ai.tools.models import ToolCallRequest


def _kernel() -> SimpleNamespace:
    return SimpleNamespace(
        _config=SimpleNamespace(tools_workspace_root=None),
        _mcp_client=None,
    )


def test_move_file_invalidates_source_and_destination_read_snapshots() -> None:
    cache = {
        "source.txt": {"path": "source.txt"},
        "destination.txt": {"path": "destination.txt"},
        "unrelated.txt": {"path": "unrelated.txt"},
    }

    update_read_snapshot_cache(
        _kernel(),
        cache,
        tool_name="move_file",
        success=True,
        metadata={
            "moves": [
                {
                    "source": "source.txt",
                    "destination": "destination.txt",
                    "status": "moved",
                }
            ]
        },
    )

    assert set(cache) == {"unrelated.txt"}


def test_partial_move_file_failure_invalidates_only_completed_moves() -> None:
    cache = {
        "moved.txt": {"path": "moved.txt"},
        "moved-destination.txt": {"path": "moved-destination.txt"},
        "untouched.txt": {"path": "untouched.txt"},
    }

    update_read_snapshot_cache(
        _kernel(),
        cache,
        tool_name="move_file",
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
    )

    assert set(cache) == {"untouched.txt"}


def test_move_file_receives_session_scope_for_builtin_snapshot_invalidation() -> None:
    frozen = freeze_effective_execution_inputs(
        _kernel(),
        ToolCallRequest(
            tool_id="move_file",
            arguments={"source": "source.txt", "destination": "destination.txt"},
            call_id="call-1",
        ),
        session_id="session-1",
        read_snapshot_cache={},
    )

    assert frozen.effective_tool_arguments["_jenny_session_id"] == "session-1"
