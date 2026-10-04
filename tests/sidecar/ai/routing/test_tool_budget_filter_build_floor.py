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
from sidecar.ai.tools.assembly import CONFIG_DISABLED_REASON, AssembledToolContract

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
    **request_overrides: Any,
) -> list[str]:
    _force_budget_pressure(monkeypatch)
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
