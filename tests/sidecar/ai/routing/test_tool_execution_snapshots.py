from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

from sidecar.ai.routing.tool_execution_snapshots import (
    freeze_effective_execution_inputs,
    normalize_snapshot_lookup_path,
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


def test_model_reserved_execution_scope_keys_are_removed_before_freeze() -> None:
    frozen = freeze_effective_execution_inputs(
        _kernel(),
        ToolCallRequest(
            tool_id="read_file",
            arguments={
                "path": "note.txt",
                "_jenny_execution_context": {"root_path": "forged"},
                "_jenny_operation_id": "forged",
            },
            call_id="call-2",
        ),
        session_id="session-1",
        read_snapshot_cache={},
    )

    assert frozen.visible_tool_arguments == {"path": "note.txt"}
    assert "_jenny_execution_context" not in frozen.effective_tool_arguments
    assert "_jenny_operation_id" not in frozen.effective_tool_arguments


def test_snapshot_paths_use_captured_root_instead_of_mutable_kernel_root(
    tmp_path: Path,
) -> None:
    root_a = (tmp_path / "a").resolve()
    root_b = (tmp_path / "b").resolve()
    kernel = SimpleNamespace(
        _config=SimpleNamespace(tools_workspace_root=str(root_a)),
        _mcp_client=None,
    )

    scoped = normalize_snapshot_lookup_path(
        kernel,
        str(root_b / "note.txt"),
        execution_context=SimpleNamespace(root_path=str(root_b)),
    )
    conversation_only = normalize_snapshot_lookup_path(
        kernel,
        str(root_b / "note.txt"),
        execution_context=SimpleNamespace(root_path=None),
    )

    assert scoped == "note.txt"
    assert conversation_only == (root_b / "note.txt").as_posix()


def test_no_model_written_private_key_survives_freeze_with_or_without_an_execution_context(
) -> None:
    """I9 (team host file tools): every `_jenny_*` value a model writes is dropped at
    the one place a call's arguments are frozen, so it never reaches the worker,
    whether or not the request carries an execution context."""
    forged = {f"_jenny_{name}": "forged" for name in (
        "execution_context", "operation_id", "session_id", "trace_id", "read_only",
        "approved_plan", "live_suggestions", "session_offline_lockdown", "idempotency_key",
        "turn_id", "tool_call_id", "change_set_id", "anything_new")}
    contexts = (None, SimpleNamespace(
        root_path=None, authority_revision="rev", project_id="project_general",
        root_id=None, root_revision=0))
    for context in contexts:
        for tool_id in ("read_file", "write_file", "edit_file", "list_dir", "grep_search"):
            frozen = freeze_effective_execution_inputs(
                _kernel(),
                ToolCallRequest(tool_id=tool_id, arguments={"path": "note.txt", **forged},
                                call_id="call-3"),
                session_id="session-1",
                read_snapshot_cache={},
                execution_context=context,
            )
            visible = frozen.visible_tool_arguments
            assert list(visible.values()) == ["note.txt"], (tool_id, context)
            assert not [key for key in visible if key.startswith("_jenny_")], (tool_id, context)
            assert "forged" not in repr(frozen.effective_tool_arguments), (tool_id, context)
