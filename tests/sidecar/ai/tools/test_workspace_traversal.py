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
from sidecar.ai.tools import workspace as workspace_module
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


@pytest.mark.parametrize(
    ("candidate", "expected"),
    [
        (
            r"[redacted:path]\sandbox",
            '"[redacted:path]" is a log redaction placeholder, not a real path',
        ),
        ("<path>", '"<path>" is a log redaction placeholder, not a real path'),
        ("a|b", "'|' at index 1 is not allowed in a Windows path"),
        (r"sub:dir\x", "':' at index 3 is not allowed in a Windows path"),
        (r"C:\ok\path", None),
        ("src/app.py", None),
    ],
)
def test_describe_invalid_path_argument(candidate: str, expected: str | None) -> None:
    assert workspace_module._describe_invalid_path_argument(candidate) == expected


def test_resolve_path_oserror_describes_relative_argument_without_root(
    guard: WorkspaceGuard,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    requested = r"[redacted:path]\sandbox"

    def fail_resolve(_path: Path, *, strict: bool = False) -> Path:
        raise OSError(
            22,
            "The filename, directory name, or volume label syntax is incorrect",
        )

    monkeypatch.setattr(Path, "resolve", fail_resolve)

    with pytest.raises(ToolExecutionFailure) as excinfo:
        guard.resolve_read_path(requested)

    message = excinfo.value.message
    assert requested in message
    assert '"[redacted:path]" is a log redaction placeholder, not a real path' in message
    assert 'Use "." for the workspace root or a workspace-relative path.' in message
    assert str(guard.root) not in message


def test_resolve_path_oserror_describes_absolute_inside_path_relative_to_root(
    guard: WorkspaceGuard,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    assert guard.root is not None
    requested = guard.root / "nested" / "bad|name"

    def fail_resolve(_path: Path, *, strict: bool = False) -> Path:
        raise OSError(
            22,
            "The filename, directory name, or volume label syntax is incorrect",
        )

    monkeypatch.setattr(Path, "resolve", fail_resolve)

    with pytest.raises(ToolExecutionFailure) as excinfo:
        guard.resolve_read_path(str(requested))

    message = excinfo.value.message
    assert str(Path("nested") / "bad|name") in message
    assert "'|'" in message
    assert str(guard.root) not in message


def test_resolve_path_missing_placeholder_keeps_missing_wording_and_adds_reason(
    guard: WorkspaceGuard,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    requested = "[redacted:path]/sandbox"

    def fail_resolve(_path: Path, *, strict: bool = False) -> Path:
        raise FileNotFoundError(2, "No such file or directory")

    monkeypatch.setattr(Path, "resolve", fail_resolve)

    with pytest.raises(ToolExecutionFailure) as excinfo:
        guard.resolve_read_path(requested)

    message = excinfo.value.message
    assert "path does not exist" in message
    assert '"[redacted:path]" is a log redaction placeholder, not a real path' in message


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


# -- Home-relative paths ------------------------------------------------


@pytest.fixture()
def home_relative_workspace(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> tuple[WorkspaceGuard, Path, Path]:
    fake_home = tmp_path / "home"
    workspace = fake_home / "Documents" / "proj"
    source = workspace / "src" / "a.py"
    source.parent.mkdir(parents=True)
    source.write_text("value = 1\n", encoding="utf-8")
    monkeypatch.setattr(Path, "home", classmethod(lambda _cls: fake_home))
    return WorkspaceGuard(str(workspace)), fake_home, workspace


@pytest.mark.parametrize("separator", sorted({"/", os.sep}))
def test_home_relative_read_path_resolves_inside_workspace(
    home_relative_workspace: tuple[WorkspaceGuard, Path, Path],
    separator: str,
) -> None:
    guard, fake_home, workspace = home_relative_workspace
    relative_root = separator.join(workspace.relative_to(fake_home).parts)
    requested = f"~{separator}{relative_root}{separator}src{separator}a.py"

    assert guard.resolve_read_path(requested) == (workspace / "src" / "a.py").resolve()


def test_home_relative_write_path_targets_workspace(
    home_relative_workspace: tuple[WorkspaceGuard, Path, Path],
) -> None:
    guard, fake_home, workspace = home_relative_workspace
    relative_root = os.sep.join(workspace.relative_to(fake_home).parts)

    assert (
        guard.resolve_write_path(f"~{os.sep}{relative_root}{os.sep}new.txt")
        == (workspace / "new.txt").resolve()
    )


def test_home_relative_path_outside_workspace_matches_absolute_rejection(
    home_relative_workspace: tuple[WorkspaceGuard, Path, Path],
) -> None:
    guard, fake_home, _workspace = home_relative_workspace
    outside = fake_home / "outside" / "x.txt"
    outside.parent.mkdir()
    outside.write_text("outside\n", encoding="utf-8")

    with pytest.raises(ToolExecutionFailure) as absolute_excinfo:
        guard.resolve_read_path(str(outside))
    with pytest.raises(ToolExecutionFailure) as home_relative_excinfo:
        guard.resolve_read_path(f"~{os.sep}outside{os.sep}x.txt")

    assert home_relative_excinfo.value.code == absolute_excinfo.value.code


def test_home_relative_path_without_home_is_a_tool_failure(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def missing_home(_cls: type[Path]) -> Path:
        raise RuntimeError("Could not determine home directory.")

    guard = WorkspaceGuard(str(tmp_path))
    monkeypatch.setattr(Path, "home", classmethod(missing_home))

    with pytest.raises(ToolExecutionFailure) as excinfo:
        guard.resolve_read_path("~/proj/a.py")

    assert excinfo.value.code == CMP_TOOL_INVALID_PATH
    assert "home directory is unavailable" in excinfo.value.message


def test_tilde_user_form_remains_workspace_relative(
    home_relative_workspace: tuple[WorkspaceGuard, Path, Path],
) -> None:
    guard, _fake_home, workspace = home_relative_workspace
    target = workspace / "~other" / "x"
    target.parent.mkdir()
    target.write_text("relative\n", encoding="utf-8")

    assert guard.resolve_read_path(f"~other{os.sep}x") == target.resolve()


def test_explicit_relative_tilde_directory_remains_reachable(
    home_relative_workspace: tuple[WorkspaceGuard, Path, Path],
) -> None:
    guard, _fake_home, workspace = home_relative_workspace
    target = workspace / "~" / "file.txt"
    target.parent.mkdir()
    target.write_text("literal tilde\n", encoding="utf-8")

    assert guard.resolve_read_path("./~/file.txt") == target.resolve()


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
