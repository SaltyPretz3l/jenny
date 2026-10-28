"""Win32 name rewriting cannot bypass the reserved ``.jenny`` guard (tool review C7 #2).

Windows drops trailing dots and spaces and opens ``name:stream`` as an NTFS
stream, so ``.jenny./trash/x.txt`` was judged by one name and written under
another.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from sidecar.ai.tools.builtins.file_state import is_reserved_internal_path
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.workspace import WorkspaceGuard, _win32_rewrites_segment
from tests.sidecar._platform_skips import windows_only


@pytest.mark.parametrize(
    "path",
    [".jenny", ".jenny/x", ".JENNY/x", ".jenny./trash/x.txt", ".jenny. /x", ".jenny:stream",
     ".jenny::$DATA", "./.jenny./x", ".jenny.\\x"],
)
def test_reserved_guard_folds_win32_rewrites(path: str) -> None:
    assert is_reserved_internal_path(path)


@pytest.mark.parametrize("path", ["jenny/x", ".jennyx/y", "src/.jenny/x", "a.txt", ""])
def test_reserved_guard_leaves_ordinary_paths(path: str) -> None:
    assert not is_reserved_internal_path(path)


@pytest.mark.parametrize(
    ("path", "rewritten"),
    [
        (Path("a.txt."), True),
        (Path("dir /x"), True),
        (Path("a.txt:s"), True),
        (Path(".jenny./trash"), True),
        (Path("../x"), False),
        (Path("./x"), False),
        (Path("normal/path.py"), False),
        (Path(".hidden/.dotfile"), False),
    ],
)
def test_win32_rewritten_segments(path: Path, rewritten: bool) -> None:
    assert _win32_rewrites_segment(path) is rewritten


@windows_only("Win32 name folding")
def test_drive_anchor_colon_is_not_a_stream() -> None:
    assert _win32_rewrites_segment(Path("C:/work/a.txt")) is False


@windows_only("Win32 name folding")
@pytest.mark.parametrize("path", [".jenny./trash/x.txt", "src/a.txt.", "src/a.txt:stream"])
def test_resolve_write_path_refuses_rewritten_segments_on_windows(
    tmp_path: Path, path: str
) -> None:
    guard = WorkspaceGuard(str(tmp_path))

    with pytest.raises(ToolExecutionFailure, match="Windows would rename"):
        guard.resolve_write_path(path)
