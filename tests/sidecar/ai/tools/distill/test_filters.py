"""Tests for the per-shape output filters (test / build / lint).

RED-FIRST: authored before the filter modules exist.

The load-bearing invariants pinned here:
- every error/failure/traceback line survives ``distill`` verbatim in ``kept``;
- a pass/progress parade collapses into ``OmittedSegment``s;
- a summary line's failure count is preserved;
- nothing is lost: kept (with placeholders re-expanded) + omitted == raw.
"""

from __future__ import annotations

from sidecar.ai.tools.distill.filters.base import (
    DistillOutput,
    OmittedSegment,
    omission_placeholder,
)
from sidecar.ai.tools.distill.filters.build_output import BuildOutputFilter
from sidecar.ai.tools.distill.filters.lint_output import LintOutputFilter
from sidecar.ai.tools.distill.filters.test_output import TestOutputFilter


def _reconstruct(result: DistillOutput) -> str:
    """Re-expand placeholders in ``kept`` with their omitted segments — the
    filter-level reversibility check (nothing dropped, order preserved)."""
    lines = result.kept.split("\n")
    out: list[str] = []
    for line in lines:
        matched: OmittedSegment | None = None
        for idx, seg in enumerate(result.omitted):
            if line == omission_placeholder(idx):
                matched = seg
                break
        if matched is not None:
            out.append(matched.text)
        else:
            out.append(line)
    return "\n".join(out)


PYTEST_LOG = """============================= test session starts =============================
platform win32 -- Python 3.11.7, pytest-9.0.2
rootdir: /repo
collected 8 items

tests/test_a.py .....                                                     [ 62%]
tests/test_b.py ..F                                                       [100%]

================================== FAILURES ===================================
_________________________________ test_three _________________________________

    def test_three():
>       assert 1 == 2
E       assert 1 == 2

tests/test_b.py:9: AssertionError
=========================== short test summary info ===========================
FAILED tests/test_b.py::test_three - assert 1 == 2
========================= 1 failed, 7 passed in 0.05s =========================
"""


class TestTestOutputFilter:
    def test_matches_command_and_content(self) -> None:
        f = TestOutputFilter()
        assert f.matches(command="pytest -q", content="")
        assert f.matches(command="uv run pytest", content="")
        assert f.matches(command="./run.sh", content=PYTEST_LOG)
        assert not f.matches(command="ls", content="nothing to see")

    def test_error_lines_survive_and_parade_collapses(self) -> None:
        f = TestOutputFilter()
        result = f.distill(PYTEST_LOG)
        # Every failure/assertion line survives verbatim.
        assert "FAILED tests/test_b.py::test_three - assert 1 == 2" in result.kept
        assert ">       assert 1 == 2" in result.kept
        assert "E       assert 1 == 2" in result.kept
        assert "tests/test_b.py:9: AssertionError" in result.kept
        # The failure count in the summary is preserved.
        assert "1 failed, 7 passed in 0.05s" in result.kept
        # The pass/progress parade collapsed into at least one omitted segment.
        assert result.omitted
        # Nothing is lost.
        assert _reconstruct(result) == PYTEST_LOG.rstrip("\n") or _reconstruct(
            result
        ) == PYTEST_LOG

    def test_all_pass_progress_is_collapsed(self) -> None:
        f = TestOutputFilter()
        raw = "\n".join(f"tests/test_{i}.py ..... [ {i}%]" for i in range(20))
        result = f.distill(raw)
        assert result.omitted  # a long parade collapses
        assert _reconstruct(result) == raw

    def test_short_output_not_collapsed(self) -> None:
        f = TestOutputFilter()
        raw = "one pass line\nanother pass line"
        result = f.distill(raw)
        # Below the min-omit threshold → nothing collapsed, nothing lost.
        assert result.omitted == []
        assert result.kept == raw

    def test_node_tap_and_safe_runner_failure_headlines_survive(self) -> None:
        raw = "\n".join(
            [f"ok {index} - passing test" for index in range(12)]
            + [
                "not ok 13 - focus ring uses valid syntax",
                "  error: expected rule for .chat-entry:focus-visible",
                "FAIL: tests/chat-a11y-v2-css.test.js",
                "Tests: 1 failed, 12 passed",
                "Observed exit code: 1",
            ]
        )
        result = TestOutputFilter().distill(raw)
        assert "not ok 13 - focus ring uses valid syntax" in result.kept
        assert "error: expected rule" in result.kept
        assert "FAIL: tests/chat-a11y-v2-css.test.js" in result.kept
        assert "Tests: 1 failed, 12 passed" in result.kept
        assert "Observed exit code: 1" in result.kept
        assert result.omitted
        assert _reconstruct(result) == raw

    def test_unicode_error_marker_line_survives(self) -> None:
        # Jest-style ✕ failure line amid non-ASCII parade text must be kept.
        f = TestOutputFilter()
        raw = (
            "\n".join(f"ok line {i} päss" for i in range(10))
            + "\n  ✕ renders börk component (12 ms)\n"
            + "Tests: 1 failed, 10 passed"
        )
        result = f.distill(raw)
        assert "  ✕ renders börk component (12 ms)" in result.kept
        assert "Tests: 1 failed, 10 passed" in result.kept
        assert result.omitted  # the päss parade collapsed
        assert _reconstruct(result) == raw


    def test_complete_multiframe_traceback_survives_between_progress_runs(self) -> None:
        traceback = "\n".join(
            [
                "Traceback (most recent call last):",
                '  File "a.py", line 1, in main',
                "    run()",
                '  File "b.py", line 2, in run',
                "    boom()",
                "ValueError: bad",
            ]
        )
        raw = "\n".join(
            [*(f"tests/test_{i}.py ." for i in range(8)), traceback]
        )

        result = TestOutputFilter().distill(raw)

        assert traceback in result.kept
        assert result.omitted
        assert _reconstruct(result) == raw


