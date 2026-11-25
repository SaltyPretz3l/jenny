"""Exit codes that are a command's normal answer, not a failure (row 129, A3)."""

from __future__ import annotations

import re

from sidecar.ai.tools.builtins.shell_command_split import split_compound_command

_MIN_COMPOUND_SEGMENTS = 2

# Semantic exit-code overrides: command prefix -> {exit_code: explanation}.
SEMANTIC_EXIT_OVERRIDES: dict[str, dict[int, str]] = {
    "git grep": {1: "no matches found"},
    "grep": {1: "no matches found"},
    "rg": {1: "no matches found"},
    "diff": {1: "files differ (normal)"},
    "cmp": {1: "files differ (normal)"},
    "test": {1: "condition is false (normal)"},
    # Windows equivalents: a month of real chats counted these as tool errors (row 129, A3).
    "findstr": {1: "no matches found"},
    "where": {1: "not found on PATH"},
    "where.exe": {1: "not found on PATH"},
    "fc": {1: "files differ (normal)"},
    "robocopy": dict.fromkeys(range(1, 8), "robocopy finished; exit codes below 8 mean success"),
}

# Search tools exit 1 for "no matches", but findstr also exits 1 when it cannot open a file.
_MATCH_SEARCH_PREFIXES = ("git grep", "grep", "rg", "findstr")
_UNREADABLE_INPUT = re.compile(
    r"cannot open|can't open|could not open|no such file|cannot find|permission denied"
    r"|access is denied",
    re.IGNORECASE,
)


def _exit_code_segment(command: str) -> tuple[str, bool] | None:
    """Return the segment whose exit code the shell reports, and whether it ends a pipeline.

    Only a single command or a plain pipeline qualifies: a pipeline exits with its last
    command's code (`dir /s | findstr x`). Quotes are honored, so a quoted "|" is text, as in
    `cargo build 2>&1 | findstr "^error"`. Any other separator masks earlier exit codes.
    """
    segments = split_compound_command(command)
    if len(segments) < _MIN_COMPOUND_SEGMENTS:
        return command.strip(), False
    cursor = 0
    for index, segment in enumerate(segments[:-1]):
        separator_start = command.find(segment, cursor) + len(segment)
        next_start = command.find(segments[index + 1], separator_start)
        if separator_start < len(segment) or next_start < 0:
            return None
        if command[separator_start:next_start].strip() != "|":
            return None
        cursor = next_start
    return segments[-1], True


def is_semantic_ok(command: str, exit_code: int, stderr: str = "") -> str | None:
    """Return an explanation when *exit_code* is semantically OK."""
    found = _exit_code_segment(command)
    if found is None:
        return None
    segment, piped = found
    lower = segment.lower()
    if piped and lower.startswith("git diff"):
        return None
    if (
        (lower == "git diff" or lower.startswith("git diff "))
        and ("--exit-code" in lower or "--quiet" in lower)
        and exit_code == 1
    ):
        return "differences found (normal for git diff --exit-code/--quiet)"
    for prefix, overrides in SEMANTIC_EXIT_OVERRIDES.items():
        if (lower == prefix or lower.startswith(f"{prefix} ")) and exit_code in overrides:
            if prefix in _MATCH_SEARCH_PREFIXES and _UNREADABLE_INPUT.search(stderr):
                return None  # "FINDSTR: Cannot open x" is a missing input, not "no matches"
            return overrides[exit_code]
    return None
