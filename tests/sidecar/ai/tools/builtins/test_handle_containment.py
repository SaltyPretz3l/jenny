"""Open-time workspace containment: the root resolved once, the handle checked per file."""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from sidecar.ai.error_codes import CMP_TOOL_OUTSIDE_WORKSPACE
from sidecar.ai.tools.builtins import file_state, handle_containment
from sidecar.ai.tools.builtins.handle_containment import (
    FinalRoot,
    resolve_final_root,
    strip_windows_device_prefix,
    verify_handle_within,
)
from sidecar.ai.tools.contracts import ToolExecutionFailure
from tests.sidecar._platform_skips import make_dir_link, windows_only


def test_final_root_contains_whole_components_only(tmp_path: Path) -> None:
    root = FinalRoot(tmp_path / "work")
    assert root.contains(root.path / "a" / "b.txt")
    assert root.contains(root.path)
    assert not root.contains(root.path.parent / "workshop" / "b.txt")
    assert not root.contains(root.path.parent)
    assert root.contains(root.path / "x" / ".." / "y.txt")
    assert not root.contains(root.path / ".." / "y.txt")


def test_final_root_casefolds_only_when_asked(tmp_path: Path) -> None:
    root = FinalRoot(tmp_path / "Work")
    upper = Path(str(root.path).upper()) / "f.txt"
    assert root.contains(upper, casefold=True)
    if os.name != "nt":
        assert not root.contains(upper)


def test_a_handle_inside_the_root_passes_and_one_outside_fails(tmp_path: Path) -> None:
    inside = tmp_path / "work" / "in.txt"
    inside.parent.mkdir()
    inside.write_text("x", encoding="utf-8")
    outside = tmp_path / "other.txt"
    outside.write_text("x", encoding="utf-8")
    root = resolve_final_root(tmp_path / "work")

    with open(inside, "rb") as handle:
        verify_handle_within(handle, inside, root)
    with open(outside, "rb") as handle, pytest.raises(ToolExecutionFailure) as caught:
        verify_handle_within(handle, outside, root)
    assert caught.value.code == CMP_TOOL_OUTSIDE_WORKSPACE


def test_an_unresolvable_root_fails_closed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    target = tmp_path / "f.txt"
    target.write_text("x", encoding="utf-8")

    def broken_realpath(_path: object) -> str:
        raise OSError("cannot resolve")

    monkeypatch.setattr(handle_containment.os.path, "realpath", broken_realpath)
    assert resolve_final_root(tmp_path) is None
    with open(target, "rb") as handle, pytest.raises(ToolExecutionFailure) as caught:
        file_state.verify_authorized_handle(handle, target, tmp_path)
    assert caught.value.code == CMP_TOOL_OUTSIDE_WORKSPACE
    assert caught.value.message == "resolved path escapes tools workspace root"


def test_a_root_behind_a_link_accepts_files_under_its_target(tmp_path: Path) -> None:
    real = tmp_path / "real"
    real.mkdir()
    (real / "f.txt").write_text("x", encoding="utf-8")
    linked = tmp_path / "linked"
    make_dir_link(linked, real)

    with open(linked / "f.txt", "rb") as handle:
        file_state.verify_authorized_handle(handle, linked / "f.txt", linked)


@windows_only("the GetFinalPathNameByHandleW binding")
def test_the_windows_binding_is_built_once() -> None:
    first = handle_containment._get_final_path_function()
    assert handle_containment._get_final_path_function() is first


def test_strip_windows_device_prefix() -> None:
    assert strip_windows_device_prefix("\\\\?\\C:\\work\\f.txt") == "C:\\work\\f.txt"
    assert strip_windows_device_prefix("\\\\?\\UNC\\host\\share\\f") == "\\\\host\\share\\f"
    assert strip_windows_device_prefix("C:\\work") == "C:\\work"
