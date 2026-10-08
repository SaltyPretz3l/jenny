from __future__ import annotations

import os
import subprocess
from pathlib import Path

import pytest

from sidecar.ai.context import context_io


def _link_directory(link: Path, target: Path) -> None:
    if os.name == "nt":
        result = subprocess.run(
            ["cmd", "/c", "mklink", "/J", str(link), str(target)],
            capture_output=True,
            check=False,
            text=True,
        )
        if result.returncode != 0:
            pytest.skip(f"mklink /J not permitted: {result.stderr.strip()}")
    else:
        try:
            os.symlink(target, link, target_is_directory=True)
        except (OSError, NotImplementedError) as error:
            pytest.skip(f"symlink creation not permitted: {error}")


@pytest.fixture
def workspace(tmp_path: Path) -> Path:
    root = tmp_path / "workspace"
    bootstrap = root / "BOOTSTRAP"
    bootstrap.mkdir(parents=True)
    (bootstrap / "IDENTITY.md").write_text("INSIDE-CONTEXT\n", encoding="utf-8")
    return root


def test_parent_swap_after_authorization_rejects_outside_handle(
    workspace: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "IDENTITY.md").write_text("OUTSIDE-SECRET\n", encoding="utf-8")
    authorize = context_io._authorized_paths
    read = os.read
    close = os.close
    read_fds: list[int] = []
    closed_fds: list[int] = []

    def authorize_then_swap(path: Path, root: Path) -> tuple[Path, Path] | None:
        authorized = authorize(path, root)
        assert authorized is not None
        bootstrap = workspace / "BOOTSTRAP"
        bootstrap.rename(workspace / "BOOTSTRAP-original")
        _link_directory(bootstrap, outside)
        return authorized

    def record_read(fd: int, size: int) -> bytes:
        read_fds.append(fd)
        return read(fd, size)

    def record_close(fd: int) -> None:
        closed_fds.append(fd)
        close(fd)

    monkeypatch.setattr(context_io, "_authorized_paths", authorize_then_swap)
    monkeypatch.setattr(context_io.os, "read", record_read)
    monkeypatch.setattr(context_io.os, "close", record_close)
    result = context_io.read_bounded_context_text(
        workspace / "BOOTSTRAP" / "IDENTITY.md",
        authorized_root=workspace,
        max_bytes=1024,
        truncate=False,
    )

    assert result.text is None
    assert result.reason == "unsafe_path"
    assert "OUTSIDE-SECRET" not in (result.text or "")
    assert read_fds == []
    assert len(closed_fds) == 1
    with pytest.raises(OSError):
        os.fstat(closed_fds[0])


def test_honest_context_read(workspace: Path) -> None:
    result = context_io.read_bounded_context_text(
        workspace / "BOOTSTRAP" / "IDENTITY.md",
        authorized_root=workspace,
        max_bytes=1024,
        truncate=False,
    )

    assert result == context_io.BoundedContextText("INSIDE-CONTEXT\n")


def test_junction_or_symlink_authorized_root_reads(
    workspace: Path, tmp_path: Path
) -> None:
    root = tmp_path / "workspace-link"
    _link_directory(root, workspace)
    result = context_io.read_bounded_context_text(
        root / "BOOTSTRAP" / "IDENTITY.md",
        authorized_root=root,
        max_bytes=1024,
        truncate=False,
    )

    assert result == context_io.BoundedContextText("INSIDE-CONTEXT\n")
