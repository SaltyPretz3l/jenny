"""Windows 8.3 short names must not hide ``.jenny`` from leaf-preserving tools.

``resolve_workspace_leaf`` keeps the final component unresolved so a link is
moved rather than followed.  Before it adopted the on-disk spelling, a short
name such as ``JENNY~1`` reached the reserved-path checks lexically and
``move_file``/``delete_file`` relocated Jenny's own recovery data.
"""

from __future__ import annotations

import shutil
import tempfile
from collections.abc import Iterator
from pathlib import Path

import pytest

from sidecar.ai.error_codes import CMP_TOOL_INVALID_PATH
from sidecar.ai.tools.builtins import filesystem as filesystem_module
from sidecar.ai.tools.builtins.delete_file import delete_file_tool
from sidecar.ai.tools.builtins.move_file import move_file_tool
from sidecar.ai.tools.workspace import WorkspaceGuard
from sidecar.ai.tools.workspace_path_identity import resolve_workspace_leaf
from sidecar.ai.tools.workspace_store import GuardedWorkspaceStore
from tests.sidecar._platform_skips import make_dir_link, windows_only

pytestmark = windows_only("8.3 short names")

_RESERVED_REASON = "the .jenny directory holds Jenny's backups and trash"


def _short_name(path: Path) -> str:
    import ctypes  # Windows-only API, loaded inside the skipped-elsewhere tests.

    buffer = ctypes.create_unicode_buffer(32_768)
    length = ctypes.WinDLL("kernel32").GetShortPathNameW(str(path), buffer, 32_768)
    if length == 0 or length >= 32_768:
        return path.name
    return Path(buffer.value).name


def _snapshot(root: Path) -> dict[str, bytes | None]:
    return {
        path.relative_to(root).as_posix(): path.read_bytes() if path.is_file() else None
        for path in sorted(root.rglob("*"))
    }


@pytest.fixture(autouse=True)
def _reset_filesystem_config() -> Iterator[None]:
    filesystem_module.configure_filesystem_tools(None)
    yield
    filesystem_module.configure_filesystem_tools(None)


@pytest.fixture
def short_workspace() -> Iterator[tuple[Path, str]]:
    # The system temp volume (C:) has 8.3 generation enabled on the dev box; a
    # worktree volume may not, so the workspace deliberately lives there.
    root = Path(tempfile.mkdtemp(prefix="jenny83_", dir=tempfile.gettempdir()))
    try:
        store = GuardedWorkspaceStore(root)
        store.write_bytes_atomic(
            store.resolve("backups", "victim.bin"), b"checkpoint-data", max_bytes=1_000
        )
        short = _short_name(root / ".jenny")
        if short.casefold() == ".jenny":
            pytest.skip("8.3 short-name generation is disabled on the temp volume")
        yield root, short
    finally:
        shutil.rmtree(root, ignore_errors=True)


def test_resolve_workspace_leaf_expands_short_leaf_and_parent(
    short_workspace: tuple[Path, str],
) -> None:
    root, short = short_workspace

    leaf = resolve_workspace_leaf(root, short)
    nested = resolve_workspace_leaf(root, f"{short}/backups/victim.bin")

    assert leaf.leaf_path.name == ".jenny"
    assert leaf.relative_path == ".jenny"
    assert nested.relative_path == ".jenny/backups/victim.bin"
    assert nested.leaf_path == root.resolve() / ".jenny" / "backups" / "victim.bin"


@pytest.mark.parametrize(
    "source_suffix",
    ["", "/backups/victim.bin", "/backups"],
    ids=["store-root", "backup-file", "backups-dir"],
)
def test_move_file_refuses_short_name_jenny_source(
    short_workspace: tuple[Path, str],
    source_suffix: str,
) -> None:
    root, short = short_workspace
    before = _snapshot(root / ".jenny")

    result = move_file_tool(
        {"source": f"{short}{source_suffix}", "destination": "stolen"},
        WorkspaceGuard(str(root)),
    )

    assert result.success is False
    assert result.error_code == CMP_TOOL_INVALID_PATH
    assert _RESERVED_REASON in result.output
    assert not (root / "stolen").exists()
    assert _snapshot(root / ".jenny") == before


@pytest.mark.parametrize(
    "path_suffix",
    ["", "/backups", "/backups/victim.bin"],
    ids=["store-root", "backups-dir", "backup-file"],
)
def test_delete_file_refuses_short_name_jenny_path(
    short_workspace: tuple[Path, str],
    path_suffix: str,
) -> None:
    root, short = short_workspace
    before = _snapshot(root / ".jenny")

    result = delete_file_tool(
        {"path": f"{short}{path_suffix}", "recursive": True},
        WorkspaceGuard(str(root)),
    )

    assert result.success is False
    assert _RESERVED_REASON in result.output
    assert _snapshot(root / ".jenny") == before


def test_resolve_workspace_leaf_short_link_keeps_the_link_object(
    short_workspace: tuple[Path, str],
) -> None:
    root, _short = short_workspace
    target = root / "junction_target_long_name"
    target.mkdir()
    link = root / "junction_link_long_name"
    make_dir_link(link, target)
    link_short = _short_name(link)
    if link_short == link.name:
        pytest.skip("8.3 short-name generation is disabled on the volume")

    leaf = resolve_workspace_leaf(root, link_short)

    assert leaf.is_link_object is True
    assert leaf.leaf_path.name == "junction_link_long_name"
    assert leaf.relative_path == "junction_link_long_name"
