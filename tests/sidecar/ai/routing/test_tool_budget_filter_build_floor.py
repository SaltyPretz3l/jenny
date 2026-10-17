"""HB-029: an approved or coding build turn keeps its typed file tools under budget pressure.

History un-deferrals are mandatory and used to fill the error-level cap on their
own, so an approved build turn arrived without read_file/edit_file/write_file and
the model applied its edits through scripts. The build-turn floor is mandatory
too; it only chooses among candidates and never resurrects an unavailable tool.
"""

from __future__ import annotations

import sys
from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_tool_budget_filter_probe_parity import (  # shared budget harness.
    _filter_input,
    _force_budget_pressure,
    _incident_tool_contract,
    _IncidentFilterKernel,
)

from sidecar.ai.routing.tool_budget_filter import apply_budget_aware_tool_filter
from sidecar.ai.tools.assembly import (
    CONFIG_DISABLED_REASON,
    AssembledToolContract,
    AssembledToolEntry,
)
from sidecar.ai.tools.catalog import CanonicalToolAvailability, CanonicalToolDescriptor

_FLOOR = {"read_file", "edit_file", "write_file", "run_command"}
_APPROVED_PLAN = {
    "title": "Reconcile the bank export",
    "steps": ["Read matching.py", "Edit the matcher"],
    "verification": "Run the reconciliation tests",
}
# The G5 03:47 shape: four earlier tool_search loads plus tool_search fill cap 5.
_HISTORY_UNDEFERRALS = ("run_command", "git_status", "monitor", "glob_files")
_NO_FLOOR_UNDEFERRALS = ("git_status", "monitor", "glob_files", "web_search")


def _kept_names(
    monkeypatch: pytest.MonkeyPatch,
    *,
    un_deferred: tuple[str, ...],
    query: str = "proceed",
    contract: AssembledToolContract | None = None,
    level: str = "error",
    **request_overrides: Any,
) -> list[str]:
    _force_budget_pressure(monkeypatch, level)
    base = _filter_input(_IncidentFilterKernel())
    context = replace(
        base,
        request_context=replace(base.request_context, **request_overrides),
        latest_user_content=query,
    )
    resolution = context.tool_resolution_context
    assert resolution is not None
    resolution.un_deferred_names.update(un_deferred)
    contract = contract or _incident_tool_contract()
    apply_budget_aware_tool_filter(
        context,
        tool_contract=contract,
        tool_payload=list(contract.prompt_schemas),
        tool_statuses=contract.status_entries,
    )
    return list(resolution.budget_filter_metadata["kept_names"])


