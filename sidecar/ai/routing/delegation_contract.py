"""Shared bounds and normalization for request-scoped research delegation."""

from __future__ import annotations

from typing import Any

MAX_CONTRACT_TEXT_LENGTH = 4000
MAX_CONTRACT_LIST_ITEMS = 20
MAX_CONTRACT_LIST_ITEM_LENGTH = 1000

DELEGATION_CONTRACT_FIELDS: tuple[str, ...] = (
    "goal",
    "context",
    "boundaries",
    "tasks",
    "verification",
    "return_format",
)


def bounded_text(value: Any, max_length: int = MAX_CONTRACT_TEXT_LENGTH) -> str:
    text = str(value or "").strip()
    return text[:max_length]


def _bounded_text_list(value: Any) -> list[str]:
    source = value if isinstance(value, (list, tuple)) else []
    normalized: list[str] = []
    for item in source:
        text = bounded_text(item, MAX_CONTRACT_LIST_ITEM_LENGTH)
        if not text:
            continue
        normalized.append(text)
        if len(normalized) >= MAX_CONTRACT_LIST_ITEMS:
            break
    return normalized


def normalize_delegation_contract(value: Any) -> dict[str, Any] | None:
    """Normalize a delegation-contract payload to the canonical bounded shape.

    Returns ``None`` if the required fields (goal, tasks, return_format) are
    missing or empty after bounding. Returns a dict whose keys match
    ``DELEGATION_CONTRACT_FIELDS`` ordering when the contract is valid.
    """

    source = value if isinstance(value, dict) else {}
    contract: dict[str, Any] = {
        "goal": bounded_text(source.get("goal")),
        "context": bounded_text(source.get("context")),
        "boundaries": _bounded_text_list(source.get("boundaries")),
        "tasks": _bounded_text_list(source.get("tasks")),
        "verification": _bounded_text_list(source.get("verification")),
        "return_format": bounded_text(source.get("return_format")),
    }
    if not contract["goal"] or not contract["tasks"] or not contract["return_format"]:
        return None
    return {field: contract.get(field) for field in DELEGATION_CONTRACT_FIELDS}
