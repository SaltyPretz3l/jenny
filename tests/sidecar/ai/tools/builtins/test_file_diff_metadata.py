from __future__ import annotations

import logging
import re
from pathlib import Path

import pytest

from sidecar.ai.tools.builtins import edit_file as edit_module
from sidecar.ai.tools.builtins import file_state as file_state_module
from sidecar.ai.tools.builtins import filesystem as filesystem_module
from sidecar.ai.tools.builtins import structured_diff as structured_diff_module
from sidecar.ai.tools.workspace import WorkspaceGuard


def _guard(tmp_path: Path, snapshot_root: Path | None = None) -> WorkspaceGuard:
    return WorkspaceGuard(
        str(tmp_path),
        pre_change_snapshot_root=str(snapshot_root) if snapshot_root else None,
    )


def _full_read_snapshot(tmp_path: Path, relative_path: str) -> dict[str, object]:
    result = filesystem_module.read_file_tool({"path": relative_path}, _guard(tmp_path))
    assert result.success is True
    snapshot = result.metadata.get("read_snapshot")
    assert isinstance(snapshot, dict)
    return snapshot


@pytest.fixture(autouse=True)
def _reset_filesystem_config(monkeypatch: pytest.MonkeyPatch) -> None:
    filesystem_module.configure_filesystem_tools(None)
    yield
    filesystem_module.configure_filesystem_tools(None)
    monkeypatch.undo()


def test_write_file_new_file_attaches_created_diff(tmp_path: Path) -> None:
    result = filesystem_module.write_file_tool(
        {"path": "notes.txt", "content": "hello\n"},
        _guard(tmp_path),
    )

    assert result.success is True
    assert result.metadata["changed"] is True
    diff = result.metadata["diff"]
    assert diff["status"] == "created"
    assert diff["review_state"] == "full"
    assert diff["body_kind"] == "inline_hunks"
    assert diff["additions"] == 1
    assert diff["deletions"] == 0
    assert diff["before_hash"] is None
    assert re.fullmatch(r"sha256:[a-f0-9]{64}", str(diff["after_hash"]))
    assert diff["hunks"][0]["lines"] == ["+hello"]


def test_write_file_existing_overwrite_attaches_modified_diff(tmp_path: Path) -> None:
    target = tmp_path / "notes.txt"
    target.write_text("before\n", encoding="utf-8", newline="")
    snapshot_root = tmp_path / "snapshots"

    result = filesystem_module.write_file_tool(
        {
            "path": "notes.txt",
            "content": "after\n",
            "expected_read_snapshot": _full_read_snapshot(tmp_path, "notes.txt"),
        },
        _guard(tmp_path, snapshot_root),
    )

    assert result.success is True
    diff = result.metadata["diff"]
    assert diff["status"] == "modified"
    assert diff["additions"] == 1
    assert diff["deletions"] == 1
    assert diff["hunks"][0]["lines"] == ["-before", "+after"]
    snapshot_path = snapshot_root / f"{str(diff['before_hash']).removeprefix('sha256:')}.snap"
    assert snapshot_path.read_text(encoding="utf-8") == "before\n"


def test_write_file_succeeds_when_snapshot_capture_fails(tmp_path: Path) -> None:
    target = tmp_path / "notes.txt"
    target.write_text("before\n", encoding="utf-8", newline="")
    invalid_snapshot_root = tmp_path / "snapshot-root-file"
    invalid_snapshot_root.write_text("occupied", encoding="utf-8")

    result = filesystem_module.write_file_tool(
        {
            "path": "notes.txt",
            "content": "after\n",
            "expected_read_snapshot": _full_read_snapshot(tmp_path, "notes.txt"),
        },
        _guard(tmp_path, invalid_snapshot_root),
    )

    assert result.success is True
    assert result.metadata["diff"]["status"] == "modified"
    assert target.read_text(encoding="utf-8") == "after\n"


def test_write_file_empty_creation_has_created_summary_diff(tmp_path: Path) -> None:
    result = filesystem_module.write_file_tool(
        {"path": "empty.txt", "content": ""},
        _guard(tmp_path),
    )

    assert result.success is True
    assert result.metadata["changed"] is True
    diff = result.metadata["diff"]
    assert diff["status"] == "created"
    assert diff["review_state"] == "summary_only"
    assert diff["body_kind"] == "none"
    assert diff["additions"] == 0
    assert diff["deletions"] == 0
    assert diff["hunks"] == []


