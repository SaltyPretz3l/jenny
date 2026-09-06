"""Red-first contract for the W3 availability-vs-applicability split.

`available` keeps its EXACT current meaning; unmet preconditions surface on
two new RuntimeToolStatus fields instead. The invariant the spec calls out by
line: `applicable` must never feed the deferral machinery or availability —
pinned here by building the same contract with and without preconditions and
comparing every availability-side fact.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from sidecar.ai.context.builder_shared import RuntimeToolStatus
from sidecar.ai.tools.assembly import (
    ToolAssemblyContext,
    assemble_tool_contract,
)
from sidecar.ai.tools.catalog import (
    MANAGED_SIDECAR_SURFACE,
    CanonicalToolAvailability,
    CanonicalToolDescriptor,
    parse_tool_preconditions,
)
from sidecar.ai.tools.preconditions import PreconditionSpec


def _descriptor(
    name: str,
    *,
    availability: CanonicalToolAvailability | None = None,
    preconditions: tuple[PreconditionSpec, ...] = (),
    defer_eligible: bool = False,
) -> CanonicalToolDescriptor:
    resolved_availability = availability or CanonicalToolAvailability(
        workspace_required=True, defer_eligible=defer_eligible
    )
    return CanonicalToolDescriptor(
        name=name,
        description=f"{name} description",
        input_schema={"type": "object", "properties": {}},
        side_effecting=False,
        read_only=True,
        source_kind="builtin",
        tool_family="other",
        surfaces=(MANAGED_SIDECAR_SURFACE,),
        availability=resolved_availability,
        runtime_registered=True,
        server_name="runtime",
        preconditions=preconditions,
    )


_GIT_REPO_PRECONDITION = PreconditionSpec(
    id="git_repo", probe="git_root_present", severity="blocking"
)


def _assemble(descriptors: tuple[CanonicalToolDescriptor, ...], *, workspace_root: Path) -> Any:
    return assemble_tool_contract(
        descriptors,
        ToolAssemblyContext(
            surface=MANAGED_SIDECAR_SURFACE,
            config={
                "tools_enabled": True,
                "tools_workspace_root": str(workspace_root),
            },
            engine_supports_tool_calling=True,
            mode="assist",
            plan_mode=False,
            workspace_root_present=True,
        ),
    )


def test_status_declares_the_two_new_fields_with_safe_defaults() -> None:
    status = RuntimeToolStatus(name="x", display_name="x", available=True)
    assert status.applicable is True
    assert status.unmet_preconditions == ()


def test_unmet_blocking_precondition_is_inapplicable_but_still_available(tmp_path: Path) -> None:
    contract = _assemble(
        (_descriptor("git_status", preconditions=(_GIT_REPO_PRECONDITION,)),),
        workspace_root=tmp_path,  # no .git
    )
    entry = contract.entry("git_status")
    assert entry.available is True
    status = entry.runtime_status()
    assert status.applicable is False
    assert status.unmet_preconditions == ("git_repo",)


def test_met_precondition_is_applicable(tmp_path: Path) -> None:
    (tmp_path / ".git").mkdir()
    contract = _assemble(
        (_descriptor("git_status", preconditions=(_GIT_REPO_PRECONDITION,)),),
        workspace_root=tmp_path,
    )
    status = contract.entry("git_status").runtime_status()
    assert status.applicable is True
    assert status.unmet_preconditions == ()


def test_preconditions_never_change_availability_reason_or_deferral(tmp_path: Path) -> None:
    def snapshot(with_preconditions: bool) -> list[tuple[str, bool, str | None, bool]]:
        preconditions = (_GIT_REPO_PRECONDITION,) if with_preconditions else ()
        contract = _assemble(
            (
                _descriptor("git_status", preconditions=preconditions),
                _descriptor("plain_tool"),
                _descriptor("deferred_tool", defer_eligible=True, preconditions=preconditions),
            ),
            workspace_root=tmp_path,
        )
        return [
            (entry.descriptor.name, entry.available, entry.reason, entry.deferred)
            for entry in contract.entries
        ]

    assert snapshot(True) == snapshot(False)


def test_manifest_parse_reads_preconditions_sibling_key() -> None:
    parsed = parse_tool_preconditions(
        [
            {"id": "git_repo", "probe": "git_root_present", "severity": "blocking"},
            {"id": "py", "probe": "python_runtime_ready"},
            {"id": "bad", "probe": ""},
            "not-a-dict",
            {"id": "worse", "probe": "git_root_present", "severity": "nonsense"},
        ]
    )
    assert parsed == (
        PreconditionSpec(id="git_repo", probe="git_root_present", severity="blocking"),
        PreconditionSpec(id="py", probe="python_runtime_ready", severity="blocking"),
    )
    assert parse_tool_preconditions(None) == ()
    assert parse_tool_preconditions("garbage") == ()
