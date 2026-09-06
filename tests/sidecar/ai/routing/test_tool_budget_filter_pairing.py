from __future__ import annotations

import sys
from dataclasses import replace
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_tool_budget_filter_probe_parity import (  # noqa: E402 - shared budget harness.
    _filter_input,
    _force_budget_pressure,
    _incident_tool_contract,
    _IncidentFilterKernel,
)

from sidecar.ai.routing.tool_budget_filter import (  # noqa: E402
    _budget_relevant_family_names,
    apply_budget_aware_tool_filter,
)
from sidecar.ai.tools.assembly import AssembledToolContract  # noqa: E402


class _PairingKernel(_IncidentFilterKernel):
    def __init__(self, absent: frozenset[str]) -> None:
        super().__init__()
        self.absent = absent

    def _assemble_tool_contract(self, *, request_context, resolution_context):
        contract = _incident_tool_contract(resolution_context.remaining_unexposed_names())
        return AssembledToolContract(tuple(
            entry for entry in contract.entries if entry.descriptor.name not in self.absent
        ))


def _apply_filter(  # noqa: PLR0913 - budget scenario fixture.
    monkeypatch, *, absent=frozenset(), un_deferred=(), preferred=(), history=(),
    query="the start button does not currently work!",
    level="error",
):
    _force_budget_pressure(monkeypatch, level)
    kernel = _PairingKernel(absent)
    context = replace(
        _filter_input(kernel, tool_preferences={"enabled_tools": tuple(preferred)}),
        semantic_history=list(history), latest_user_content=query,
    )
    resolution = context.tool_resolution_context
    resolution.un_deferred_names.update(un_deferred)
    contract = kernel._assemble_tool_contract(
        request_context=context.request_context, resolution_context=resolution,
    )
    result = apply_budget_aware_tool_filter(
        context, tool_contract=contract, tool_payload=list(contract.prompt_schemas),
        tool_statuses=contract.status_entries,
    )
    kept = resolution.budget_filter_metadata["kept_names"]
    assert set(kept) == {schema["name"] for schema in result.tool_payload}
    assert set(kept).isdisjoint(resolution.remaining_unexposed_names())
    return kept, resolution


def test_error_pressure_keeps_current_info_web_search(monkeypatch) -> None:
    kept, _ = _apply_filter(monkeypatch, query="What is the latest news today?")
    assert "web_search" in kept
    assert len(kept) == 5


def test_error_pressure_keeps_recent_success_and_repair_floor(monkeypatch) -> None:
    kept, _ = _apply_filter(monkeypatch, history=[
        {"role": "tool", "name": "run_command", "content": "success"},
    ])
    assert set(kept) == {"tool_search", "read_file", "grep_search", "edit_file", "run_command"}


def test_incident_family_preference_is_exactly_the_repair_floor() -> None:
    assert _budget_relevant_family_names(
        "the start button does not currently work!", _incident_tool_contract(),
    ) == ("read_file", "grep_search", "edit_file")


@pytest.mark.parametrize("level", ["error", "warning"])
def test_unprompted_delete_is_hidden_and_slot_refilled(monkeypatch, level) -> None:
    kept, resolution = _apply_filter(monkeypatch, level=level)
    assert "delete_file" not in kept
    assert "delete_file" in resolution.budget_filtered_names
    assert len(kept) == resolution.budget_filter_metadata["cap"]


def test_move_without_delete_remains_kept(monkeypatch) -> None:
    kept, _ = _apply_filter(
        monkeypatch, absent=frozenset({"delete_file"}), preferred=("move_file",),
    )
    assert "move_file" in kept


@pytest.mark.parametrize("exact_cap", [False, True])
def test_delete_without_move_is_hidden_and_slot_refilled(monkeypatch, exact_cap) -> None:
    absent = {"move_file"}
    if exact_cap:
        absent.update(
            entry.descriptor.name for entry in _incident_tool_contract().entries
            if entry.descriptor.name not in {
                "tool_search", "delete_file", "read_file", "grep_search", "edit_file", "run_command",
            }
        )
    kept, resolution = _apply_filter(
        monkeypatch, absent=frozenset(absent), preferred=("delete_file",),
    )
    assert "delete_file" not in kept
    assert "delete_file" in resolution.budget_filtered_names
    assert len(kept) == resolution.budget_filter_metadata["cap"]


def test_un_deferred_delete_keeps_move_partner_and_repair_floor(monkeypatch) -> None:
    kept, resolution = _apply_filter(monkeypatch, un_deferred={"delete_file"})
    assert kept == [
        "delete_file", "tool_search", "read_file", "grep_search", "edit_file", "move_file",
    ]
    assert "delete_file" not in resolution.budget_filtered_names
    assert "move_file" not in resolution.budget_filtered_names


def test_un_deferred_pair_exceeds_cap_when_every_slot_is_mandatory_or_preferred(monkeypatch) -> None:
    kept, resolution = _apply_filter(
        monkeypatch, un_deferred={"delete_file", "read_file"}, preferred=("run_command",),
    )
    assert kept == [
        "delete_file", "tool_search", "read_file", "run_command", "grep_search", "move_file",
    ]
    assert len(kept) == resolution.budget_filter_metadata["cap"] + 1
