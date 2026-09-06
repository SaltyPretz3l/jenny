from __future__ import annotations

import os
from pathlib import Path

import pytest

import sidecar.ai.tools.builtins.glob_files as glob_module
from sidecar.ai.error_codes import CMP_TOOL_INVALID_PATH
from sidecar.ai.tools.builtins.glob_files import (
    MAX_GLOB_RESULTS,
    _resolve_search_plan,
    glob_files_tool,
)
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.workspace import WorkspaceGuard


def _guard(tmp_path: Path) -> WorkspaceGuard:
    return WorkspaceGuard(str(tmp_path))


def test_glob_files_finds_basic_matches(tmp_path: Path) -> None:
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "app.py").write_text("print('hi')\n", encoding="utf-8")
    (tmp_path / "src" / "notes.txt").write_text("notes\n", encoding="utf-8")

    result = glob_files_tool({"pattern": "**/*.py"}, _guard(tmp_path))

    assert result.metadata == {
        "match_count": 1,
        "truncated": False,
        "files_scanned": 2,
        "directories_scanned": 2,
        "matched_count_scanned": 1,
        "scan_complete": True,
        "truncation_reason": None,
    }
    assert "src/app.py" in result.output
    assert "notes.txt" not in result.output


def test_glob_files_expands_bounded_brace_alternatives(tmp_path: Path) -> None:
    for name in ("app.js", "theme.css", "page.html", "notes.txt"):
        (tmp_path / name).write_text("x\n", encoding="utf-8")

    result = glob_files_tool({"pattern": "*.{js,css,html}"}, _guard(tmp_path))

    # Lines 0-2 are the W2 path echo, its blank separator, and the summary line.
    returned = set(result.output.splitlines()[3:])
    assert returned == {"app.js", "theme.css", "page.html"}


def test_glob_files_rejects_excessive_brace_expansion(tmp_path: Path) -> None:
    alternatives = ",".join(f"ext{index}" for index in range(40))

    with pytest.raises(ToolExecutionFailure) as exc_info:
        glob_files_tool({"pattern": f"*.{{{alternatives}}}"}, _guard(tmp_path))

    assert exc_info.value.code == CMP_TOOL_INVALID_PATH
    assert "brace" in exc_info.value.message


def test_glob_files_skips_noise_directories(tmp_path: Path) -> None:
    (tmp_path / ".git").mkdir()
    (tmp_path / ".git" / "config.py").write_text("ignored\n", encoding="utf-8")
    (tmp_path / "pkg").mkdir()
    (tmp_path / "pkg" / "module.py").write_text("kept\n", encoding="utf-8")

    result = glob_files_tool({"pattern": "**/*.py"}, _guard(tmp_path))

    assert "pkg/module.py" in result.output
    assert ".git/config.py" not in result.output


def test_glob_files_reports_truncation(tmp_path: Path) -> None:
    for index in range(MAX_GLOB_RESULTS + 1):
        (tmp_path / f"file_{index:03d}.py").write_text("x\n", encoding="utf-8")

    result = glob_files_tool({"pattern": "*.py"}, _guard(tmp_path))

    assert result.metadata["match_count"] == MAX_GLOB_RESULTS
    assert result.metadata["truncated"] is True
    assert result.metadata["matched_count_scanned"] == MAX_GLOB_RESULTS + 1
    assert result.metadata["scan_complete"] is True
    assert result.metadata["truncation_reason"] == "result_limit"
    assert "showing newest" in result.output


