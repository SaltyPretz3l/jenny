"""Command/output router: pick the output filter for a shell result, if any.

``normalize_command`` lives in ``filters.base`` (the filters share it); it is
re-exported here so ``router.normalize_command`` is the stable public entry.
"""

from __future__ import annotations

from typing import Iterable

from sidecar.ai.tools.distill.filters.base import (
    OutputFilter,
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

__all__ = ["normalize_command", "select_filter"]


def select_filter(
    command: str = "",
    content: str = "",
    *,
    disabled: Iterable[str] = (),
) -> OutputFilter | None:
    """Return the first filter that recognizes *command*/*content*, or ``None``.

    Matching is by normalized command token OR content sniff (each filter owns
    its heuristics). ``disabled`` names filters to skip.
    """
    disabled_set = set(disabled)
    for output_filter in _FILTERS:
        if output_filter.name in disabled_set:
            continue
        if output_filter.matches(command=command, content=content):
            return output_filter
    return None