class TestBuildOutputFilter:
    TSC_LOG = "\n".join(
        ["Compiling module {}".format(i) for i in range(15)]
        + [
            "src/app.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.",
            "src/app.ts(40,1): error TS1005: ';' expected.",
            "Found 2 errors.",
        ]
    )

    def test_matches(self) -> None:
        f = BuildOutputFilter()
        assert f.matches(command="tsc --noEmit", content="")
        assert f.matches(command="cargo build", content="")
        assert not f.matches(command="pytest", content="")

    def test_errors_survive_and_progress_collapses(self) -> None:
        f = BuildOutputFilter()
        result = f.distill(self.TSC_LOG)
        assert "src/app.ts(12,5): error TS2322" in result.kept
        assert "src/app.ts(40,1): error TS1005" in result.kept
        assert "Found 2 errors." in result.kept
        assert result.omitted  # the "Compiling ..." parade collapsed
        assert _reconstruct(result) == self.TSC_LOG


class TestLintOutputFilter:
    RUFF_LOG = "\n".join(
        ["checking file {}.py".format(i) for i in range(12)]
        + [
            "sidecar/x.py:10:1: E402 module level import not at top of file",
            "sidecar/y.py:3:80: E501 line too long (100 > 88 characters)",
            "Found 2 errors.",
        ]
    )

    def test_matches(self) -> None:
        f = LintOutputFilter()
        assert f.matches(command="ruff check .", content="")
        assert f.matches(command="mypy sidecar/", content="")
        assert f.matches(command="eslint src/", content="")
        assert not f.matches(command="pytest", content="")

    def test_diagnostics_survive_and_noise_collapses(self) -> None:
        f = LintOutputFilter()
        result = f.distill(self.RUFF_LOG)
        assert "sidecar/x.py:10:1: E402" in result.kept
        assert "sidecar/y.py:3:80: E501" in result.kept
        assert "Found 2 errors." in result.kept
        assert result.omitted
        assert _reconstruct(result) == self.RUFF_LOG


class TestCommandTokenBoundaries:
    """W2-29-F05: a token mentioned merely as an argument must not select a
    filter and replace unrelated output with an omission marker."""

    def test_argument_mentions_do_not_select_filters(self) -> None:
        assert not BuildOutputFilter().matches(command="echo make", content="")
        assert not TestOutputFilter().matches(command="echo pytest", content="")
        assert not LintOutputFilter().matches(command="echo ruff", content="")
        assert not TestOutputFilter().matches(
            command="git log --grep pytest", content=""
        )

    def test_program_and_wrapper_forms_still_match(self) -> None:
        assert TestOutputFilter().matches(command="uv run pytest -q", content="")
        assert TestOutputFilter().matches(command="cargo test --workspace", content="")
        assert TestOutputFilter().matches(command="npm run test", content="")
        assert BuildOutputFilter().matches(command="make -j8 all", content="")
        assert BuildOutputFilter().matches(command="make", content="")
        assert LintOutputFilter().matches(command="ruff check .", content="")
