from __future__ import annotations

import os
from pathlib import Path

import pytest

from tests.sidecar import _platform_skips as skips


def test_platform_markers_name_the_platform() -> None:
    for marker, prefix in (
        (skips.windows_only("named pipes"), "Windows only: named pipes"),
        (skips.posix_only("dir_fd"), "POSIX only: dir_fd"),
        (skips.linux_only("flock"), "Linux only: flock"),
    ):
        assert marker.mark.name == "skipif"
        assert marker.mark.kwargs["reason"] == prefix
    assert skips.windows_only("x").mark.args == (not skips.IS_WINDOWS,)
    assert skips.posix_only("x").mark.args == (skips.IS_WINDOWS,)


def test_make_dir_link_reaches_the_target_and_reads_as_a_link(tmp_path: Path) -> None:
    target = tmp_path / "target"
    target.mkdir()
    (target / "inside.txt").write_text("hi", encoding="utf-8")
    link = tmp_path / "link"

    skips.make_dir_link(link, target)

    assert (link / "inside.txt").read_text(encoding="utf-8") == "hi"
    assert os.path.realpath(link) == os.path.realpath(target)
    # os.readlink reads both a junction and a symlink (Path.is_junction is 3.12+).
    assert os.path.samefile(os.readlink(link), target)


def test_make_dir_link_raises_instead_of_skipping(tmp_path: Path) -> None:
    target = tmp_path / "target"
    target.mkdir()
    occupied = tmp_path / "occupied"
    occupied.mkdir()

    with pytest.raises(OSError):
        skips.make_dir_link(occupied, target)


def test_file_symlink_probe_matches_a_real_attempt(tmp_path: Path) -> None:
    target = tmp_path / "t.txt"
    target.write_text("", encoding="utf-8")
    try:
        (tmp_path / "l.txt").symlink_to(target)
        refused = False
    except OSError:
        refused = True

    assert skips.file_symlinks_refused() is refused
    assert skips.requires_file_symlinks().mark.args == (refused,)
