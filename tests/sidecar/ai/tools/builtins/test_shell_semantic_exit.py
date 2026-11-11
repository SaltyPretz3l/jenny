"""Exit codes that are a command's normal answer, not a failure (row 129, A3)."""

from __future__ import annotations

import pytest

from sidecar.ai.tools.builtins.shell import _is_semantic_ok


@pytest.mark.parametrize(
    ("command", "exit_code"),
    [
        ("findstr /s needle *.py", 1),
        ("FINDSTR needle file.txt", 1),
        ("where python", 1),
        ("where.exe python", 1),
        ("fc a.txt b.txt", 1),
        ("robocopy src dst /e", 1),
        ("robocopy src dst /e", 7),
        ("dir /s /b | findstr needle", 1),
        ("git ls-files | grep needle", 1),
        ("type log.txt | findstr /i error | findstr /v debug", 1),
    ],
)
def test_normal_non_zero_exits_are_ok(command: str, exit_code: int) -> None:
    assert _is_semantic_ok(command, exit_code) is not None


@pytest.mark.parametrize(
    ("command", "exit_code"),
    [
        ("findstr needle file.txt", 2),
        ("robocopy src dst /e", 8),
        ("robocopy src dst /e", 16),
        ("findstring needle", 1),
        ("pytest -q", 1),
        # Only the last command of a pipeline sets the exit code.
        ("findstr needle file.txt | sort", 1),
        ("git diff --quiet | findstr x && echo done", 1),
        ("dir || findstr needle file.txt", 1),
        ("findstr needle a.txt; findstr needle b.txt", 1),
        ("findstr needle a.txt\nfindstr needle b.txt", 1),
        ("echo x | git diff --quiet", 1),
        # A quoted "|" is text, not a pipe.
        ('git log --grep="x | grep y"', 1),
        ('powershell -c "gps | where name -eq x"', 1),
    ],
)
def test_other_non_zero_exits_stay_failures(command: str, exit_code: int) -> None:
    assert _is_semantic_ok(command, exit_code) is None