def test_approved_build_keeps_typed_file_tools_when_history_undeferrals_fill_the_cap(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    kept = _kept_names(
        monkeypatch,
        un_deferred=_HISTORY_UNDEFERRALS,
        mode="assist",
        approved_plan=_APPROVED_PLAN,
    )

    assert _FLOOR <= set(kept)
    # History un-deferrals stay mandatory; the floor rides alongside them.
    assert set(_HISTORY_UNDEFERRALS) <= set(kept)
    assert kept[0] == "tool_search"


def test_coding_prompt_with_workspace_root_keeps_the_floor(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    kept = _kept_names(
        monkeypatch,
        un_deferred=_NO_FLOOR_UNDEFERRALS,
        query="fix the failing test in matching.py",
        mode="assist",
        workspace_root_present=True,
    )

    assert _FLOOR <= set(kept)


@pytest.mark.parametrize(
    "request_overrides",
    [
        {"mode": "assist", "plan_mode": True, "read_only": True},
        {"mode": "assist", "read_only": True},
        {"mode": "chat"},
    ],
)
def test_plan_mode_read_only_and_chat_mode_get_no_floor(
    monkeypatch: pytest.MonkeyPatch, request_overrides: dict[str, Any]
) -> None:
    kept = _kept_names(
        monkeypatch,
        un_deferred=_NO_FLOOR_UNDEFERRALS,
        query="fix the failing test in matching.py",
        approved_plan=_APPROVED_PLAN,
        workspace_root_present=True,
        **request_overrides,
    )

    assert kept == ["tool_search", "monitor", "glob_files", "git_status", "web_search"]


def test_no_workspace_root_and_no_plan_gets_no_floor(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    kept = _kept_names(
        monkeypatch,
        un_deferred=_NO_FLOOR_UNDEFERRALS,
        query="fix the failing test in matching.py",
        mode="assist",
        workspace_root_present=False,
    )

    assert _FLOOR.isdisjoint(kept)


def test_floor_never_resurrects_a_tool_the_contract_marks_unavailable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    incident = _incident_tool_contract()
    contract = AssembledToolContract(
        tuple(
            replace(entry, available=False, reason=CONFIG_DISABLED_REASON, prompt_schema=None)
            if entry.descriptor.name == "edit_file"
            else entry
            for entry in incident.entries
        )
    )

    kept = _kept_names(
        monkeypatch,
        un_deferred=_HISTORY_UNDEFERRALS,
        contract=contract,
        mode="assist",
        approved_plan=_APPROVED_PLAN,
    )

    assert "edit_file" not in kept
    assert {"read_file", "write_file", "run_command"} <= set(kept)


_REA_STARTERS = (
    "binary_session", "analyze_javascript_application", "inspect_analysis_view",
    "get_evidence_bundle", "inspect_managed_artifact", "inspect_binary_layout",
    "inspect_pe_resources", "open_binary", "inspect_artifact",
    "inspect_web_network_capture", "analyze_function", "binary_overview",
)


def _with_rea_tools(server_name: str) -> AssembledToolContract:
    entries = list(_incident_tool_contract().entries)
    for tool in (*_REA_STARTERS, "list_procedures", "inspect_go_symbols"):
        name = f"mcp__{server_name}__{tool}"
        descriptor = CanonicalToolDescriptor(
            name=name, description=f"rea {tool}", input_schema={"type": "object"},
            side_effecting=True, read_only=False, category="mcp", source_kind="mcp",
            availability=CanonicalToolAvailability(defer_eligible=True),
            server_name=server_name, connection_id=f"mcp:{server_name}",
        )
        entries.append(AssembledToolEntry(
            descriptor=descriptor, available=True,
            prompt_schema={"name": name, "description": descriptor.description,
                           "parameters": descriptor.input_schema},
        ))
    return AssembledToolContract(tuple(entries))


class _ReaFilterKernel(_IncidentFilterKernel):
    """Rebuilds the contract with the rea tools, so the payload can be checked."""

    def __init__(self, server_name: str) -> None:
        super().__init__()
        self.server_name = server_name

    def _assemble_tool_contract(self, *, request_context: Any, resolution_context: Any) -> Any:
        del request_context
        hidden = resolution_context.budget_filtered_names
        return AssembledToolContract(tuple(
            entry for entry in _with_rea_tools(self.server_name).entries
            if entry.descriptor.name not in hidden
        ))


def _rea_kept(
    monkeypatch: pytest.MonkeyPatch, *, level: str = "error", query: str = "proceed",
    un_deferred: tuple[str, ...] = (),
) -> list[str]:
    _force_budget_pressure(monkeypatch, level)
    base = _filter_input(_ReaFilterKernel("rea"))
    context = replace(
        base, request_context=replace(base.request_context, mode="chat"), latest_user_content=query,
    )
    resolution = context.tool_resolution_context
    assert resolution is not None
    resolution.un_deferred_names.update(un_deferred)
    contract = _with_rea_tools("rea")
    result = apply_budget_aware_tool_filter(
        context, tool_contract=contract, tool_payload=list(contract.prompt_schemas),
        tool_statuses=contract.status_entries,
    )
    kept = list(resolution.budget_filter_metadata["kept_names"])
    # The advertised payload is the selection (Astra W2 F6), not just the metadata.
    assert set(kept) == {schema["name"] for schema in result.tool_payload}
    return kept


@pytest.mark.parametrize("level", ["warning", "auto_compact", "error"])
def test_rea_starters_fill_the_slots_the_request_leaves(
    monkeypatch: pytest.MonkeyPatch, level: str
) -> None:
    # Row 53 S5 (Astra W2 F5): starters are preferred last, never mandatory. The
    # request's own picks (tool_search and the incident repair floor) come first and
    # the starters fill every remaining slot; no other rea tool rides along.
    kept = _rea_kept(monkeypatch, level=level)
    cap = {"warning": 12, "auto_compact": 8, "error": 5}[level]
    starters = {f"mcp__rea__{tool}" for tool in _REA_STARTERS}

    assert len(kept) == cap
    assert {"tool_search", "read_file", "grep_search", "edit_file"} <= set(kept)
    assert len(set(kept) & starters) == cap - 4
    assert {name for name in kept if name.startswith("mcp__")} <= starters
    assert "mcp__rea__list_procedures" not in kept
    assert "mcp__rea__inspect_go_symbols" not in kept


def test_rea_starters_never_evict_the_request_s_own_tools(monkeypatch: pytest.MonkeyPatch) -> None:
    # The current-info and repair guarantees of test_tool_budget_filter_pairing hold
    # with rea connected (Astra W2 F5).
    assert "web_search" in _rea_kept(monkeypatch, query="What is the latest news today?")
    kept = _rea_kept(
        monkeypatch, query="the start button does not currently work!", un_deferred=("delete_file",)
    )
    assert {"delete_file", "tool_search", "read_file", "grep_search", "edit_file", "move_file"} <= set(kept)


def test_a_server_not_named_rea_gets_no_starter_floor(monkeypatch: pytest.MonkeyPatch) -> None:
    kept = _kept_names(monkeypatch, un_deferred=(), contract=_with_rea_tools("rea2"), mode="chat")

    assert len(kept) == 5
    assert not any(name.startswith("mcp__rea2__") for name in kept)
