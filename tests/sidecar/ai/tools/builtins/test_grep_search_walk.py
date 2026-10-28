"""grep_search candidate walk: shared globbing, links, budgets and unreadable files."""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest

from sidecar.ai.error_codes import CMP_TOOL_INVALID_PATH, CMP_TOOL_IO_FAILED
from sidecar.ai.tools.builtins import grep_search as grep_module
from sidecar.ai.tools.builtins.regex_safety import MAX_PATTERN_CHARS, compile_safe_pattern
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.workspace import WorkspaceGuard
from tests.sidecar._platform_skips import make_dir_link, windows_only


def _guard(tmp_path: Path) -> WorkspaceGuard:
    return WorkspaceGuard(str(tmp_path))


@pytest.fixture(autouse=True)
def _reset_grep_config() -> Iterator[None]:
    grep_module.configure_grep_search(None)
    yield
    grep_module.configure_grep_search(None)


def _write(path: Path, text: str = "needle\n") -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def test_include_glob_double_star_spans_directories_and_is_anchored(tmp_path: Path) -> None:
    for relative in ("src/a.py", "src/sub/b.py", "src/sub/deep/c.py", "lib/src/d.py"):
        _write(tmp_path / relative)

    result = grep_module.grep_search_tool(
        {"pattern": "needle", "include_glob": "src/**/*.py"}, _guard(tmp_path)
    )

    assert "src/a.py:1:needle" in result.output
    assert "src/sub/b.py:1:needle" in result.output
    assert "src/sub/deep/c.py:1:needle" in result.output
    assert "lib/src/d.py" not in result.output
    assert result.metadata["file_count"] == 3


def test_grep_and_glob_share_one_matcher() -> None:
    from sidecar.ai.tools.builtins import glob_files, grep_search_file

    assert glob_files.matches_relative_glob is grep_search_file.matches_relative_glob
    assert grep_module.matches_relative_glob is grep_search_file.matches_relative_glob


