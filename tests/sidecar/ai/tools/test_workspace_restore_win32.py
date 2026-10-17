"""Windows handle-relative restore primitives (w2f5-R1).

A directory handle held across a pathname swap keeps naming the directory it
opened, so a create relative to it never follows a junction that replaced the
parent's pathname afterwards.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from sidecar.ai.tools import workspace_restore_io as restore_io
from sidecar.ai.tools.workspace_path_identity import NodeIdentity

pytestmark = pytest.mark.skipif(os.name != "nt", reason="Win32 handle-relative primitives")

if os.name == "nt":
    import _winapi

    from sidecar.ai.tools import workspace_restore_win32 as win32


def _identity(path: Path) -> NodeIdentity:
    return NodeIdentity.from_stat(path.lstat())


def test_a_handle_relative_create_lands_in_the_held_directory_after_a_junction_swap(tmp_path: Path) -> None:
    held = tmp_path / "held"
    held.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    parent = win32.open_directory_handle(held, _identity(held))
    try:
        held.rename(tmp_path / "held-moved")
        _winapi.CreateJunction(str(outside), str(held))  # the parent pathname now leads outside
        win32.close_handle(win32.create_directory_relative(parent, "child"))
    finally:
        win32.close_handle(parent)

    assert (tmp_path / "held-moved" / "child").is_dir()
    assert list(outside.rglob("*")) == []


def test_an_existing_name_is_a_file_exists_error(tmp_path: Path) -> None:
    (tmp_path / "taken").mkdir()
    parent = win32.open_directory_handle(tmp_path, _identity(tmp_path))
    try:
        with pytest.raises(FileExistsError):
            win32.create_directory_relative(parent, "taken")
    finally:
        win32.close_handle(parent)


@pytest.mark.parametrize("name", ["", ".", "..", "a\\b", "a/b", "c:x", "nul\x00"])
def test_a_name_that_is_not_one_component_is_refused_before_any_create(tmp_path: Path, name: str) -> None:
    parent = win32.open_directory_handle(tmp_path, _identity(tmp_path))
    try:
        with pytest.raises(ValueError):
            win32.create_directory_relative(parent, name)
    finally:
        win32.close_handle(parent)
    assert list(tmp_path.iterdir()) == []


def test_delete_by_handle_removes_exactly_the_node_created_behind_a_swapped_parent(tmp_path: Path) -> None:
    held = tmp_path / "held"
    held.mkdir()
    outside = tmp_path / "outside"
    (outside / "child").mkdir(parents=True)  # someone else's directory of the same name
    parent = win32.open_directory_handle(held, _identity(held))
    try:
        held.rename(tmp_path / "held-moved")
        _winapi.CreateJunction(str(outside), str(held))
        created = win32.create_directory_relative(parent, "child")
        try:
            with pytest.raises(PermissionError):  # an open child pins its parent's name
                (tmp_path / "held-moved").rename(tmp_path / "held-again")
            win32.delete_by_handle(created)
        finally:
            win32.close_handle(created)
    finally:
        win32.close_handle(parent)

    assert not (tmp_path / "held-moved" / "child").exists()
    assert (outside / "child").is_dir(), "the unrelated outside directory survives"


def test_opening_a_parent_refuses_a_junction_and_a_different_directory(tmp_path: Path) -> None:
    real = tmp_path / "real"
    real.mkdir()
    other = tmp_path / "other"
    other.mkdir()
    junction = tmp_path / "junction"
    _winapi.CreateJunction(str(real), str(junction))

    with pytest.raises(OSError):
        win32.open_directory_handle(junction, _identity(junction))  # a reparse point, not a directory
    with pytest.raises(OSError):
        win32.open_directory_handle(other, _identity(real))  # not the object the caller checked


def test_a_link_under_a_windows_parent_fails_closed_without_creating_anything(tmp_path: Path) -> None:
    root = tmp_path / "root"
    (root / "dir").mkdir(parents=True)

    with restore_io.bound_workspace(root), pytest.raises(restore_io.RestorePathUnsafe, match="handle-relative proof"):
        restore_io._create_pinned(root / "dir" / "link", link="target.txt")

    assert list((root / "dir").iterdir()) == []
