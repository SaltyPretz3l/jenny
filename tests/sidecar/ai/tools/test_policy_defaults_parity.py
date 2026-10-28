"""The built-in tool policy defaults are one table in two languages.

``services/tools/tool-policy-evaluator.js`` (Electron-owned tools) and
``sidecar/ai/tools/policy.py`` (sidecar tools) each carry a default decision per
tool; a tool present in one and missing from the other falls through to the
side-effecting ``ask`` default on that side only (tool review, 2026-10-19:
``home`` was missing from the Python table).
"""

from __future__ import annotations

import re
from pathlib import Path

from sidecar.ai.tools import policy

_REPO_ROOT = Path(__file__).resolve().parents[4]
_EVALUATOR = _REPO_ROOT / "services" / "tools" / "tool-policy-evaluator.js"
_ENTRY_RE = re.compile(r"^  (?:'([^']+)'|([A-Za-z_][A-Za-z0-9_]*)): '(auto|ask|deny)',$")


def _javascript_defaults() -> dict[str, str]:
    source = _EVALUATOR.read_text(encoding="utf-8")
    start = source.index("const DEFAULT_TOOL_DEFAULTS = Object.freeze({")
    end = source.index("});", start)
    table: dict[str, str] = {}
    for line in source[start:end].splitlines():
        match = _ENTRY_RE.match(line.rstrip("\r"))
        if match:
            table[match.group(1) or match.group(2)] = match.group(3)
    assert table, "could not parse DEFAULT_TOOL_DEFAULTS from the JS evaluator"
    return table


def test_javascript_and_python_default_tables_agree() -> None:
    assert _javascript_defaults() == dict(policy._DEFAULT_TOOL_DEFAULTS)
