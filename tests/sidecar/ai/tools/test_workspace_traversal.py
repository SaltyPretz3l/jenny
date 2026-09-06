"""Adversarial path-traversal regression tests for ``WorkspaceGuard``.

These tests exercise every path-shape an attacker (or a hallucinating
model) might try to reach outside of the configured tools workspace
root: relative escapes (``..``), absolute paths on both platforms,
Windows long-path / UNC prefixes, null bytes, and symlink / junction
escapes that redirect a legitimate-looking child to somewhere outside
the root.  Each payload must raise ``ToolExecutionFailure`` with one
of the path-violation error codes.

No source-side change is needed — this is pure regression coverage for
the already-correct guard in :mod:`sidecar.ai.tools.workspace`.
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

import pytest

from sidecar.ai.error_codes import (
    CMP_TOOL_INVALID_PATH,
    CMP_TOOL_OUTSIDE_WORKSPACE,
)
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.workspace import WorkspaceGuard

_PATH_VIOLATION_CODES = {CMP_TOOL_INVALID_PATH, CMP_TOOL_OUTSIDE_WORKSPACE}


@pytest.fixture()
def guard(tmp_path: Path) -> WorkspaceGuard:
    (tmp_path / "inside.txt").write_text("ok\n", encoding="utf-8")
    return WorkspaceGuard(str(tmp_path))


@pytest.fixture()
def outside_file(tmp_path_factory: pytest.TempPathFactory) -> Path:
    other = tmp_path_factory.mktemp("outside")
    target = other / "secret.txt"
    target.write_text("secret\n", encoding="utf-8")
    return target


# ── Relative traversal ───────────────────────────────────────────────


@pytest.mark.parametrize(
    "payload",
    [
        "../etc/passwd",
        "../../outside",
        "../../../../../../../../../etc/shadow",
        "subdir/../../outside",
        "./../../outside",
    ],
)
def test_relative_traversal_rejected(guard: WorkspaceGuard, payload: str) -> None:
    with pytest.raises(ToolExecutionFailure) as excinfo:
        guard.resolve_read_path(payload)
    assert excinfo.value.code in _PATH_VIOLATION_CODES


# ── Absolute paths outside root ──────────────────────────────────────


def test_absolute_posix_path_rejected(guard: WorkspaceGuard, outside_file: Path) -> None:
    with pytest.raises(ToolExecutionFailure) as excinfo:
        guard.resolve_read_path(str(outside_file))
    assert excinfo.value.code in _PATH_VIOLATION_CODES


@pytest.mark.skipif(os.name != "nt", reason="Windows-only absolute paths")
@pytest.mark.parametrize(
    "payload",
    [
        r"C:\Windows\System32\drivers\etc\hosts",
        r"C:\Users\Public",
        r"\\?\C:\Windows\System32",
        r"\\.\C:\Windows",
    ],
)
def test_windows_absolute_paths_rejected(guard: WorkspaceGuard, payload: str) -> None:
    with pytest.raises(ToolExecutionFailure) as excinfo:
        guard.resolve_read_path(payload)
    assert excinfo.value.code in _PATH_VIOLATION_CODES


@pytest.mark.skipif(os.name != "nt", reason="UNC paths are Windows-only")
def test_unc_path_rejected(guard: WorkspaceGuard) -> None:
    with pytest.raises(ToolExecutionFailure) as excinfo:
        guard.resolve_read_path(r"\\server\share\file.txt")
    assert excinfo.value.code in _PATH_VIOLATION_CODES


# ── Null bytes ───────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "payload",
    [
        "inside.txt\x00.png",
        "\x00",
        "sub/\x00/file",
    ],
)
def test_null_byte_paths_rejected(guard: WorkspaceGuard, payload: str) -> None:
    with pytest.raises(ToolExecutionFailure) as excinfo:
        guard.resolve_read_path(payload)
    assert excinfo.value.code == CMP_TOOL_INVALID_PATH


# ── Empty / whitespace paths ─────────────────────────────────────────


@pytest.mark.parametrize("payload", ["", "   ", "\t", "\n"])
def test_empty_or_whitespace_paths_rejected(guard: WorkspaceGuard, payload: str) -> None:
    with pytest.raises(ToolExecutionFailure) as excinfo:
        guard.resolve_read_path(payload)
    assert excinfo.value.code == CMP_TOOL_INVALID_PATH


# ── Symlink escape ───────────────────────────────────────────────────


def _can_create_symlink(tmp_path: Path) -> bool:
    src = tmp_path / "_probe_src"
    dst = tmp_path / "_probe_dst"
    src.write_text("x", encoding="utf-8")
    try:
        os.symlink(src, dst)
    except (OSError, NotImplementedError):
        return False
    finally:
        if dst.exists() or dst.is_symlink():
            try:
                dst.unlink()
            except OSError:
                pass
        if src.exists():
            src.unlink()
    return True


def test_symlink_escape_rejected(tmp_path: Path, outside_file: Path) -> None:
    if not _can_create_symlink(tmp_path):
        pytest.skip("symlink creation not permitted in this environment")

    workspace = tmp_path / "workspace"
    workspace.mkdir()
    link = workspace / "escape"
    os.symlink(outside_file, link)

    guard = WorkspaceGuard(str(workspace))
    with pytest.raises(ToolExecutionFailure) as excinfo:
        guard.resolve_read_path("escape")
    assert excinfo.value.code in _PATH_VIOLATION_CODES


@pytest.mark.skipif(os.name != "nt", reason="Windows junctions only")
def test_windows_junction_escape_rejected(tmp_path: Path, outside_file: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    link = workspace / "escape"
    result = subprocess.run(
        ["cmd", "/c", "mklink", "/J", str(link), str(outside_file.parent)],
        capture_output=True,
        check=False,
        text=True,
    )
    if result.returncode != 0:
        pytest.skip(f"mklink /J not permitted: {result.stderr.strip()}")

    guard = WorkspaceGuard(str(workspace))
    with pytest.raises(ToolExecutionFailure) as excinfo:
        guard.resolve_read_path("escape/secret.txt")
    assert excinfo.value.code in _PATH_VIOLATION_CODES


# ── List variant gets the same containment ───────────────────────────


def test_list_path_rejects_outside_absolute(guard: WorkspaceGuard, outside_file: Path) -> None:
    with pytest.raises(ToolExecutionFailure) as excinfo:
        guard.resolve_list_path(str(outside_file.parent))
    assert excinfo.value.code in _PATH_VIOLATION_CODES


def test_list_path_rejects_relative_traversal(guard: WorkspaceGuard) -> None:
    with pytest.raises(ToolExecutionFailure) as excinfo:
        guard.resolve_list_path("../..")
    assert excinfo.value.code in _PATH_VIOLATION_CODES


# ── ensure_within_root guard ─────────────────────────────────────────


def test_ensure_within_root_rejects_outside_path(guard: WorkspaceGuard, outside_file: Path) -> None:
    with pytest.raises(ToolExecutionFailure) as excinfo:
        guard.ensure_within_root(outside_file)
    assert excinfo.value.code == CMP_TOOL_OUTSIDE_WORKSPACE


def test_ensure_within_root_allows_inside_path(guard: WorkspaceGuard, tmp_path: Path) -> None:
    inside = tmp_path / "inside.txt"
    result = guard.ensure_within_root(inside)
    assert result == inside.resolve()


# ── Positive control — legitimate paths pass ─────────────────────────


def test_legitimate_relative_path_resolves(guard: WorkspaceGuard) -> None:
    resolved = guard.resolve_read_path("inside.txt")
    assert resolved.name == "inside.txt"


def test_legitimate_absolute_inside_root_resolves(guard: WorkspaceGuard, tmp_path: Path) -> None:
    resolved = guard.resolve_read_path(str(tmp_path / "inside.txt"))
    assert resolved.name == "inside.txt"


# ── Non-ASCII noise — should not crash, just be classified cleanly ──


@pytest.mark.parametrize(
    "payload",
    [
        "файл.txt",
        "文件.txt",
        "🌍/file.txt",
    ],
)
def test_unicode_path_names_do_not_crash(guard: WorkspaceGuard, payload: str) -> None:
    # These paths don't exist; resolver should surface INVALID_PATH, not
    # an uncaught OS error.
    with pytest.raises(ToolExecutionFailure) as excinfo:
        guard.resolve_read_path(payload)
    assert excinfo.value.code == CMP_TOOL_INVALID_PATH
