"""Cross-runtime parity test for sidecar.ai.plugins.policy.combine_plugin_and_tool_decision.

Loads the policy-matrix fixture
(tests/fixtures/plugins/policy-matrix/combined-decision-matrix.json).
Covers the full deny/ask/auto x deny/ask/auto grid plus malformed-input
fail-closed cases -- see sidecar/ai/plugins/policy.py's module docstring.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from sidecar.ai.plugins.policy import DECISION_RANK, combine_plugin_and_tool_decision

ROOT = Path(__file__).resolve().parents[4]
FIXTURE_PATH = ROOT / "tests" / "fixtures" / "plugins" / "policy-matrix" / "combined-decision-matrix.json"


def _load_cases() -> list[dict[str, Any]]:
    document = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
    cases = document["cases"]
    assert isinstance(cases, list) and cases, "fixture must carry cases"
    return cases


CASES = _load_cases()


def test_combined_decision_matrix_fixture_covers_the_full_3x3_grid() -> None:
    decisions = ("deny", "ask", "auto")

    def decision_of(value: Any) -> Any:
        return value.get("decision") if isinstance(value, dict) else None

    covered = {
        (decision_of(item["plugin_decision"]), decision_of(item["tool_decision"]))
        for item in CASES
        if decision_of(item["plugin_decision"]) in decisions and decision_of(item["tool_decision"]) in decisions
    }
    for plugin in decisions:
        for tool in decisions:
            assert (plugin, tool) in covered, f"missing combination plugin={plugin} tool={tool}"


@pytest.mark.parametrize("item", CASES, ids=lambda item: item["id"])
def test_combine_plugin_and_tool_decision_matches_frozen_expectation(item: dict[str, Any]) -> None:
    result = combine_plugin_and_tool_decision(item["plugin_decision"], item["tool_decision"])
    assert result == item["expected"], f"combined decision mismatch for {item['id']}"


def test_the_combined_decision_is_always_at_least_as_restrictive_as_either_input() -> None:
    for item in CASES:
        result = combine_plugin_and_tool_decision(item["plugin_decision"], item["tool_decision"])
        assert DECISION_RANK[result["decision"]] <= DECISION_RANK[result["plugin_decision"]["decision"]]
        assert DECISION_RANK[result["decision"]] <= DECISION_RANK[result["tool_decision"]["decision"]]


@pytest.mark.parametrize("plugin_value", [None, 42, "nope", True, [], {}, {"decision": "not-a-decision"}])
@pytest.mark.parametrize("tool_value", [None, 42, "nope", True, [], {}, {"decision": "not-a-decision"}])
def test_combine_plugin_and_tool_decision_never_raises_on_adversarial_inputs(
    plugin_value: Any, tool_value: Any
) -> None:
    result = combine_plugin_and_tool_decision(plugin_value, tool_value)
    assert result["decision"] == "deny"
