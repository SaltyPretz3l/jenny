from __future__ import annotations

import sys
from pathlib import Path

import pytest

from sidecar.ai.error_codes import (
    CMP_TOOL_INVALID_PATH,
    CMP_TOOL_IO_FAILED,
    CMP_TOOL_OUTSIDE_WORKSPACE,
)
from sidecar.ai.tools.builtins import grep_search as grep_module
from sidecar.ai.tools.builtins.regex_safety import looks_like_catastrophic_regex
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.workspace import WorkspaceGuard


def _guard(tmp_path: Path) -> WorkspaceGuard:
    return WorkspaceGuard(str(tmp_path))


@pytest.fixture(autouse=True)
def _reset_grep_config() -> None:
    grep_module.configure_grep_search(None)
    yield
    grep_module.configure_grep_search(None)


def test_grep_search_finds_basic_matches(tmp_path: Path) -> None:
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "app.py").write_text("needle = 1\nother = 2\n", encoding="utf-8")

    result = grep_module.grep_search_tool({"pattern": "needle"}, _guard(tmp_path))

    assert result.success is True
    assert result.metadata["match_count"] == 1
    assert result.metadata["returned_match_count"] == 1
    assert result.metadata["total_match_count"] == 1
    assert result.metadata["file_count"] == 1
    assert "src/app.py:1:needle = 1" in result.output


def test_grep_search_exposes_audited_bound_contract() -> None:
    assert grep_module.MAX_RESULTS == 500
    assert grep_module.MAX_OUTPUT_BYTES == 20_000
    assert grep_module.REGEX_SEARCH_TIMEOUT_SECONDS == 5.0
    assert grep_module.REGEX_WORKER_STARTUP_TIMEOUT_SECONDS == 15.0
    assert grep_module.MAX_TOTAL_RUNTIME_SECONDS == 30.0
    assert grep_module.LARGE_FILE_HINT == (
        "Use paginated read_file with offset/limit to inspect large files."
    )


def test_grep_search_honors_include_glob(tmp_path: Path) -> None:
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "app.py").write_text("needle\n", encoding="utf-8")
    (tmp_path / "src" / "notes.txt").write_text("needle\n", encoding="utf-8")

    result = grep_module.grep_search_tool(
        {"pattern": "needle", "include_glob": "*.py"},
        _guard(tmp_path),
    )

    assert "src/app.py:1:needle" in result.output
    assert "notes.txt" not in result.output


def test_grep_search_include_glob_expands_brace_alternatives(tmp_path: Path) -> None:
    for name in ("app.js", "theme.css", "page.html", "notes.txt"):
        (tmp_path / name).write_text("needle\n", encoding="utf-8")

    result = grep_module.grep_search_tool(
        {"pattern": "needle", "include_glob": "*.{js,css,html}"},
        _guard(tmp_path),
    )

    assert result.metadata["file_count"] == 3
    assert "app.js:1:needle" in result.output
    assert "theme.css:1:needle" in result.output
    assert "page.html:1:needle" in result.output
    assert "notes.txt" not in result.output


def test_grep_search_leading_double_star_matches_root_and_nested_files(tmp_path: Path) -> None:
    (tmp_path / "nested").mkdir()
    (tmp_path / "root.json").write_text("needle\n", encoding="utf-8")
    (tmp_path / "nested" / "child.json").write_text("needle\n", encoding="utf-8")

    result = grep_module.grep_search_tool(
        {"pattern": "needle", "include_glob": "**/*.json"},
        _guard(tmp_path),
    )

    assert "root.json:1:needle" in result.output
    assert "nested/child.json:1:needle" in result.output


def test_grep_search_supports_case_insensitive_matching(tmp_path: Path) -> None:
    (tmp_path / "app.txt").write_text("Needle\n", encoding="utf-8")

    result = grep_module.grep_search_tool(
        {"pattern": "needle", "ignore_case": True},
        _guard(tmp_path),
    )

    assert "app.txt:1:Needle" in result.output


