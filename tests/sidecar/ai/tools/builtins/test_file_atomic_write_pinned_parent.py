"""Atomic writes must create and clean up temporary files under a validated parent."""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

import pytest

from sidecar.ai.error_codes import CMP_TOOL_IO_FAILED
from sidecar.ai.tools.builtins import file_atomic_write as atomic
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.workspace import WorkspaceGuard


def _swap_parent(parent: Path, moved: Path, outside: Path) -> None:
    os.rename(parent, moved)
    if os.name == "nt":
        result = subprocess.run(
            ["cmd", "/c", "mklink", "/J", str(parent), str(outside)],
            capture_output=True, check=False, text=True,
        )
        if result.returncode != 0:
            os.rename(moved, parent)
            pytest.skip(f"mklink /J not permitted: {result.stderr.strip()}")
    else:
        os.symlink(outside, parent, target_is_directory=True)


def _assert_creation_swap_rejected(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    root = tmp_path / "workspace"
    parent = root / "parent"
    parent.mkdir(parents=True)
    target = parent / "file.txt"
    target.write_bytes(b"original")
    moved = root / "parent_moved"
    outside = tmp_path / "outside"
    outside.mkdir()

    def swap(path: Path) -> None:
        assert path == target
        _swap_parent(parent, moved, outside)

    monkeypatch.setattr(atomic, "_before_temp_create", swap)
    with pytest.raises(ToolExecutionFailure) as excinfo:
        atomic.write_bytes_atomic(
            target, b"private workspace content", workspace=WorkspaceGuard(str(root)),
        )

    assert excinfo.value.code == CMP_TOOL_IO_FAILED
    assert [(p.name, p.read_bytes()) for p in outside.iterdir()] == []
    assert sorted(p.name for p in moved.iterdir()) == ["file.txt"]
    assert (moved / "file.txt").read_bytes() == b"original"


@pytest.mark.skipif(os.name == "nt", reason="POSIX symlinks only")
def test_parent_swap_before_temp_create_posix(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _assert_creation_swap_rejected(tmp_path, monkeypatch)


@pytest.mark.skipif(os.name != "nt", reason="Windows junctions only")
def test_parent_swap_before_temp_create_windows(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _assert_creation_swap_rejected(tmp_path, monkeypatch)


def test_replace_failure_removes_own_temp(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    target = tmp_path / "file.txt"
    target.write_bytes(b"original")
    def fail_replace(*args, **kwargs) -> None:
        temps = list(tmp_path.glob(".file.txt.*.tmp"))
        assert len(temps) == 1
        assert temps[0].read_bytes() == b"replacement"
        raise OSError("injected replace failure")

    monkeypatch.setattr(atomic.os, "replace", fail_replace)
    # The capability check reads os.rename, so patching os.replace keeps the
    # pinned branch selected on POSIX; the fake accepts its dir_fd keywords.
    with pytest.raises(ToolExecutionFailure, match="failed to write file: injected replace failure"):
        atomic.write_bytes_atomic(target, b"replacement")
    assert target.read_bytes() == b"original"
    assert sorted(p.name for p in tmp_path.iterdir()) == ["file.txt"]


def test_honest_write_has_no_temp(tmp_path: Path) -> None:
    target = tmp_path / "file.txt"
    target.write_bytes(b"original")
    assert atomic.write_bytes_atomic(
        target, b"replacement", workspace=WorkspaceGuard(str(tmp_path)),
    ) is None
    assert target.read_bytes() == b"replacement"
    assert sorted(p.name for p in tmp_path.iterdir()) == ["file.txt"]


@pytest.mark.skipif(os.name == "nt", reason="Pinned directory handles require POSIX dir_fd")
def test_parent_swap_before_replace_cleans_pinned_temp(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = tmp_path / "workspace"
    parent = root / "parent"
    parent.mkdir(parents=True)
    target = parent / "file.txt"
    target.write_bytes(b"original")
    moved = root / "parent_moved"
    outside = tmp_path / "outside"
    outside.mkdir()

    def swap(path: Path) -> None:
        assert path == target
        assert len(list(parent.glob(".file.txt.*.tmp"))) == 1
        _swap_parent(parent, moved, outside)

    monkeypatch.setattr(atomic, "_before_atomic_replace", swap)
    with pytest.raises(ToolExecutionFailure, match="atomic write path identity changed"):
        atomic.write_bytes_atomic(target, b"replacement", workspace=WorkspaceGuard(str(root)))
    assert list(outside.iterdir()) == []
    assert sorted(p.name for p in moved.iterdir()) == ["file.txt"]
    assert (moved / "file.txt").read_bytes() == b"original"
