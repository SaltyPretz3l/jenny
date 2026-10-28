"""Command/output router: pick the output filter for a shell result, if any.

``normalize_command`` lives in ``filters.base`` (the filters share it); it is
re-exported here so ``router.normalize_command`` is the stable public entry.
"""

from __future__ import annotations

from typing import Iterable

from sidecar.ai.tools.distill.filters.base import (
    OutputFilter,
    command_selects_program,
    normalize_command,
)
from sidecar.ai.tools.distill.filters.build_output import BuildOutputFilter
from sidecar.ai.tools.distill.filters.lint_output import LintOutputFilter
from sidecar.ai.tools.distill.filters.test_output import TestOutputFilter

# Order matters: test wins over build wins over lint when shapes overlap
# (e.g. `cargo test` vs `cargo build`, `mypy` output that mentions "test").
_FILTERS: tuple[OutputFilter, ...] = (
    TestOutputFilter(),
    BuildOutputFilter(),
    LintOutputFilter(),
)

# Commands that print a file or history verbatim. Their output is someone
# else's text (`cat notes.md` mentioning "2 passed"), so only an explicit
# command match may select a filter for them, never the content sniff.
_READ_COMMANDS = (
    "cat",
    "type",
    "head",
    "tail",
    "less",
    "more",
    "sed",
    "grep",
    "rg",
    "git show",
    "git diff",
    "git log",
    "get-content",
    "gc",
)

__all__ = ["normalize_command", "select_filter"]


def select_filter(
    command: str = "",
    content: str = "",
    *,
    disabled: Iterable[str] = (),
) -> OutputFilter | None:
    """Return the first filter that recognizes *command*/*content*, or ``None``.

    Matching is by normalized command token OR content sniff (each filter owns
    its heuristics). ``disabled`` names filters to skip. A read-style command
    (``cat``, ``git show``, ``Get-Content``, ...) never falls back to the
    content sniff.
    """
    if content and command_selects_program(normalize_command(command), _READ_COMMANDS):
        content = ""
    disabled_set = set(disabled)
    for output_filter in _FILTERS:
        if output_filter.name in disabled_set:
            continue
        if output_filter.matches(command=command, content=content):
            return output_filter
    return None
