"""Tests for the distill command router (normalize_command + select_filter).

RED-FIRST: authored before ``sidecar/ai/tools/distill/router.py`` exists.
"""

from __future__ import annotations

import pytest

from sidecar.ai.tools.distill.router import normalize_command, select_filter


class TestNormalizeCommand:
    @pytest.mark.parametrize(
        "raw, expected",
        [
            ("uv run pytest", "pytest"),
            ("uvx ruff check .", "ruff check ."),
            ("npx jest --ci", "jest --ci"),
            ("python -m pytest tests/", "pytest tests/"),
            ("python3 -m pytest", "pytest"),
            ("poetry run pytest -q", "pytest -q"),
            (r".venv\Scripts\pytest.exe -q", "pytest -q"),
            ("/usr/bin/python3 -m pytest", "pytest"),
            ("FOO=bar BAZ=qux python -m pytest", "pytest"),
            ("  PyTest -q  ", "pytest -q"),
            ("", ""),
        ],
    )
    def test_normalizes(self, raw: str, expected: str) -> None:
        assert normalize_command(raw) == expected


class TestSelectFilter:
    @pytest.mark.parametrize(
        "command",
        ["pytest -q", "npx jest", "go test ./...", "cargo test", "uv run pytest tests/"],
    )
    def test_selects_test_output_by_command(self, command: str) -> None:
        f = select_filter(command=command)
        assert f is not None
        assert f.name == "test_output"

    @pytest.mark.parametrize("command", ["tsc --noEmit", "cargo build", "go build ./..."])
    def test_selects_build_output_by_command(self, command: str) -> None:
        f = select_filter(command=command)
        assert f is not None
        assert f.name == "build_output"

    @pytest.mark.parametrize("command", ["eslint src/", "ruff check .", "mypy sidecar/"])
    def test_selects_lint_output_by_command(self, command: str) -> None:
        f = select_filter(command=command)
        assert f is not None
        assert f.name == "lint_output"

    def test_unknown_command_returns_none(self) -> None:
        assert select_filter(command="ls -la") is None
        assert select_filter(command="git status") is None
        assert select_filter() is None

    def test_selects_by_content_when_command_unrecognized(self) -> None:
        pytest_log = "=== test session starts ===\ncollected 3 items\n1 failed, 2 passed"
        f = select_filter(command="./run.sh", content=pytest_log)
        assert f is not None
        assert f.name == "test_output"

    def test_disabled_filter_is_skipped(self) -> None:
        assert select_filter(command="pytest", disabled=("test_output",)) is None