def test_glob_files_stops_at_scan_limit_and_marks_partial_subset(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    for index in range(5):
        (tmp_path / f"file_{index}.py").write_text("x\n", encoding="utf-8")
    monkeypatch.setattr(glob_module, "MAX_GLOB_SCAN_FILES", 3)

    result = glob_files_tool({"pattern": "*.py"}, _guard(tmp_path))

    assert result.metadata["files_scanned"] == 3
    assert result.metadata["matched_count_scanned"] == 3
    assert result.metadata["scan_complete"] is False
    assert result.metadata["truncation_reason"] == "scan_limit"
    assert "Partial results" in result.output
    assert "newest 3 within the scanned subset" in result.output


def test_glob_files_stops_at_time_budget_and_marks_partial_subset(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    for index in range(3):
        (tmp_path / f"file_{index}.py").write_text("x\n", encoding="utf-8")
    ticks = iter([0.0, 0.0, 0.0, 0.0, 0.0, 3.0])
    monkeypatch.setattr(glob_module, "monotonic", lambda: next(ticks))

    result = glob_files_tool({"pattern": "*.py"}, _guard(tmp_path))

    assert result.metadata["files_scanned"] == 1
    assert result.metadata["matched_count_scanned"] == 1
    assert result.metadata["scan_complete"] is False
    assert result.metadata["truncation_reason"] == "time_budget"
    assert "time budget reached" in result.output


@pytest.mark.parametrize(
    ("pattern", "expected"),
    [
        ("**/*.py", {"app.py", "pkg/app.py", "pkg/deep/app.py"}),
        ("src/**/*.py", {"src/app.py", "src/pkg/app.py"}),
    ],
)
def test_glob_files_double_star_matches_zero_or_more_directories(
    tmp_path: Path,
    pattern: str,
    expected: set[str],
) -> None:
    (tmp_path / "pkg" / "deep").mkdir(parents=True)
    (tmp_path / "src" / "pkg").mkdir(parents=True)
    for relative in [
        "app.py",
        "pkg/app.py",
        "pkg/deep/app.py",
        "src/app.py",
        "src/pkg/app.py",
    ]:
        (tmp_path / relative).write_text("x\n", encoding="utf-8")

    result = glob_files_tool({"pattern": pattern}, _guard(tmp_path))

    returned = set(result.output.splitlines()[1:])
    assert expected <= returned


def test_glob_files_directory_budget_stops_many_empty_directories(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    for index in range(8):
        (tmp_path / f"empty-{index}").mkdir()
    monkeypatch.setattr(glob_module, "MAX_GLOB_SCAN_DIRECTORIES", 4)

    result = glob_files_tool({"pattern": "**/*.py"}, _guard(tmp_path))

    assert result.metadata["scan_complete"] is False
    assert result.metadata["truncation_reason"] == "directory_limit"
    assert result.metadata["directories_scanned"] == 1


def test_glob_files_ignores_case_variants_on_case_insensitive_filesystems(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(glob_module.os, "name", "nt")
    monkeypatch.setattr(glob_module.os.path, "normcase", lambda value: value.lower())

    assert glob_module._ignored_directory_name("NODE_MODULES") is True  # noqa: SLF001


def test_glob_files_orders_results_by_newest_mtime_then_filename(tmp_path: Path) -> None:
    older = tmp_path / "older.py"
    newer = tmp_path / "newer.py"
    older.write_text("older\n", encoding="utf-8")
    newer.write_text("newer\n", encoding="utf-8")
    os.utime(older, (1_700_000_000, 1_700_000_000))
    os.utime(newer, (1_800_000_000, 1_800_000_000))

    result = glob_files_tool({"pattern": "*.py"}, _guard(tmp_path))

    output_lines = result.output.splitlines()
    assert output_lines[3:] == ["newer.py", "older.py"]


def test_glob_files_narrows_walk_root_from_static_pattern_prefix(tmp_path: Path) -> None:
    (tmp_path / "src").mkdir()

    search_root, match_pattern = _resolve_search_plan("src/**/*.py", tmp_path, _guard(tmp_path))

    assert search_root == tmp_path / "src"
    assert match_pattern == "**/*.py"


def test_glob_files_skips_symlink_escape(tmp_path: Path) -> None:
    outside = tmp_path.parent / "outside_glob"
    outside.mkdir(exist_ok=True)
    (outside / "secret.py").write_text("secret\n", encoding="utf-8")
    link_path = tmp_path / "escape_link"

    try:
        link_path.symlink_to(outside, target_is_directory=True)
    except (NotImplementedError, OSError):
        pytest.skip("symlink creation unavailable in this environment")

    result = glob_files_tool({"pattern": "**/*.py"}, _guard(tmp_path))

    assert "secret.py" not in result.output


def test_glob_files_rejects_unsafe_search_path(tmp_path: Path) -> None:
    outside = tmp_path.parent / "glob_outside"
    outside.mkdir(exist_ok=True)

    with pytest.raises(ToolExecutionFailure) as exc_info:
        glob_files_tool({"pattern": "**/*.py", "path": str(outside)}, _guard(tmp_path))

    assert exc_info.value.code == "CMP-TOOL-0003"


def test_glob_files_rejects_static_prefix_traversal(tmp_path: Path) -> None:
    outside = tmp_path.parent / "glob_static_prefix_outside"
    outside.mkdir(exist_ok=True)
    (outside / "secret.py").write_text("secret\n", encoding="utf-8")

    with pytest.raises(ToolExecutionFailure) as exc_info:
        glob_files_tool({"pattern": "../glob_static_prefix_outside/*.py"}, _guard(tmp_path))

    assert exc_info.value.code == "CMP-TOOL-0003"
