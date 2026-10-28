"""Shared skip markers and link helpers for the sidecar suite's real platform gates.

Every marker's reason names the platform or resource it waits on. A gate that
can never be true on a supported platform is deleted rather than routed through
here (docs/plans/TEST_HEALTH_2026-10-26.md). Standard library and pytest only:
the installers lane runs some files with ``--noconftest`` and no project extras.
"""

from __future__ import annotations

import functools
import os
import sys
import tempfile
from pathlib import Path

import pytest

IS_WINDOWS = sys.platform == "win32"
FILE_SYMLINK_REASON = "Windows file symlinks need Developer Mode or an elevated token"


def windows_only(what: str) -> pytest.MarkDecorator:
    return pytest.mark.skipif(not IS_WINDOWS, reason=f"Windows only: {what}")


def posix_only(what: str) -> pytest.MarkDecorator:
    return pytest.mark.skipif(IS_WINDOWS, reason=f"POSIX only: {what}")


def linux_only(what: str) -> pytest.MarkDecorator:
    return pytest.mark.skipif(not sys.platform.startswith("linux"), reason=f"Linux only: {what}")


@functools.cache
def file_symlinks_refused() -> bool:
    """True when this host cannot create a file symlink (Windows without the privilege)."""
    if not IS_WINDOWS:
        return False
    with tempfile.TemporaryDirectory(prefix="jenny-symlink-probe-") as tmp:
        target = Path(tmp) / "target.txt"
        target.write_text("", encoding="utf-8")
        try:
            (Path(tmp) / "link.txt").symlink_to(target)
        except OSError:
            return True
    return False


def requires_file_symlinks() -> pytest.MarkDecorator:
    return pytest.mark.skipif(file_symlinks_refused(), reason=FILE_SYMLINK_REASON)


def skip_without_file_symlinks() -> None:
    """In-body form of ``requires_file_symlinks`` for parametrized or fixture paths."""
    if file_symlinks_refused():
        pytest.skip(FILE_SYMLINK_REASON)


def make_dir_link(link: Path, target: Path) -> None:
    """Link directory ``link`` -> ``target`` with no privilege: a junction on Windows.

    Raises on failure; neither link kind can be refused on a supported filesystem.
    """
    if IS_WINDOWS:
        import _winapi

        _winapi.CreateJunction(os.fspath(Path(target).resolve()), os.fspath(link))
    else:
        Path(link).symlink_to(target, target_is_directory=True)
