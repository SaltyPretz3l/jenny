"""The Electron budget helper and TokenBudget agree on the same window (CMC-005).

tests/fixtures/context-budget-parity.json is asserted by both languages; see
tests/context-budget-trimmer.test.js for the JavaScript half.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from sidecar.ai.context.token_budget import TokenBudget

_FIXTURE = Path(__file__).resolve().parents[3] / "fixtures" / "context-budget-parity.json"
_CASES = json.loads(_FIXTURE.read_text(encoding="utf-8"))["cases"]


@pytest.mark.parametrize("case", _CASES, ids=[str(case["context_window"]) for case in _CASES])
def test_effective_context_matches_the_javascript_fixture(case):
    window = case["context_window"]
    budget = TokenBudget(context_window=window, max_output_tokens=window)
    assert budget.effective_context(0) == case["effective_context"]
