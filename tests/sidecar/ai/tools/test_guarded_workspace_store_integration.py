"""Behavioral gates for guarded workspace-local ``.jenny`` storage.

These tests intentionally exercise public consumers rather than a path-returning
storage helper.  A hostile pre-existing link object must be quarantined and the
operation must continue against a newly-created in-workspace store without ever
touching the link target.
"""

from __future__ import annotations

import os
import stat
from pathlib import Path

import pytest

from sidecar.ai.mcp import builtin_server
from sidecar.ai.tools.builtins import file_history, filesystem
from sidecar.ai.tools.builtins.shell_background import read_background_job
from sidecar.ai.tools.workspace import WorkspaceGuard
from tests.sidecar._platform_skips import make_dir_link, requires_file_symlinks


def _is_link_object(path: Path) -> bool:
    """Symlink, or a Windows junction (a reparse point that ``is_symlink`` does not report)."""
    if path.is_symlink():
        return True
    attributes = getattr(os.lstat(path), "st_file_attributes", 0)
    return bool(attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT)


def _assert_quarantined_link(root: Path, *, original_name: str) -> None:
    quarantine = root / ".jenny" / "quarantine"
    assert quarantine.is_dir()
    entries = list(quarantine.iterdir())
    assert entries
    assert any(original_name in entry.name for entry in entries)
    assert any(_is_link_object(entry) for entry in entries)


def test_filesystem_artifact_identity_covers_absolute_and_normalized_aliases(
    tmp_path: Path,
) -> None:
    root = tmp_path / "workspace"
    root.mkdir()

    assert filesystem._artifact_store_parts(
        str(root / ".jenny" / "artifacts" / "session" / "result.md"),
        root,
    ) == ("session", "result.md")
    assert filesystem._artifact_store_parts(
        "scratch/../.jenny/artifacts/session/result.md",
        root,
    ) == ("session", "result.md")
    assert (
        filesystem._artifact_store_parts(
            str(tmp_path / "outside" / ".jenny" / "artifacts" / "result.md"),
            root,
        )
        is None
    )


def test_artifact_writer_quarantines_linked_artifacts_root(tmp_path: Path) -> None:
    root = tmp_path / "workspace"
    outside = tmp_path / "outside-artifacts"
    (root / ".jenny").mkdir(parents=True)
    outside.mkdir()
    sentinel = outside / "keep.txt"
    sentinel.write_text("outside", encoding="utf-8")
    make_dir_link(root / ".jenny" / "artifacts", outside)

    tool = builtin_server._default_tools()["create_artifact"]
    result = tool.handler(
        {
            "_jenny_session_id": "session-artifact",
            "artifact_kind": "document",
            "title": "Guarded Plan",
            "content": "# safe",
            "language": "markdown",
        },
        WorkspaceGuard(str(root)),
    )

    assert result.success is True
    metadata = result.generated_artifacts[0]
    assert (root / str(metadata["display_path"])).read_text(encoding="utf-8") == "# safe"
    assert sentinel.read_text(encoding="utf-8") == "outside"
    assert list(outside.iterdir()) == [sentinel]
    _assert_quarantined_link(root, original_name="artifacts")


@pytest.mark.parametrize("path_shape", ["relative", "absolute", "normalized_alias"])
def test_filesystem_artifact_write_quarantines_linked_root(
    tmp_path: Path,
    path_shape: str,
) -> None:
    root = tmp_path / "workspace"
    outside = tmp_path / "outside-filesystem-artifacts"
    (root / ".jenny").mkdir(parents=True)
    outside.mkdir()
    sentinel = outside / "keep.txt"
    sentinel.write_text("outside", encoding="utf-8")
    make_dir_link(root / ".jenny" / "artifacts", outside)

    artifact_path = root / ".jenny" / "artifacts" / "session-123" / "result.md"
    requested_path = {
        "relative": ".jenny/artifacts/session-123/result.md",
        "absolute": str(artifact_path),
        "normalized_alias": "scratch/../.jenny/artifacts/session-123/result.md",
    }[path_shape]
    result = filesystem.write_file_tool(
        {
            "path": requested_path,
            "content": "safe result",
        },
        WorkspaceGuard(str(root)),
    )

    assert result.success is True
    assert (root / ".jenny" / "artifacts" / "session-123" / "result.md").read_text(
        encoding="utf-8"
    ) == "safe result"
    assert sentinel.read_text(encoding="utf-8") == "outside"
    assert list(outside.iterdir()) == [sentinel]
    _assert_quarantined_link(root, original_name="artifacts")


def test_checkpoint_writer_quarantines_linked_backups_root(tmp_path: Path) -> None:
    root = tmp_path / "workspace"
    outside = tmp_path / "outside-backups"
    (root / ".jenny").mkdir(parents=True)
    outside.mkdir()
    sentinel = outside / "keep.txt"
    sentinel.write_text("outside", encoding="utf-8")
    make_dir_link(root / ".jenny" / "backups", outside)
    target = root / "notes.txt"
    target.write_text("hello\n", encoding="utf-8")

    info = file_history.create_checkpoint(target, root)

    assert info.created is True
    assert info.display_path is not None
    assert (root / info.display_path).read_text(encoding="utf-8") == "hello\n"
    assert sentinel.read_text(encoding="utf-8") == "outside"
    assert list(outside.iterdir()) == [sentinel]
    _assert_quarantined_link(root, original_name="backups")


@requires_file_symlinks()
def test_background_status_leaf_link_is_quarantined_not_followed(tmp_path: Path) -> None:
    root = tmp_path / "workspace"
    outside = tmp_path / "outside-status"
    job_id = "0123456789ab"
    job_dir = root / ".jenny" / "tool-results" / job_id
    job_dir.mkdir(parents=True)
    outside.mkdir()
    sentinel = outside / "status.json"
    sentinel.write_text('{"job_id":"0123456789ab","state":"completed"}', encoding="utf-8")
    os.symlink(sentinel, job_dir / "status.json")

    status = read_background_job(root, job_id)

    assert status == {"job_id": job_id, "state": "not_found"}
    assert sentinel.read_text(encoding="utf-8") == (
        '{"job_id":"0123456789ab","state":"completed"}'
    )
    _assert_quarantined_link(root, original_name="status.json")