def test_write_file_no_op_does_not_attach_diff(tmp_path: Path) -> None:
    target = tmp_path / "same.txt"
    target.write_text("same\n", encoding="utf-8", newline="")

    result = filesystem_module.write_file_tool(
        {
            "path": "same.txt",
            "content": "same\n",
            "expected_read_snapshot": _full_read_snapshot(tmp_path, "same.txt"),
        },
        _guard(tmp_path),
    )

    assert result.success is True
    assert result.metadata["changed"] is False
    assert "diff" not in result.metadata


def test_edit_file_attaches_diff_from_locked_pre_mutation_text(tmp_path: Path) -> None:
    target = tmp_path / "notes.txt"
    target.write_bytes(b"hello world\r\n")

    result = edit_module.edit_file_tool(
        {
            "file_path": "notes.txt",
            "old_string": "world",
            "new_string": "earth",
            "expected_read_snapshot": _full_read_snapshot(tmp_path, "notes.txt"),
        },
        _guard(tmp_path),
    )

    assert result.success is True
    assert target.read_bytes() == b"hello earth\r\n"
    diff = result.metadata["diff"]
    assert diff["status"] == "modified"
    assert diff["additions"] == 1
    assert diff["deletions"] == 1
    assert diff["hunks"][0]["lines"] == ["-hello world", "+hello earth"]


def test_write_file_large_line_diff_is_summary_only(tmp_path: Path) -> None:
    target = tmp_path / "large.txt"
    target.write_text(f"{'a' * 2100}\n", encoding="utf-8", newline="")

    result = filesystem_module.write_file_tool(
        {
            "path": "large.txt",
            "content": f"{'b' * 2100}\n",
            "expected_read_snapshot": _full_read_snapshot(tmp_path, "large.txt"),
        },
        _guard(tmp_path),
    )

    assert result.success is True
    diff = result.metadata["diff"]
    assert diff["review_state"] == "summary_only"
    assert diff["body_kind"] == "summary_only"
    assert diff["truncated"] is True
    assert diff["truncation_reason"] == "line_limit"
    assert diff["additions"] == 1
    assert diff["deletions"] == 1
    assert diff["hunks"] == []


def test_write_file_succeeds_with_failed_diff_metadata_when_generation_fails(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    def _boom(*_args, **_kwargs):
        raise RuntimeError("diff boom")

    monkeypatch.setattr(structured_diff_module, "compute_structured_diff", _boom)
    caplog.set_level(logging.WARNING)

    result = filesystem_module.write_file_tool(
        {"path": "notes.txt", "content": "hello\n"},
        _guard(tmp_path),
    )

    assert result.success is True
    assert (tmp_path / "notes.txt").read_text(encoding="utf-8") == "hello\n"
    diff = result.metadata["diff"]
    assert diff["status"] == "created"
    assert diff["review_state"] == "failed"
    assert diff["body_kind"] == "none"
    assert diff["truncated"] is True
    assert diff["truncation_reason"] == "diff_generation_failed"
    assert diff["hunks"] == []
    assert result.metadata["warnings"] == [
        {
            "code": "diff_generation_failed",
            "message": "Structured diff metadata could not be generated; file mutation succeeded.",
        }
    ]
    assert any(
        getattr(record, "event", "") == "tool.diff_generation_failed"
        for record in caplog.records
    )


def test_failed_diff_metadata_preserves_existing_warnings(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def _return_no_diff(*_args, **_kwargs):
        return None

    monkeypatch.setattr(structured_diff_module, "compute_structured_diff", _return_no_diff)
    metadata: dict[str, object] = {
        "warnings": [
            {
                "code": "existing_warning",
                "message": "Existing warning remains visible.",
            }
        ]
    }

    file_state_module.attach_structured_diff_metadata(
        metadata,
        path="notes.txt",
        old_text="before\n",
        new_text="after\n",
        status="modified",
        logger=None,
    )

    assert metadata["warnings"] == [
        {
            "code": "existing_warning",
            "message": "Existing warning remains visible.",
        },
        {
            "code": "diff_generation_failed",
            "message": "Structured diff metadata could not be generated; file mutation succeeded.",
        },
    ]
