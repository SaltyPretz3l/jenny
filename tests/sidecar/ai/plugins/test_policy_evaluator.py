"""Cross-runtime parity test for sidecar.ai.plugins.policy.evaluate_capability_policy.

Loads the SAME fixture file that tests/plugins/policy/policy-evaluator.test.js
loads (tests/fixtures/plugins/policy-matrix/capability-decisions.json). Both
runtimes asserting against one frozen expectation per case is what proves
parity -- not independent inspection of either implementation. See
sidecar/ai/plugins/policy.py's module docstring and
PLUGIN_SYSTEM_ARCHITECTURE_AND_ROADMAP.md's "single policy algebra" invariant.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from sidecar.ai.plugins.policy import evaluate_capability_policy

ROOT = Path(__file__).resolve().parents[4]
FIXTURE_PATH = ROOT / "tests" / "fixtures" / "plugins" / "policy-matrix" / "capability-decisions.json"


def _load_cases() -> list[dict[str, Any]]:
    document = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
    cases = document["cases"]
    assert isinstance(cases, list) and cases, "fixture must carry cases"
    return cases


CASES = _load_cases()


def test_policy_matrix_fixture_ids_are_unique() -> None:
    ids = [item["id"] for item in CASES]
    assert len(set(ids)) == len(ids)


@pytest.mark.parametrize("item", CASES, ids=lambda item: item["id"])
def test_evaluate_capability_policy_matches_frozen_expectation(item: dict[str, Any]) -> None:
    result = evaluate_capability_policy(item["request"], item["snapshot"])
    assert result == item["expected"], f"decision mismatch for {item['id']}"


@pytest.mark.parametrize("request_value", [None, 42, "nope", True, [], {}])
@pytest.mark.parametrize("snapshot_value", [None, 42, "nope", True, [], {}])
def test_evaluate_capability_policy_never_raises_on_adversarial_inputs(
    request_value: Any, snapshot_value: Any
) -> None:
    result = evaluate_capability_policy(request_value, snapshot_value)
    assert result["decision"] == "deny"
    assert isinstance(result["reason"], str)


def test_a_workspace_scoped_request_with_no_matching_workspace_rule_falls_through_to_layer_3() -> None:
    snapshot = {
        "policy_schema_version": 1,
        "revision": 1,
        "canonical_hash": "a" * 64,
        "hard_invariants": [],
        "machine_ceiling": [],
        "user_policy": [
            {
                "rule_id": "grant-1",
                "match": {"publisher_id": "acme", "plugin_id": "widgets", "capability": "chat.read"},
                "decision": "auto",
                "reason": "granted",
                "source": "electron_grant",
            }
        ],
        "workspace_overrides": [],
        "manifest_requests": [{"publisher_id": "acme", "plugin_id": "widgets", "requested_capabilities": ["chat.read"]}],
    }
    result = evaluate_capability_policy(
        {
            "publisher_id": "acme",
            "plugin_id": "widgets",
            "capability": "chat.read",
            "workspace_incarnation_id": "ws-1",
        },
        snapshot,
    )
    assert result["decision"] == "auto"
    assert result["matched_rule_id"] == "grant-1"


def test_decision_reasons_stay_within_the_bounded_reason_length() -> None:
    for item in CASES:
        result = evaluate_capability_policy(item["request"], item["snapshot"])
        assert len(result["reason"]) <= 200, f"reason too long for {item['id']}"


def _snapshot(**overrides: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "policy_schema_version": 1,
        "revision": 1,
        "canonical_hash": "a" * 64,
        "hard_invariants": [],
        "machine_ceiling": [],
        "user_policy": [],
        "workspace_overrides": [],
        "manifest_requests": [
            {"publisher_id": "acme", "plugin_id": "widgets", "requested_capabilities": ["chat.read"]}
        ],
    }
    base.update(overrides)
    return base


_REQUEST = {"publisher_id": "acme", "plugin_id": "widgets", "capability": "chat.read"}


@pytest.mark.parametrize("bad_match", [None, "", "everything", 7, [], {"publisher_id": ""}])
def test_a_malformed_rule_match_matches_nothing_rather_than_everything(bad_match: Any) -> None:
    """Malformed policy state must never WIDEN authority. See the JS twin."""
    snapshot = _snapshot(
        user_policy=[{"rule_id": "wild", "match": bad_match, "decision": "auto", "reason": "r", "source": "electron_grant"}]
    )
    assert evaluate_capability_policy(_REQUEST, snapshot)["decision"] != "auto"


def test_an_empty_match_object_still_matches_every_request() -> None:
    """`match: {}` is the contract's legitimate 'unconstrained' spelling."""
    snapshot = _snapshot(
        user_policy=[{"rule_id": "all", "match": {}, "decision": "auto", "reason": "r", "source": "electron_grant"}]
    )
    assert evaluate_capability_policy(_REQUEST, snapshot)["decision"] == "auto"


def test_a_null_rule_element_is_skipped_without_authorizing_a_later_rule() -> None:
    snapshot = _snapshot(
        user_policy=[
            None,
            {"rule_id": "grant", "match": {"capability": "chat.read"}, "decision": "auto", "reason": "r", "source": "electron_grant"},
        ]
    )
    assert evaluate_capability_policy(_REQUEST, snapshot)["decision"] == "auto"


@pytest.mark.parametrize("revision", [True, False])
def test_a_boolean_expected_revision_is_malformed_not_a_number(revision: Any) -> None:
    """bool subclasses int in Python; the JS twin's typeof check rejects it."""
    result = evaluate_capability_policy({**_REQUEST, "expected_revision": revision}, _snapshot(revision=5))
    assert result["decision"] == "deny"
    assert result["stage"] == "malformed_request"
