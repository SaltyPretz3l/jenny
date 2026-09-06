from __future__ import annotations

import json
from typing import Any

import pytest

from scripts.checks.check_plugin_contract_parity import _node_results
from scripts.checks.plugin_parity_corpus import load_parity_corpus
from sidecar.ai.plugins.generated_plugin_contracts import SPEC, validate

CORPUS, EXPECTATIONS = load_parity_corpus()
# Derived from the generated SPEC rather than hand-listed, so a lane adding a
# contract gets the adversarial sweep below for free and never has to edit this
# shared file.
CONTRACT_NAMES: list[str] = sorted(SPEC["contracts"].keys())


def test_corpus_and_expectations_fixtures_stay_aligned() -> None:
    assert len(CORPUS) >= 60
    corpus_ids = [item["id"] for item in CORPUS]
    assert len(set(corpus_ids)) == len(corpus_ids)
    assert set(corpus_ids) == set(EXPECTATIONS.keys())


def test_every_registered_contract_is_exercised_by_the_corpus() -> None:
    covered = {item["contract"] for item in CORPUS}
    assert [name for name in CONTRACT_NAMES if name not in covered] == []


def test_node_probe_transport_preserves_unpaired_surrogate_fixture() -> None:
    item = next(item for item in CORPUS if item["id"] == "w11_unpaired_surrogate_rejected")
    result = _node_results([item])
    assert result[0]["ok"] is False
    assert result[0]["error"]["code"] == "invalid_unicode_scalar"


@pytest.mark.parametrize("item", CORPUS, ids=lambda item: item["id"])
def test_python_validator_matches_frozen_expectation(item: dict[str, Any]) -> None:
    expected = EXPECTATIONS[item["id"]]
    result = validate(item["contract"], item["value"])
    assert result["ok"] == expected["ok"], f"ok mismatch for {item['id']}"
    if expected["ok"]:
        assert result["error"] is None
    else:
        assert result["error"]["code"] == expected["error_code"], f"error code mismatch for {item['id']}"
        assert result["error"]["path"] == expected["error_path"], f"error path mismatch for {item['id']}"


def _manifest(contributions: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "manifest_schema_version": 1,
        "publisher_id": "acme-labs",
        "plugin_id": "widgets",
        "name": "Widgets Pack",
        "version": "1.2.3",
        "contract_versions": {
            "manifest": 1,
            "declarative_content": 1,
            "operation_receipt": 1,
            "cleanup_state": 1,
        },
        "contributions": contributions,
        "requested_permissions": [],
    }


# The parity corpus is JSON, and json.loads never produces shared references, so
# these two properties are unreachable from fixtures and must be asserted in
# process. Sharing one object across siblings is a DAG, not a cycle; an earlier
# revision tracked every visited node instead of the ancestor chain and rejected
# legitimate payloads as cyclic.
def test_object_shared_across_sibling_entries_is_not_a_cycle() -> None:
    shared = {
        "kind": "skill",
        "contribution_id": "a",
        "name": "A",
        "content_path": "content/a.json",
        "content_sha256": "a" * 64,
    }
    result = validate("PluginManifestV1", _manifest([shared, shared, shared]))
    assert result["ok"] is False
    assert result["error"]["code"] != "cycle_detected", "a DAG must not be reported as a cycle"
    assert result["error"]["code"] == "unique_by_violation"


def test_reference_back_into_the_current_path_is_still_a_cycle() -> None:
    value = _manifest([{"kind": "skill", "contribution_id": "a", "name": "A"}])
    value["contributions"][0]["self"] = value
    result = validate("PluginManifestV1", value)
    assert result["ok"] is False
    assert result["error"]["code"] == "cycle_detected"


def test_unknown_contract_name_fails_closed_regardless_of_payload_shape() -> None:
    result = validate("NotARegisteredContractV1", {"anything": True})
    assert result["ok"] is False
    assert result["error"]["code"] == "unknown_contract"


@pytest.mark.parametrize("value", [None, 42, "string", True, [], [1, 2, 3]])
@pytest.mark.parametrize("contract_name", CONTRACT_NAMES)
def test_validate_never_raises_on_adversarial_top_level_shapes(contract_name: str, value: Any) -> None:
    result = validate(contract_name, value)
    assert isinstance(result["ok"], bool)
    assert result["ok"] is False


def _lock_node(publisher_id: str, plugin_id: str, digit: str) -> dict[str, Any]:
    return {
        "publisher_id": publisher_id,
        "plugin_id": plugin_id,
        "resolved_version": "1.0.0",
        "artifact_digest": digit * 64,
        "publisher_key_id": digit * 64,
        "source_identity": {"kind": "local_package", "package_path_digest": digit * 64},
        "dependencies": [],
    }


def test_composite_unique_by_keys_are_framed_so_distinct_tuples_do_not_collide() -> None:
    """("ab","cd") and ("a","bcd") both concatenate to "abcd"; framing separates them."""
    distinct = {
        "lock_schema_version": 1,
        "graph_hash": "a" * 64,
        "nodes": [_lock_node("ab", "cd", "1"), _lock_node("a", "bcd", "2")],
    }
    assert validate("PluginLockV1", distinct)["ok"] is True

    duplicated = {**distinct, "nodes": [_lock_node("ab", "cd", "1"), _lock_node("ab", "cd", "2")]}
    result = validate("PluginLockV1", duplicated)
    assert result["ok"] is False
    assert result["error"]["code"] == "unique_by_violation"
    assert result["error"]["path"] == "nodes[1]"


def test_structural_walk_visits_keys_in_sorted_order() -> None:
    """JS hoists integer-like keys in Object.keys; sorting in both runtimes
    makes the reported error path identical for the same payload."""

    def chain(depth: int) -> Any:
        out: Any = "leaf"
        for _ in range(depth):
            out = {"d": out}
        return out

    value = json.loads(json.dumps({"z": chain(20), "0": chain(20)}))
    result = validate("PluginRegistryV1", value)
    assert result["ok"] is False
    assert result["error"]["code"] == "depth_budget_exceeded"
    assert result["error"]["path"].startswith("0.")
