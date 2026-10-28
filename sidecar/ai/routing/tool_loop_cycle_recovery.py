"""Bounded recovery helpers for repeated tool-call cycles."""

from __future__ import annotations

from typing import Any

from sidecar.ai.error_codes import CMP_TOOL_BACKGROUND_NOT_FOUND

_STATUS_TOOLS_WITH_MISSING_IDENTIFIERS = (
    "check_background_job",
    "check_monitor",
)
_MISSING_STATUS_RETIRE_THRESHOLD = 3


def discovery_generation_payload(
    phase: str,
    tool_payload: list[dict[str, Any]],
    tool_contract: Any,
) -> list[dict[str, Any]]:
    """Offer only discovery during the first cycle-recovery generation."""
    if phase != "discover":
        return tool_payload
    entry = tool_contract.entry("tool_search")
    schema = getattr(entry, "prompt_schema", None)
    return [schema] if isinstance(schema, dict) and "parameters" in schema else []


def next_recovery_payload(
    *,
    phase: str,
    resolution_context: Any | None,
    baseline_undeferred: frozenset[str],
    tool_contract: Any,
    outcomes: list[Any],
) -> tuple[str, list[dict[str, Any]]]:
    """Advance discovery -> one execution -> ordinary no-tool wind-down."""
    if phase == "discover":
        discovered = frozenset(
            getattr(resolution_context, "un_deferred_names", set())
        ) - baseline_undeferred
        search_succeeded = any(
            getattr(outcome, "success", False)
            and getattr(outcome, "tool_name", "") == "tool_search"
            for outcome in outcomes
        )
        if search_succeeded and discovered:
            return "execute", [
                entry.prompt_schema
                for entry in tool_contract.entries
                if entry.descriptor.name in discovered
                and isinstance(entry.prompt_schema, dict)
                and "parameters" in entry.prompt_schema
            ]
        return "done", []
    return "done", []


class MissingStatusCounter:
    """Running per-tool count of missing-identifier status failures.

    ``retired`` folds in only the outcomes appended since its last call, so the
    per-iteration check stays O(new outcomes) instead of rescanning the turn.
    """

    __slots__ = ("_counts", "_scanned")

    def __init__(self) -> None:
        self._counts: dict[str, int] = {}
        self._scanned = 0

    def retired(self, outcomes: list[Any]) -> frozenset[str]:
        """Return status tools whose missing identifier failed three times."""
        if len(outcomes) < self._scanned:  # the list was rebuilt: recount it
            self._counts.clear()
            self._scanned = 0
        for outcome in outcomes[self._scanned:]:
            tool_name = getattr(outcome, "tool_name", "")
            if (
                tool_name in _STATUS_TOOLS_WITH_MISSING_IDENTIFIERS
                and getattr(outcome, "error_code", "") == CMP_TOOL_BACKGROUND_NOT_FOUND
            ):
                self._counts[tool_name] = self._counts.get(tool_name, 0) + 1
        self._scanned = len(outcomes)
        return frozenset(
            tool_name
            for tool_name, count in self._counts.items()
            if count >= _MISSING_STATUS_RETIRE_THRESHOLD
        )


def repeated_missing_status_tools(outcomes: list[Any]) -> frozenset[str]:
    """Return status tools whose missing identifier failed three times."""
    return MissingStatusCounter().retired(outcomes)
