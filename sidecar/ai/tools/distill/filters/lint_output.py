"""Filter for linter/type-checker output (eslint / ruff / mypy / flake8 / …).

Keeps diagnostic lines (``file:line:col``, rule codes, error/warning/summary);
collapses the per-file "checking …" noise. Biased to keep.
"""

from __future__ import annotations

import re

from sidecar.ai.tools.distill.filters.base import (
    DistillOutput,
    command_selects_program,
    distill_lines,
    normalize_command,
)

_COMMAND_TOKENS = (
    "eslint",
    "ruff",
    "mypy",
    "flake8",
    "pylint",
    "pyright",
    "tslint",
    "stylelint",
    "golangci-lint",
    "clippy",
    "cargo clippy",
    "prettier",
    "shellcheck",
    "biome",
)

_CONTENT_RE = re.compile(
    r"\d+:\d+:\s*[EWFC]\d+"
    r"|: error:"
    r"|: warning:"
    r"|✖ \d+ problems?"
    r"|Found \d+ error"
    r"|Success: no issues",
    re.IGNORECASE,
)

_KEEP_RE = re.compile(
    r":\d+:\d+:"  # file:line:col diagnostics
    r"|\b[EWFC]\d{2,}\b"  # rule codes: E501, W291, F401, C901
    r"|error|warning|problem|fatal|found \d+|success:",
    re.IGNORECASE,
)


class LintOutputFilter:
    name = "lint_output"

    def matches(self, *, command: str, content: str) -> bool:
        norm = normalize_command(command)
        if command_selects_program(norm, _COMMAND_TOKENS):
            return True
        return bool(_CONTENT_RE.search(content))

    def distill(self, raw: str) -> DistillOutput:
        return distill_lines(raw, keep_line=self._keep)

    @staticmethod
    def _keep(line: str) -> bool:
        return bool(_KEEP_RE.search(line))