def test_grep_search_includes_context_lines(tmp_path: Path) -> None:
    (tmp_path / "app.txt").write_text("zero\none\nneedle\ntwo\nthree\n", encoding="utf-8")

    result = grep_module.grep_search_tool(
        {"pattern": "needle", "context_lines": 1},
        _guard(tmp_path),
    )

    assert "app.txt:2:one" in result.output
    assert "app.txt:3:needle" in result.output
    assert "app.txt:4:two" in result.output


def test_grep_search_skips_binary_files(tmp_path: Path) -> None:
    (tmp_path / "binary.dat").write_bytes(b"\x00\x01\x02needle")

    result = grep_module.grep_search_tool({"pattern": "needle"}, _guard(tmp_path))

    assert result.success is True
    assert result.metadata["skipped_binary_files"] == 1
    assert "No matches found" in result.output


def test_grep_search_skips_large_files(tmp_path: Path) -> None:
    grep_module.configure_grep_search({"tools_max_search_file_bytes": 1024})
    (tmp_path / "large.txt").write_text("needle\n" * 300, encoding="utf-8")

    result = grep_module.grep_search_tool({"pattern": "needle"}, _guard(tmp_path))

    assert result.success is False
    assert result.error_code == CMP_TOOL_IO_FAILED
    assert result.metadata["skipped_large_files"] == 1
    assert "offset/limit" in result.output


def test_grep_search_mixed_binary_and_large_files_reports_no_searchable_candidates(
    tmp_path: Path,
) -> None:
    grep_module.configure_grep_search({"tools_max_search_file_bytes": 1024})
    (tmp_path / "binary.dat").write_bytes(b"\x00needle")
    (tmp_path / "large.txt").write_text("needle\n" * 300, encoding="utf-8")

    result = grep_module.grep_search_tool({"pattern": "needle"}, _guard(tmp_path))

    assert result.success is False
    assert result.error_code == CMP_TOOL_IO_FAILED
    assert result.metadata["candidate_files"] == 0
    assert result.metadata["skipped_binary_files"] == 1
    assert result.metadata["skipped_large_files"] == 1


def test_grep_search_truncates_long_lines(tmp_path: Path) -> None:
    long_line = "needle " + ("x" * 800) + "\n"
    (tmp_path / "app.txt").write_text(long_line, encoding="utf-8")

    result = grep_module.grep_search_tool({"pattern": "needle"}, _guard(tmp_path))

    assert result.success is True
    assert result.metadata["truncated_by_line_length"] is True
    assert "[truncated]" in result.output


def test_grep_search_reports_output_byte_truncation_and_total_matches(tmp_path: Path) -> None:
    lines = "".join(f"needle {index} " + ("x" * 450) + "\n" for index in range(80))
    (tmp_path / "app.txt").write_text(lines, encoding="utf-8")

    result = grep_module.grep_search_tool(
        {"pattern": "needle", "max_results": 80}, _guard(tmp_path)
    )

    assert result.success is True
    assert result.metadata["truncated_by_bytes"] is True
    assert result.metadata["returned_match_count"] < result.metadata["total_match_count"]
    assert result.metadata["match_count"] == result.metadata["total_match_count"]
    assert "Output truncated" in result.output


def test_grep_search_reports_truncation(tmp_path: Path) -> None:
    lines = "\n".join(f"needle {index}" for index in range(5)) + "\n"
    (tmp_path / "app.txt").write_text(lines, encoding="utf-8")

    result = grep_module.grep_search_tool(
        {"pattern": "needle", "max_results": 2},
        _guard(tmp_path),
    )

    assert result.metadata["match_count"] == 5
    assert result.metadata["returned_match_count"] == 2
    assert result.metadata["total_match_count"] == 5
    assert result.metadata["truncated"] is True
    assert "Displayed 2 of 5 matches." in result.output


def test_bounded_int_preserves_explicit_zero_for_positive_default() -> None:
    assert grep_module._bounded_int(0, default=grep_module.DEFAULT_MAX_RESULTS, maximum=500) == 0


