"""Tests for ensure_safe_internal_destination — the guarded resolver for
internally assembled `.jenny` destination paths (trash/backups/tool-results/
artifacts). P0-2 stopgap for WIDE-002: reject symlinks/reparse points anywhere
on the destination chain before any write/move/delete, without requiring a
WorkspaceGuard instance."""

from __future__ import annotations

import os
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest

from sidecar.ai.error_codes import CMP_TOOL_IO_FAILED, CMP_TOOL_OUTSIDE_WORKSPACE
from sidecar.ai.tools import workspace as workspace_module
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.workspace import ensure_safe_internal_destination


def _can_create_symlink(tmp_path: Path) -> bool:
    probe_target = tmp_path / "symlink-probe-target"
    probe_target.write_text("probe", encoding="utf-8")
    probe_link = tmp_path / "symlink-probe-link"
    try:
        os.symlink(probe_target, probe_link)
    except (OSError, NotImplementedError):
        return False
    finally:
        if probe_link.is_symlink():
            probe_link.unlink()
        probe_target.unlink()
    return True


def _make_junction(link: Path, target: Path) -> bool:
    result = subprocess.run(
        ["cmd", "/c", "mklink", "/J", str(link), str(target)],
        capture_output=True,
        check=False,
        text=True,
    )
    return result.returncode == 0


def test_new_destination_under_clean_root_is_allowed(tmp_path):
    destination = tmp_path / ".jenny" / "trash" / "20260710" / "file.txt"
    resolved = ensure_safe_internal_destination(tmp_path, destination)
    assert resolved == destination
    # The helper validates only; it must not create anything.
    assert not (tmp_path / ".jenny").exists()


def test_existing_clean_destination_is_allowed(tmp_path):
    destination = tmp_path / ".jenny" / "tool-results" / "abc123abc123"
    destination.mkdir(parents=True)
    resolved = ensure_safe_internal_destination(tmp_path, destination)
    assert resolved == destination


def test_destination_lexically_outside_root_is_rejected(tmp_path):
    root = tmp_path / "ws"
    root.mkdir()
    outside = tmp_path / "outside" / "status.json"
    with pytest.raises(ToolExecutionFailure) as excinfo:
        ensure_safe_internal_destination(root, outside)
    assert excinfo.value.code == CMP_TOOL_OUTSIDE_WORKSPACE


def test_traversal_escape_is_rejected(tmp_path):
    root = tmp_path / "ws"
    root.mkdir()
    sneaky = root / ".jenny" / ".." / ".." / "evil.txt"
    with pytest.raises(ToolExecutionFailure) as excinfo:
        ensure_safe_internal_destination(root, sneaky)
    assert excinfo.value.code == CMP_TOOL_OUTSIDE_WORKSPACE


def test_missing_root_is_rejected(tmp_path):
    root = tmp_path / "gone"
    with pytest.raises(ToolExecutionFailure) as excinfo:
        ensure_safe_internal_destination(root, root / ".jenny" / "trash" / "x")
    assert excinfo.value.code in (CMP_TOOL_IO_FAILED, CMP_TOOL_OUTSIDE_WORKSPACE)


def test_symlinked_jenny_dir_is_rejected(tmp_path):
    if not _can_create_symlink(tmp_path):
        pytest.skip("cannot create symlinks in this environment")
    root = tmp_path / "ws"
    root.mkdir()
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    os.symlink(elsewhere, root / ".jenny", target_is_directory=True)
    with pytest.raises(ToolExecutionFailure) as excinfo:
        ensure_safe_internal_destination(root, root / ".jenny" / "trash" / "f.txt")
    assert excinfo.value.code == CMP_TOOL_IO_FAILED
    # Outside sentinel must be untouched (validation only, no writes).
    assert list(elsewhere.iterdir()) == []


def test_symlinked_intermediate_dir_is_rejected(tmp_path):
    if not _can_create_symlink(tmp_path):
        pytest.skip("cannot create symlinks in this environment")
    root = tmp_path / "ws"
    (root / ".jenny").mkdir(parents=True)
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    os.symlink(elsewhere, root / ".jenny" / "trash", target_is_directory=True)
    with pytest.raises(ToolExecutionFailure) as excinfo:
        ensure_safe_internal_destination(root, root / ".jenny" / "trash" / "f.txt")
    assert excinfo.value.code == CMP_TOOL_IO_FAILED


def test_symlinked_leaf_destination_is_rejected(tmp_path):
    if not _can_create_symlink(tmp_path):
        pytest.skip("cannot create symlinks in this environment")
    root = tmp_path / "ws"
    (root / ".jenny" / "backups").mkdir(parents=True)
    target = tmp_path / "victim.json"
    target.write_text("{}", encoding="utf-8")
    leaf = root / ".jenny" / "backups" / "meta.json"
    os.symlink(target, leaf)
    with pytest.raises(ToolExecutionFailure) as excinfo:
        ensure_safe_internal_destination(root, leaf)
    assert excinfo.value.code == CMP_TOOL_IO_FAILED
    assert target.read_text(encoding="utf-8") == "{}"


@pytest.mark.skipif(os.name != "nt", reason="Windows junctions only")
def test_windows_junction_at_jenny_is_rejected(tmp_path):
    root = tmp_path / "ws"
    root.mkdir()
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    if not _make_junction(root / ".jenny", elsewhere):
        pytest.skip("mklink /J not permitted in this environment")
    with pytest.raises(ToolExecutionFailure) as excinfo:
        ensure_safe_internal_destination(root, root / ".jenny" / "trash" / "f.txt")
    assert excinfo.value.code == CMP_TOOL_IO_FAILED
    assert list(elsewhere.iterdir()) == []


def test_reparse_detection_failure_fails_closed(tmp_path, monkeypatch):
    """If reparse detection cannot stat the path, the helper must refuse
    (mirrors _has_windows_reparse_point's fail-closed OSError contract)."""
    root = tmp_path / "ws"
    (root / ".jenny").mkdir(parents=True)
    destination = root / ".jenny" / "trash" / "f.txt"

    monkeypatch.setattr(
        workspace_module,
        "os",
        SimpleNamespace(name="nt", path=os.path),
    )
    original_stat = Path.stat

    def _fragile_stat(self, *, follow_symlinks=True):
        if not follow_symlinks and self == root / ".jenny":
            raise OSError("reparse probe failed")
        return original_stat(self, follow_symlinks=follow_symlinks)

    monkeypatch.setattr(Path, "stat", _fragile_stat)
    with pytest.raises(ToolExecutionFailure) as excinfo:
        ensure_safe_internal_destination(root, destination)
    assert excinfo.value.code == CMP_TOOL_IO_FAILED
