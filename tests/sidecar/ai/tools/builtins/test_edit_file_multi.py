"""W7a-S4: edit_file gains an atomic multi-edit `edits` array; apply_patch retires.

Contract pinned red-first:
- `edits` is a list of {old_string, new_string, replace_all?} items applied
  SEQUENTIALLY to the evolving content — item N matches against the text
  produced by item N-1 — with every item validated before any byte is
  written (one atomic write, all-or-nothing),
- `edits` is mutually exclusive with top-level old_string/new_string,
- per-item validation and match failures name the failing item index and
  leave the file untouched,
- the item count is capped,
- expected_read_snapshot still guards the write,
- apply_patch is no longer a model-facing binding even when its old flag
  is set.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from sidecar.ai.error_codes import (
    CMP_TOOL_CAP_EXCEEDED,
    CMP_TOOL_EXECUTION_FAILED,
    CMP_TOOL_INVALID_PATH,
    CMP_TOOL_STALE_READ_SNAPSHOT,
)
from sidecar.ai.tools.builtins import edit_file as edit_module
from sidecar.ai.tools.builtins import filesystem as filesystem_module
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.registry import build_default_registry
from sidecar.ai.tools.workspace import WorkspaceGuard


def _guard(tmp_path: Path) -> WorkspaceGuard:
    return WorkspaceGuard(str(tmp_path))


@pytest.fixture(autouse=True)
def _reset_filesystem_config():
    filesystem_module.configure_filesystem_tools(None)
    yield
    filesystem_module.configure_filesystem_tools(None)


def _write(tmp_path: Path, name: str, content: str) -> Path:
    target = tmp_path / name
    target.write_text(content, encoding="utf-8")
    return target


def test_edits_array_applies_multiple_edits_atomically(tmp_path: Path) -> None:
    _write(tmp_path, "config.txt", "alpha = 1\nbeta = 2\ngamma = 3\n")

    result = edit_module.edit_file_tool(
        {
            "file_path": "config.txt",
            "edits": [
                {"old_string": "alpha = 1", "new_string": "alpha = 10"},
                {"old_string": "gamma = 3", "new_string": "gamma = 30"},
            ],
        },
        _guard(tmp_path),
    )

    assert result.success is True
    assert (tmp_path / "config.txt").read_text(encoding="utf-8") == (
        "alpha = 10\nbeta = 2\ngamma = 30\n"
    )
    assert result.metadata.get("edits_applied") == 2


def test_edits_apply_sequentially_to_evolving_content(tmp_path: Path) -> None:
    _write(tmp_path, "seq.txt", "start\n")

    result = edit_module.edit_file_tool(
        {
            "file_path": "seq.txt",
            "edits": [
                {"old_string": "start", "new_string": "middle"},
                # Matches only the text PRODUCED by the first edit.
                {"old_string": "middle", "new_string": "finish"},
            ],
        },
        _guard(tmp_path),
    )

    assert result.success is True
    assert (tmp_path / "seq.txt").read_text(encoding="utf-8") == "finish\n"


def test_edits_are_mutually_exclusive_with_top_level_pair(tmp_path: Path) -> None:
    _write(tmp_path, "both.txt", "content\n")

    with pytest.raises(ToolExecutionFailure) as excinfo:
        edit_module.edit_file_tool(
            {
                "file_path": "both.txt",
                "old_string": "content",
                "new_string": "other",
                "edits": [{"old_string": "content", "new_string": "other"}],
            },
            _guard(tmp_path),
        )

    assert excinfo.value.code == CMP_TOOL_INVALID_PATH


def test_failed_later_edit_leaves_file_untouched(tmp_path: Path) -> None:
    original = "alpha = 1\nbeta = 2\n"
    _write(tmp_path, "atomic.txt", original)

    result = edit_module.edit_file_tool(
        {
            "file_path": "atomic.txt",
            "edits": [
                {"old_string": "alpha = 1", "new_string": "alpha = 10"},
                {"old_string": "does-not-exist", "new_string": "nope"},
            ],
        },
        _guard(tmp_path),
    )

    assert result.success is False
    assert result.error_code == CMP_TOOL_EXECUTION_FAILED
    # The failure names the failing item so the model can repair just that one.
    assert "2" in result.output or "index 1" in result.output
    assert (tmp_path / "atomic.txt").read_text(encoding="utf-8") == original


def test_per_item_replace_all(tmp_path: Path) -> None:
    _write(tmp_path, "repeat.txt", "x xx x xx x\n")

    result = edit_module.edit_file_tool(
        {
            "file_path": "repeat.txt",
            "edits": [
                {"old_string": "xx", "new_string": "y", "replace_all": True},
            ],
        },
        _guard(tmp_path),
    )

    assert result.success is True
    assert (tmp_path / "repeat.txt").read_text(encoding="utf-8") == "x y x y x\n"


def test_item_validation_names_the_bad_index(tmp_path: Path) -> None:
    _write(tmp_path, "valid.txt", "content\n")

    with pytest.raises(ToolExecutionFailure) as excinfo:
        edit_module.edit_file_tool(
            {
                "file_path": "valid.txt",
                "edits": [
                    {"old_string": "content", "new_string": "other"},
                    {"old_string": "", "new_string": "bad"},
                ],
            },
            _guard(tmp_path),
        )

    assert excinfo.value.code == CMP_TOOL_INVALID_PATH
    assert "2" in str(excinfo.value.message) or "index 1" in str(excinfo.value.message)


def test_edits_item_count_is_capped(tmp_path: Path) -> None:
    _write(tmp_path, "cap.txt", "line\n")
    too_many = [
        {"old_string": f"missing-{index}", "new_string": "x"} for index in range(21)
    ]

    with pytest.raises(ToolExecutionFailure) as excinfo:
        edit_module.edit_file_tool(
            {"file_path": "cap.txt", "edits": too_many},
            _guard(tmp_path),
        )

    assert excinfo.value.code == CMP_TOOL_CAP_EXCEEDED


def test_edits_honor_stale_read_snapshot(tmp_path: Path) -> None:
    target = _write(tmp_path, "snap.txt", "content\n")
    read = filesystem_module.read_file_tool({"path": "snap.txt"}, _guard(tmp_path))
    snapshot = read.metadata.get("read_snapshot")
    assert isinstance(snapshot, dict)
    # Invalidate: the file changes after the read.
    target.write_text("changed underneath\n", encoding="utf-8")
    stale = dict(snapshot)
    stale["sha256"] = "0" * 64

    result = edit_module.edit_file_tool(
        {
            "file_path": "snap.txt",
            "expected_read_snapshot": stale,
            "edits": [{"old_string": "changed underneath", "new_string": "other"}],
        },
        _guard(tmp_path),
    )

    assert result.success is False
    assert result.error_code == CMP_TOOL_STALE_READ_SNAPSHOT
    assert (tmp_path / "snap.txt").read_text(encoding="utf-8") == "changed underneath\n"


def test_apply_patch_is_no_longer_a_model_facing_binding() -> None:
    registry = build_default_registry(config={"tools_apply_patch_enabled": True})
    assert "apply_patch" not in registry
    assert "edit_file" in registry
