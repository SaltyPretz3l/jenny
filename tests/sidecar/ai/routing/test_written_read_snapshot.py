"""Dogfood TR-007: a successful write leaves the bytes it wrote as the read snapshot.

2026-09-28 (G1): write_file created a file, the router dropped the path's read
snapshot, and rewriting the model's own file was refused CMP-TOOL-0018 "must be
read in this conversation"; the forced re-read cost Bonsai its last loop
iteration. These tests drive the real builtin write/edit tools through the
builtin server and the router's snapshot cache and injection.
"""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from sidecar.ai.error_codes import (
    CMP_TOOL_READ_SNAPSHOT_REQUIRED,
    CMP_TOOL_STALE_READ_SNAPSHOT,
)
from sidecar.ai.mcp import builtin_server
from sidecar.ai.mcp.client_support import extract_tool_output
from sidecar.ai.mcp.models import MCPToolResult
from sidecar.ai.routing.tool_execution_snapshots import (
    inject_expected_read_snapshot,
    update_read_snapshot_cache,
)
from sidecar.ai.tools.workspace import WorkspaceGuard


class _Turn:
    """One conversation: the builtin server plus the router's snapshot cache."""

    def __init__(self, root: Path) -> None:
        self.root = root
        self.tools = builtin_server._default_tools()
        self.guard = WorkspaceGuard(str(root))
        self.kernel = SimpleNamespace(
            _config=SimpleNamespace(tools_workspace_root=str(root)), _mcp_client=None,
        )
        self.cache: dict[str, dict[str, object]] = {}
        self.calls = 0

    def call(self, tool_name: str, arguments: dict[str, Any]) -> MCPToolResult:
        self.calls += 1
        effective = inject_expected_read_snapshot(
            self.kernel, tool_name=tool_name, tool_arguments=dict(arguments),
            read_snapshot_cache=self.cache,
        )
        response = builtin_server._handle_tools_call(
            f"tr007_{self.calls}", self.tools, self.guard,
            {"name": tool_name, "arguments": effective},
        )
        assert "error" not in response, response
        result = MCPToolResult(tool_name=tool_name, **extract_tool_output(response["result"]))
        update_read_snapshot_cache(
            self.kernel, self.cache, tool_name=tool_name, success=result.success,
            metadata=dict(result.metadata),
        )
        return result


@pytest.mark.parametrize("bom", [False, True])
def test_rewriting_a_file_the_model_just_created_needs_no_reread(
    tmp_path: Path, bom: bool,
) -> None:
    turn = _Turn(tmp_path)
    first = "﻿draft one\n" if bom else "draft one\n"
    created = turn.call("write_file", {"path": "notes/journal.md", "content": first})
    assert created.success, created.output
    snapshot = created.metadata["written_snapshot"]
    assert snapshot["scope"] == "full"
    assert snapshot["encoding"] == ("utf-8-sig" if bom else "utf-8")
    assert snapshot["size_bytes"] == (tmp_path / "notes" / "journal.md").stat().st_size

    rewritten = turn.call("write_file", {"path": "notes/journal.md", "content": "draft two\n"})

    assert rewritten.success, rewritten.output
    # An existing BOM is preserved on rewrite.
    assert (tmp_path / "notes" / "journal.md").read_text(encoding="utf-8-sig") == "draft two\n"
    # ...and again: each write hands its own snapshot to the next.
    again = turn.call("write_file", {"path": "notes/journal.md", "content": "draft three\n"})
    assert again.success, again.output


def test_an_edit_after_a_write_is_validated_against_the_written_bytes(tmp_path: Path) -> None:
    turn = _Turn(tmp_path)
    assert turn.call("write_file", {"path": "a.txt", "content": "alpha\nbeta\n"}).success
    edited = turn.call("edit_file", {"file_path": "a.txt", "old_string": "beta",
                                     "new_string": "gamma"})
    assert edited.success, edited.output
    assert edited.metadata["read_snapshot_validated"] is True
    rewritten = turn.call("write_file", {"path": "a.txt", "content": "delta\n"})
    assert rewritten.success, rewritten.output


def test_a_no_op_rewrite_keeps_the_snapshot(tmp_path: Path) -> None:
    turn = _Turn(tmp_path)
    assert turn.call("write_file", {"path": "a.txt", "content": "same\n"}).success
    unchanged = turn.call("write_file", {"path": "a.txt", "content": "same\n"})
    assert unchanged.success and unchanged.metadata["changed"] is False
    assert turn.call("write_file", {"path": "a.txt", "content": "next\n"}).success


def test_an_external_change_after_the_write_still_fails_stale(tmp_path: Path) -> None:
    turn = _Turn(tmp_path)
    assert turn.call("write_file", {"path": "a.txt", "content": "mine\n"}).success
    (tmp_path / "a.txt").write_text("someone else's\n", encoding="utf-8")

    refused = turn.call("write_file", {"path": "a.txt", "content": "mine again\n"})

    assert not refused.success
    assert refused.error_code == CMP_TOOL_STALE_READ_SNAPSHOT
    assert (tmp_path / "a.txt").read_text(encoding="utf-8") == "someone else's\n"
    edit = turn.call("edit_file", {"file_path": "a.txt", "old_string": "else",
                                   "new_string": "other"})
    assert not edit.success
    assert edit.error_code == CMP_TOOL_STALE_READ_SNAPSHOT


def test_an_unread_existing_file_still_requires_a_read(tmp_path: Path) -> None:
    (tmp_path / "existing.txt").write_text("theirs\n", encoding="utf-8")
    turn = _Turn(tmp_path)
    refused = turn.call("write_file", {"path": "existing.txt", "content": "mine\n"})
    assert not refused.success
    assert refused.error_code == CMP_TOOL_READ_SNAPSHOT_REQUIRED


def test_a_written_snapshot_for_another_path_is_ignored() -> None:
    kernel = SimpleNamespace(_config=SimpleNamespace(tools_workspace_root=None), _mcp_client=None)
    cache: dict[str, dict[str, object]] = {"a.txt": {"path": "a.txt"}}
    update_read_snapshot_cache(
        kernel, cache, tool_name="write_file", success=True,
        metadata={"path": "a.txt", "written_snapshot": {
            "path": "b.txt", "scope": "full", "size_bytes": 1, "mtime_ns": 1,
            "sha256": "0" * 64, "encoding": "utf-8",
        }},
    )
    assert cache == {}
    update_read_snapshot_cache(
        kernel, cache, tool_name="write_file", success=False,
        metadata={"path": "a.txt", "written_snapshot": {
            "path": "a.txt", "scope": "full", "size_bytes": 1, "mtime_ns": 1,
            "sha256": "0" * 64, "encoding": "utf-8",
        }},
    )
    assert cache == {}


def test_the_written_snapshot_matches_a_full_read_of_the_same_bytes(tmp_path: Path) -> None:
    turn = _Turn(tmp_path)
    written = turn.call("write_file", {"path": "a.txt", "content": "same bytes\n"})
    read = turn.call("read_file", {"path": "a.txt"})
    read_snapshot = dict(read.metadata["read_snapshot"])
    read_snapshot.pop("snapshot_id", None)
    assert written.metadata["written_snapshot"] == read_snapshot
