"""Tests for the request-scoped research delegation-contract helpers."""

from __future__ import annotations

import pytest

from sidecar.ai.routing.delegation_contract import (
    DELEGATION_CONTRACT_FIELDS,
    MAX_CONTRACT_LIST_ITEM_LENGTH,
    MAX_CONTRACT_LIST_ITEMS,
    MAX_CONTRACT_TEXT_LENGTH,
    normalize_delegation_contract,
)


def test_bound_constants_match_documented_parity_values() -> None:
    """Bounds stay stable for prompt and report shaping."""
    assert MAX_CONTRACT_TEXT_LENGTH == 4000
    assert MAX_CONTRACT_LIST_ITEMS == 20
    assert MAX_CONTRACT_LIST_ITEM_LENGTH == 1000


def test_field_order_matches_documented_parity_values() -> None:
    assert DELEGATION_CONTRACT_FIELDS == (
        "goal",
        "context",
        "boundaries",
        "tasks",
        "verification",
        "return_format",
    )


def test_returns_none_when_goal_missing() -> None:
    result = normalize_delegation_contract(
        {"tasks": ["do thing"], "return_format": "json"}
    )
    assert result is None


def test_returns_none_when_tasks_empty() -> None:
    result = normalize_delegation_contract(
        {"goal": "test", "tasks": [], "return_format": "json"}
    )
    assert result is None


def test_returns_none_when_return_format_missing() -> None:
    result = normalize_delegation_contract({"goal": "test", "tasks": ["a"]})
    assert result is None


def test_returns_none_when_input_is_not_dict() -> None:
    assert normalize_delegation_contract(None) is None
    assert normalize_delegation_contract([]) is None
    assert normalize_delegation_contract("string") is None


def test_normalizes_full_contract_into_field_order() -> None:
    contract = normalize_delegation_contract(
        {
            "return_format": "json",
            "goal": "ship feature",
            "tasks": ["do a", "do b"],
            "boundaries": ["no network"],
            "context": "feature spec",
            "verification": ["tests pass"],
        }
    )
    assert contract is not None
    assert list(contract.keys()) == list(DELEGATION_CONTRACT_FIELDS)
    assert contract["goal"] == "ship feature"
    assert contract["context"] == "feature spec"
    assert contract["boundaries"] == ["no network"]
    assert contract["tasks"] == ["do a", "do b"]
    assert contract["verification"] == ["tests pass"]
    assert contract["return_format"] == "json"


def test_truncates_text_to_max_length() -> None:
    long_goal = "x" * (MAX_CONTRACT_TEXT_LENGTH + 100)
    contract = normalize_delegation_contract(
        {"goal": long_goal, "tasks": ["t"], "return_format": "json"}
    )
    assert contract is not None
    assert len(contract["goal"]) == MAX_CONTRACT_TEXT_LENGTH


def test_truncates_list_items_to_max_per_item_length() -> None:
    long_item = "y" * (MAX_CONTRACT_LIST_ITEM_LENGTH + 100)
    contract = normalize_delegation_contract(
        {"goal": "g", "tasks": [long_item], "return_format": "json"}
    )
    assert contract is not None
    assert len(contract["tasks"][0]) == MAX_CONTRACT_LIST_ITEM_LENGTH


def test_caps_list_to_max_items() -> None:
    overflow_tasks = [f"task {idx}" for idx in range(MAX_CONTRACT_LIST_ITEMS + 5)]
    contract = normalize_delegation_contract(
        {"goal": "g", "tasks": overflow_tasks, "return_format": "json"}
    )
    assert contract is not None
    assert len(contract["tasks"]) == MAX_CONTRACT_LIST_ITEMS


def test_drops_empty_list_entries() -> None:
    contract = normalize_delegation_contract(
        {
            "goal": "g",
            "tasks": ["one", "", "  ", "two"],
            "return_format": "json",
        }
    )
    assert contract is not None
    assert contract["tasks"] == ["one", "two"]


@pytest.mark.parametrize("non_list_value", [None, "string", 42, {"k": "v"}])
def test_non_list_collections_normalize_to_empty(non_list_value: object) -> None:
    contract = normalize_delegation_contract(
        {
            "goal": "g",
            "tasks": ["a"],
            "boundaries": non_list_value,
            "return_format": "json",
        }
    )
    assert contract is not None
    assert contract["boundaries"] == []