def test_unreadable_file_is_skipped_without_echoing_its_path(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _write(tmp_path / "a.txt")
    _write(tmp_path / "b.txt")
    denied = tmp_path / "b.txt"
    original = grep_module.is_binary_file

    def inspect(path: Path) -> bool:
        if path.name == "b.txt":
            raise ToolExecutionFailure(
                code=CMP_TOOL_IO_FAILED,
                message=f"failed to inspect file: [Errno 13] Permission denied: '{denied}'",
                retryable=True,
            )
        return original(path)

    monkeypatch.setattr(grep_module, "is_binary_file", inspect)

    result = grep_module.grep_search_tool({"pattern": "needle"}, _guard(tmp_path))

    assert result.success is True
    assert result.metadata["skipped_unreadable_files"] == 1
    assert result.metadata["total_match_count"] == 1
    assert "a.txt:1:needle" in result.output
    assert "Skipped 1 file(s) that could not be read." in result.output
    assert str(tmp_path) not in result.output
    assert "Permission denied" not in result.output


def test_worker_side_read_failure_is_skipped_per_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _write(tmp_path / "a.txt")
    _write(tmp_path / "b.txt")
    original = grep_module._search_file_with_timeout

    def search(path: Path, *args: object, **kwargs: object) -> object:
        if path.name == "a.txt":
            raise ToolExecutionFailure(
                code=CMP_TOOL_IO_FAILED,
                message=f"grep worker failed: [Errno 13] Permission denied: '{path}'",
                retryable=True,
            )
        return original(path, *args, **kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr(grep_module, "_search_file_with_timeout", search)

    result = grep_module.grep_search_tool({"pattern": "needle"}, _guard(tmp_path))

    assert result.success is True
    assert result.metadata["skipped_unreadable_files"] == 1
    assert result.metadata["candidate_files"] == 1
    assert "b.txt:1:needle" in result.output
    assert str(tmp_path) not in result.output


def test_a_run_of_unreadable_files_aborts_as_systemic(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    for index in range(grep_module.MAX_CONSECUTIVE_UNREADABLE_FILES + 5):
        _write(tmp_path / f"f{index:02d}.txt")

    def inspect(path: Path) -> bool:
        raise ToolExecutionFailure(
            code=CMP_TOOL_IO_FAILED, message=f"failed to inspect file: {path}", retryable=True
        )

    monkeypatch.setattr(grep_module, "is_binary_file", inspect)

    with pytest.raises(ToolExecutionFailure) as excinfo:
        grep_module.grep_search_tool({"pattern": "needle"}, _guard(tmp_path))

    assert excinfo.value.code == CMP_TOOL_IO_FAILED
    assert f"{grep_module.MAX_CONSECUTIVE_UNREADABLE_FILES} files in a row" in (
        excinfo.value.message
    )
    assert str(tmp_path) not in excinfo.value.message


def test_a_worker_failure_still_aborts_the_search(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _write(tmp_path / "a.txt")

    def search(*_args: object, **_kwargs: object) -> object:
        raise grep_module._WorkerUnavailable(
            code=CMP_TOOL_IO_FAILED, message="grep worker failed to start", retryable=True
        )

    monkeypatch.setattr(grep_module, "_search_file_with_timeout", search)

    with pytest.raises(ToolExecutionFailure, match="failed to start"):
        grep_module.grep_search_tool({"pattern": "needle"}, _guard(tmp_path))


def test_walk_stops_on_runtime_budget_when_include_glob_filters_everything(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    for index in range(300):
        _write(tmp_path / f"f{index:03d}.txt")
    clock = iter([0.0])
    # The first reading is the start time; every later reading is past the budget.
    monkeypatch.setattr(grep_module, "_monotonic_seconds", lambda: next(clock, 1e9))

    result = grep_module.grep_search_tool(
        {"pattern": "needle", "include_glob": "*.nomatch"}, _guard(tmp_path)
    )

    assert result.success is False
    assert result.metadata["aborted_by_runtime_budget"] is True
    assert result.metadata["selected_files"] == 0
    assert "runtime budget" in result.output.lower()


@windows_only("directory junction traversal")
def test_walk_does_not_follow_junctions(tmp_path: Path) -> None:
    _write(tmp_path / "real" / "a.txt")
    make_dir_link(tmp_path / "alias", tmp_path / "real")
    make_dir_link(tmp_path / "real" / "loop", tmp_path)

    result = grep_module.grep_search_tool({"pattern": "needle"}, _guard(tmp_path))

    assert result.metadata["total_match_count"] == 1
    assert result.metadata["selected_files"] == 1
    assert "real/a.txt:1:needle" in result.output


def test_walk_resolves_containment_per_directory_not_per_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    for index in range(20):
        _write(tmp_path / "sub" / f"f{index}.txt")
    guard = _guard(tmp_path)
    calls: list[Path] = []
    original = WorkspaceGuard.ensure_within_root

    def counting(self: WorkspaceGuard, path: Path) -> Path:
        calls.append(path)
        return original(self, path)

    monkeypatch.setattr(WorkspaceGuard, "ensure_within_root", counting)

    files = list(grep_module._iter_candidate_files(tmp_path, guard, None))

    assert len(files) == 20
    assert calls == [tmp_path / "sub"]


def test_compile_safe_pattern_rejects_overlong_patterns_before_the_heuristic() -> None:
    compile_safe_pattern("a" * MAX_PATTERN_CHARS, error_code=CMP_TOOL_INVALID_PATH)

    with pytest.raises(ToolExecutionFailure) as excinfo:
        compile_safe_pattern("(" * (MAX_PATTERN_CHARS + 1), error_code=CMP_TOOL_INVALID_PATH)

    assert excinfo.value.code == CMP_TOOL_INVALID_PATH
    assert excinfo.value.retryable is False
    assert f"exceeds {MAX_PATTERN_CHARS} characters" in excinfo.value.message
