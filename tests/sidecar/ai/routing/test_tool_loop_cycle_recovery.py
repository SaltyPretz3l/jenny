from __future__ import annotations

from types import SimpleNamespace

from sidecar.ai.error_codes import CMP_TOOL_BACKGROUND_NOT_FOUND
from sidecar.ai.routing.tool_loop_calls import _ToolCallPhasesMixin
from sidecar.ai.routing.tool_loop_cycle_recovery import (
    discovery_generation_payload,
    next_recovery_payload,
    repeated_missing_status_tools,
)
from sidecar.ai.tools.tool_search import ToolResolutionContext


def _entry(name: str) -> SimpleNamespace:
    return SimpleNamespace(
        descriptor=SimpleNamespace(name=name),
        prompt_schema={
            "name": name,
            "description": name,
            "parameters": {"type": "object", "properties": {}},
        },
    )


class _Contract:
    def __init__(self) -> None:
        self.entries = (_entry("tool_search"), _entry("edit_file"), _entry("read_file"))
        self.prompt_schemas = tuple(entry.prompt_schema for entry in self.entries)

    def entry(self, name: str) -> SimpleNamespace | None:
        return next((entry for entry in self.entries if entry.descriptor.name == name), None)


def test_cycle_recovery_allows_one_discovery_and_one_discovered_execution() -> None:
    contract = _Contract()
    resolution = SimpleNamespace(un_deferred_names=set())

    discovery_payload = discovery_generation_payload(
        "discover",
        list(contract.prompt_schemas),
        contract,
    )
    assert [schema["name"] for schema in discovery_payload] == ["tool_search"]

    resolution.un_deferred_names.add("edit_file")
    phase, execution_payload = next_recovery_payload(
        phase="discover",
        resolution_context=resolution,
        baseline_undeferred=frozenset(),
        tool_contract=contract,
        outcomes=[SimpleNamespace(success=True, tool_name="tool_search")],
    )
    assert phase == "execute"
    assert [schema["name"] for schema in execution_payload] == ["edit_file"]

    phase, final_payload = next_recovery_payload(
        phase=phase,
        resolution_context=resolution,
        baseline_undeferred=frozenset(),
        tool_contract=contract,
        outcomes=[SimpleNamespace(success=True, tool_name="edit_file")],
    )
    assert phase == "done"
    assert final_payload == []


def test_failed_discovery_winds_down_without_reopening_all_tools() -> None:
    contract = _Contract()
    phase, payload = next_recovery_payload(
        phase="discover",
        resolution_context=SimpleNamespace(un_deferred_names=set()),
        baseline_undeferred=frozenset(),
        tool_contract=contract,
        outcomes=[SimpleNamespace(success=False, tool_name="tool_search")],
    )

    assert phase == "done"
    assert payload == []


def test_three_missing_identifier_failures_retire_only_the_repeated_status_tool() -> None:
    outcomes = [
        SimpleNamespace(
            tool_name="check_background_job",
            error_code=CMP_TOOL_BACKGROUND_NOT_FOUND,
        )
        for _ in range(3)
    ]
    outcomes.extend(
        SimpleNamespace(
            tool_name="check_monitor",
            error_code=CMP_TOOL_BACKGROUND_NOT_FOUND,
        )
        for _ in range(2)
    )

    assert repeated_missing_status_tools(outcomes) == frozenset({"check_background_job"})


def test_retiring_a_status_tool_also_removes_it_from_the_searchable_set() -> None:
    """Retirement must survive the search-index rebuild that follows it.

    ``remaining_unexposed_names()`` is ``(deferred | budget_filtered) -
    un_deferred``, so moving a retired tool INTO budget_filtered and OUT of
    un_deferred used to land it squarely inside the searchable set -- letting
    ToolSearch re-promote the very tool the retirement had just removed.
    """
    resolution_context = ToolResolutionContext(
        deferred_names=frozenset({"check_background_job", "read_file"}),
        un_deferred_names={"check_background_job"},
    )
    stub = SimpleNamespace(
        tool_resolution_context=resolution_context,
        outcomes=[
            SimpleNamespace(
                tool_name="check_background_job",
                error_code=CMP_TOOL_BACKGROUND_NOT_FOUND,
            )
            for _ in range(3)
        ],
        request_id="req-1",
        session_id="session-1",
    )

    retired = _ToolCallPhasesMixin._retire_repeated_missing_status_tools(stub)

    assert retired == frozenset({"check_background_job"})
    assert "check_background_job" not in resolution_context.un_deferred_names
    assert "check_background_job" in resolution_context.budget_filtered_names
    assert "check_background_job" not in resolution_context.remaining_unexposed_names()
    # The unrelated deferred tool is still discoverable.
    assert "read_file" in resolution_context.remaining_unexposed_names()
