"""which_on_explicit_path never returns, and is never shadowed by, a cwd copy (review item 8)."""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from sidecar.ai.tools.builtins.executable_lookup import which_on_explicit_path
from tests.sidecar._platform_skips import windows_only


@windows_only("shutil.which searches the cwd first only on Windows")
def test_a_cwd_copy_neither_wins_nor_hides_the_path_copy(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    cwd_dir = tmp_path / "cwd"
    bin_dir = tmp_path / "bin"
    cwd_dir.mkdir()
    bin_dir.mkdir()
    (cwd_dir / "tool.exe").write_text("", encoding="utf-8")
    monkeypatch.chdir(cwd_dir)
    search_path = os.pathsep.join([".", "relative", str(bin_dir)])

    assert which_on_explicit_path("tool", path=search_path) is None
    (bin_dir / "tool.exe").write_text("", encoding="utf-8")
    resolved = which_on_explicit_path("tool", path=search_path)
    assert resolved is not None
    assert os.path.normcase(resolved) == os.path.normcase(str(bin_dir / "tool.exe"))