def test_grep_search_does_not_treat_string_false_as_ignore_case(tmp_path: Path) -> None:
    (tmp_path / "app.txt").write_text("Needle\n", encoding="utf-8")

    result = grep_module.grep_search_tool(
        {"pattern": "needle", "ignore_case": "false"},
        _guard(tmp_path),
    )

    assert result.success is True
    assert result.metadata["match_count"] == 0
    assert "No matches found" in result.output


def test_grep_search_rejects_unsafe_path(tmp_path: Path) -> None:
    outside = tmp_path.parent / "grep_outside"
    outside.mkdir(exist_ok=True)

    with pytest.raises(ToolExecutionFailure) as exc_info:
        grep_module.grep_search_tool({"pattern": "needle", "path": str(outside)}, _guard(tmp_path))

    assert exc_info.value.code == CMP_TOOL_OUTSIDE_WORKSPACE


def test_grep_search_returns_timeout_message_when_all_candidates_time_out(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    target = tmp_path / "app.txt"
    target.write_text("needle\n", encoding="utf-8")

    def _raise_timeout(*_args, **_kwargs):
        raise grep_module.FutureTimeoutError()

    monkeypatch.setattr(grep_module, "_search_file_with_timeout", _raise_timeout)

    result = grep_module.grep_search_tool({"pattern": "needle"}, _guard(tmp_path))

    assert result.success is False
    assert result.error_code == "CMP-TOOL-0008"
    assert result.metadata["timed_out_files"] == 1
    assert "timed out" in result.output.lower()


def test_grep_search_rejects_obvious_catastrophic_regex(tmp_path: Path) -> None:
    (tmp_path / "app.txt").write_text("aaaaaaaaaaaaaaaa!\n", encoding="utf-8")

    with pytest.raises(ToolExecutionFailure) as exc_info:
        grep_module.grep_search_tool({"pattern": "(a+)+$"}, _guard(tmp_path))

    assert exc_info.value.code == CMP_TOOL_INVALID_PATH
    assert "catastrophic" in exc_info.value.message.lower()


def test_grep_search_aborts_after_timeout_cap(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    for index in range(5):
        (tmp_path / f"file_{index}.txt").write_text("needle\n", encoding="utf-8")

    def _raise_timeout(*_args, **_kwargs):
        raise grep_module.FutureTimeoutError()

    monkeypatch.setattr(grep_module, "_search_file_with_timeout", _raise_timeout)

    result = grep_module.grep_search_tool({"pattern": "needle"}, _guard(tmp_path))

    assert result.success is False
    assert result.error_code == "CMP-TOOL-0008"
    assert result.metadata["timed_out_files"] == 3
    assert result.metadata["aborted_by_timeout_cap"] is True
    assert "too many files timed out" in result.output.lower()


def test_grep_search_aborts_when_total_runtime_budget_is_exhausted(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    (tmp_path / "app.txt").write_text("needle\n", encoding="utf-8")
    monkeypatch.setattr(grep_module, "MAX_TOTAL_RUNTIME_SECONDS", 0, raising=False)

    result = grep_module.grep_search_tool({"pattern": "needle"}, _guard(tmp_path))

    assert result.success is False
    assert result.error_code == "CMP-TOOL-0008"
    assert result.metadata["aborted_by_runtime_budget"] is True
    assert result.metadata["selected_files"] == 0
    assert "runtime budget" in result.output.lower()


def test_grep_search_timeout_resets_worker_state_without_leaving_process_alive(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    worker = grep_module._RegexSearchWorker()  # noqa: SLF001
    worker._ensure_started()  # noqa: SLF001
    process = worker._process  # noqa: SLF001
    assert process is not None
    assert process.poll() is None
    monkeypatch.setattr(worker, "_wait_for_response", lambda _timeout: None)

    with pytest.raises(grep_module.FutureTimeoutError):
        worker.search(
            path=Path("example.txt"),
            compiled=grep_module.re.compile("needle"),
            workspace_root=None,
            context_lines=0,
            max_output_matches=1,
            max_output_bytes=grep_module.MAX_OUTPUT_BYTES,
            timeout_seconds=0.01,
        )

    assert worker._process is None  # noqa: SLF001
    assert worker._responses is None  # noqa: SLF001
    assert process.poll() is not None


def test_grep_search_startup_timeout_is_distinct_from_search_timeout(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        grep_module, "REGEX_WORKER_STARTUP_TIMEOUT_SECONDS", 0.05
    )
    worker = grep_module._RegexSearchWorker(  # noqa: SLF001
        command_factory=lambda: [
            sys.executable,
            "-c",
            "import time; time.sleep(30)",
        ]
    )

    with pytest.raises(ToolExecutionFailure, match="startup timed out"):
        worker.search(
            path=Path("example.txt"),
            compiled=grep_module.re.compile("."),
            workspace_root=None,
            context_lines=0,
            max_output_matches=1,
            max_output_bytes=grep_module.MAX_OUTPUT_BYTES,
            timeout_seconds=0.01,
        )

    assert worker._process is None  # noqa: SLF001
    assert worker._responses is None  # noqa: SLF001


def test_grep_worker_command_uses_source_entrypoint(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(grep_module.sys, "frozen", False, raising=False)

    assert grep_module._grep_worker_command() == [  # noqa: SLF001
        sys.executable,
        "-m",
        "sidecar",
        "--grep-search-worker",
    ]


def test_grep_worker_command_uses_packaged_entrypoint(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(grep_module.sys, "frozen", True, raising=False)

    assert grep_module._grep_worker_command() == [  # noqa: SLF001
        sys.executable,
        "--grep-search-worker",
    ]


def test_grep_search_dot_pattern_succeeds_after_worker_readiness(tmp_path: Path) -> None:
    (tmp_path / "diagnostic.txt").write_text("ready\n", encoding="utf-8")

    result = grep_module.grep_search_tool(
        {"pattern": ".", "path": ".", "max_results": 5},
        _guard(tmp_path),
    )

    assert result.success is True
    assert result.metadata["match_count"] >= 1
    assert "diagnostic.txt" in result.output


# --------------------------------------------------------------------------
# looks_like_catastrophic_regex: the static PRE-FILTER shared with the monitor
# salience gate. It is deliberately over-broad and is not the real bound -- the
# subprocess timeout is (see sidecar/runtime/monitor_salience.py).
# --------------------------------------------------------------------------
@pytest.mark.parametrize(
    "pattern",
    [
        "(?:a|ab)+",     # non-capturing group: ?: must not hide the ambiguity
        "(a{2,}){3,}",   # bounded inner quantifier under an outer quantifier
        "(a+)+$",        # the classic nested-quantifier shape (already rejected)
        "(a|ab)*",       # ambiguous alternation under a star
    ],
)
def test_looks_like_catastrophic_regex_rejects(pattern: str) -> None:
    assert looks_like_catastrophic_regex(pattern) is True


@pytest.mark.parametrize(
    "pattern",
    [
        "(?:alpha|beta)+",   # disjoint alternatives: no prefix ambiguity
        "ERROR|WARN",        # top-level alternation, no group quantifier
        "(a|b)c",            # quantifier-free group
        r"(\d|\w)+x",        # single-char branches; SRE folds them into one charset
        r"(\w\d?)+x",        # genuinely exponential, and the heuristic cannot see it
    ],
)
def test_looks_like_catastrophic_regex_accepts(pattern: str) -> None:
    assert looks_like_catastrophic_regex(pattern) is False
def test_budget_exhaustion_never_claims_complete_zero_match(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    (tmp_path / "a.txt").write_text("haystack\n", encoding="utf-8")
    monkeypatch.setattr(grep_module, "_runtime_budget_exhausted", lambda _started: True)

    result = grep_module.grep_search_tool({"pattern": "needle"}, _guard(tmp_path))

    assert result.success is False
    assert result.metadata["scan_complete"] is False
    assert result.metadata["files_remaining"] is None
    assert result.metadata["narrowing_hint"]
    assert "No complete zero-match conclusion" in result.output
