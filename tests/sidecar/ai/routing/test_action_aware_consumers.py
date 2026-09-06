"""W7b-S1 red suite — per-consumer action-awareness for scalar side_effecting gates.

W6 re-keyed side-effect class by (tool, action) but left every consumer on the
scalar, with the coercion invariant write-classing any mixed tool. These tests
pin the S1 contract: at call-time gates (arguments available), a mixed tool's
resolved READ action escapes the side-effecting gate, its WRITE action and any
unresolvable action stay blocked (fail closed), and actionless descriptors are
untouched. List-time gates (assembly) list a mixed tool when at least one
non-side-effecting action exists. Automation stays conservative by decision
(w7b-design-notes.md).
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from sidecar.ai.error_codes import CMP_MODE_TOOL_BLOCKED
from sidecar.ai.routing.tool_execution import approval_if_needed
from sidecar.ai.tools.models import ToolCallRequest
from sidecar.ai.tools.assembly import (
    READ_ONLY_UNAVAILABLE_REASON,
    assemble_tool_contract,
    ToolAssemblyContext,
)
from sidecar.ai.tools.catalog import (
    MANAGED_SIDECAR_SURFACE,
    CanonicalToolAvailability,
    CanonicalToolDescriptor,
    ToolActionSpec,
)
from sidecar.ai.tools.contracts import ToolExecutionFailure

MIXED_ACTIONS = {
    "status": ToolActionSpec(side_effecting=False),
    "apply": ToolActionSpec(side_effecting=True),
}


def _mixed_descriptor(name: str = "mixer") -> SimpleNamespace:
    # Scalar True per the W6 coercion invariant (any write action ⇒ scalar True).
    return SimpleNamespace(
        name=name,
        side_effecting=True,
        input_schema={"type": "object", "properties": {}},
        source_kind="builtin",
        tool_family="workspace",
        server_name="tools",
        actions=dict(MIXED_ACTIONS),
    )


def _actionless_descriptor(name: str = "write_file") -> SimpleNamespace:
    return SimpleNamespace(
        name=name,
        side_effecting=True,
        input_schema={"type": "object", "properties": {}},
        source_kind="builtin",
        tool_family="filesystem",
        server_name="tools",
        actions=None,
    )


def _kernel(descriptor: Any) -> SimpleNamespace:
    return SimpleNamespace(
        _config=SimpleNamespace(
            tools_shell_enabled=True,
            tools_confirm_side_effects=False,
            feature_flags={},
            safety_mode="normal",
        ),
        _is_direct_deferred_tool_call=lambda call, ctx: False,
        _mcp_client=SimpleNamespace(tool_descriptor=lambda name: descriptor),
    )


def _call(tool_id: str, action: Any, call_id: str) -> ToolCallRequest:
    arguments: dict[str, Any] = {"target": "x"}
    if action is not None:
        arguments["action"] = action
    return ToolCallRequest(tool_id=tool_id, arguments=arguments, call_id=call_id)


def _approval(kernel: Any, call: ToolCallRequest, *, mode_allows: bool):
    return approval_if_needed(
        kernel,
        (call,),
        mode="read_only",
        mode_allows_side_effecting=mode_allows,
        require_approval=True,
        approvals_pre_granted=False,
        resolution_context=None,
        tool_contract=None,
    )


class TestModeGateActionAwareness:
    """tool_execution.approval_if_needed — the CMP_MODE_TOOL_BLOCKED gate."""

    def test_mixed_tool_read_action_passes_the_mode_gate(self) -> None:
        desc = _mixed_descriptor()
        result = _approval(_kernel(desc), _call("mixer", "status", "c-1"), mode_allows=False)
        assert result is None  # no raise: the resolved read action is not side-effecting

    def test_mixed_tool_write_action_still_mode_blocked(self) -> None:
        desc = _mixed_descriptor()
        with pytest.raises(ToolExecutionFailure) as excinfo:
            _approval(_kernel(desc), _call("mixer", "apply", "c-2"), mode_allows=False)
        assert excinfo.value.code == CMP_MODE_TOOL_BLOCKED

    def test_mixed_tool_missing_action_fails_closed_at_the_mode_gate(self) -> None:
        desc = _mixed_descriptor()
        with pytest.raises(ToolExecutionFailure) as excinfo:
            _approval(_kernel(desc), _call("mixer", None, "c-3"), mode_allows=False)
        assert excinfo.value.code == CMP_MODE_TOOL_BLOCKED

    def test_mixed_tool_garbage_action_fails_closed_at_the_mode_gate(self) -> None:
        desc = _mixed_descriptor()
        with pytest.raises(ToolExecutionFailure) as excinfo:
            _approval(_kernel(desc), _call("mixer", "explode", "c-4"), mode_allows=False)
        assert excinfo.value.code == CMP_MODE_TOOL_BLOCKED

    def test_actionless_side_effecting_tool_unchanged(self) -> None:
        desc = _actionless_descriptor()
        with pytest.raises(ToolExecutionFailure) as excinfo:
            _approval(
                _kernel(desc),
                ToolCallRequest(
                    tool_id="write_file",
                    arguments={"path": "x.txt", "content": "y"},
                    call_id="c-5",
                ),
                mode_allows=False,
            )
        assert excinfo.value.code == CMP_MODE_TOOL_BLOCKED


def _canonical(
    name: str,
    *,
    side_effecting: bool,
    actions: dict[str, ToolActionSpec] | None = None,
) -> CanonicalToolDescriptor:
    return CanonicalToolDescriptor(
        name=name,
        description=f"{name} description",
        input_schema={"type": "object", "properties": {}},
        side_effecting=side_effecting,
        read_only=not side_effecting,
        source_kind="builtin",
        tool_family="other",
        surfaces=(MANAGED_SIDECAR_SURFACE,),
        availability=CanonicalToolAvailability(),
        runtime_registered=True,
        server_name="runtime",
        actions=actions,
    )


def _assemble(descriptors, *, mode: str = "assist", read_only: bool = False):
    return assemble_tool_contract(
        tuple(descriptors),
        ToolAssemblyContext(
            surface=MANAGED_SIDECAR_SURFACE,
            config={},
            engine_supports_tool_calling=True,
            mode=mode,
            plan_mode=False,
            workspace_root_present=True,
            read_only=read_only,
        ),
    )


class TestAssemblyListTimeRelaxation:
    """assembly.py read_only listing: a mixed tool with >=1 read action stays listed.

    (The mode-policy side-effecting branch at assembly.py:380 is unreachable via
    current modes — chat blocks all tools, assist/autonomous allow side effects —
    so S1 relaxes only the live read_only gate at :388.)
    """

    def test_mixed_tool_listed_in_read_only_context(self) -> None:
        mixed = _canonical("mixer", side_effecting=True, actions=dict(MIXED_ACTIONS))
        contract = _assemble([mixed], read_only=True)
        entry = contract.entry("mixer")
        assert entry.available is True, entry.reason

    def test_pure_write_tool_still_withheld_in_read_only_context(self) -> None:
        writer = _canonical("writer", side_effecting=True)
        contract = _assemble([writer], read_only=True)
        entry = contract.entry("writer")
        assert entry.available is False
        assert entry.reason == READ_ONLY_UNAVAILABLE_REASON

    def test_all_write_actions_tool_not_relaxed(self) -> None:
        # Every declared action is side-effecting → no relaxation applies.
        all_write = _canonical(
            "allwriter",
            side_effecting=True,
            actions={"apply": ToolActionSpec(side_effecting=True)},
        )
        contract = _assemble([all_write], read_only=True)
        entry = contract.entry("allwriter")
        assert entry.available is False
        assert entry.reason == READ_ONLY_UNAVAILABLE_REASON


# ---------------------------------------------------------------------------
# tool_call_execution.pre_filter_tool_calls — read_only reject (:232) and
# coerced-args reject (:297) must consult the resolved action.
# ---------------------------------------------------------------------------

from sidecar.ai.routing.loop_runtime import LoopRuntime  # noqa: E402
from sidecar.ai.routing.tool_call_execution import pre_filter_tool_calls  # noqa: E402


class _PrefilterKernel:
    def __init__(self) -> None:
        self._mcp_client = SimpleNamespace(tool_descriptor=lambda name: None)

    def _assert_valid_tool_call(self, _call: Any) -> None:
        return None

    def _assistant_tool_call_message(self, *_a: Any, **_k: Any) -> dict[str, object]:
        return {"role": "assistant"}

    def _tool_result_message(self, *_a: Any, **_k: Any) -> dict[str, object]:
        return {"role": "tool"}

    def _build_deferred_outcome(self, call: Any) -> Any:
        raise AssertionError("deferred outcome not expected in these cases")


def _prefilter_one(call_args: dict[str, Any], *, coerced: bool, read_only: bool):
    descriptor = _mixed_descriptor()
    entry = SimpleNamespace(
        descriptor=descriptor, available=True, reason=None, deferred=False
    )
    contract = SimpleNamespace(entry=lambda name: entry if name == "mixer" else None)
    outcomes: list[Any] = []
    runtime = LoopRuntime(
        emit=lambda event: None,
        streaming=False,
        request_id="req-aac",
    )
    remaining, _ = pre_filter_tool_calls(
        [ToolCallRequest(tool_id="mixer", arguments=call_args, call_id="c-aac", coerced=coerced)],
        kernel=_PrefilterKernel(),
        runtime=runtime,
        result=SimpleNamespace(),
        request_id="req-aac",
        session_id="s-aac",
        tool_resolution_context=None,
        tool_contract=contract,
        read_only=read_only,
        outcomes=outcomes,
        working_messages=[],
        iteration_calls=[],
        streamed_event_types=set(),
        outcome_index=0,
    )
    return remaining, outcomes


class TestPreFilterActionAwareness:
    def test_mixed_read_action_survives_read_only_prefilter(self) -> None:
        remaining, outcomes = _prefilter_one(
            {"action": "status", "target": "x"}, coerced=False, read_only=True
        )
        assert len(remaining) == 1
        assert outcomes == []

    def test_mixed_write_action_blocked_in_read_only_prefilter(self) -> None:
        remaining, outcomes = _prefilter_one(
            {"action": "apply", "target": "x"}, coerced=False, read_only=True
        )
        assert remaining == []
        assert len(outcomes) == 1
        assert outcomes[0].metadata.get("read_only_blocked") is True

    def test_mixed_garbage_action_blocked_in_read_only_prefilter(self) -> None:
        remaining, outcomes = _prefilter_one(
            {"action": "explode", "target": "x"}, coerced=False, read_only=True
        )
        assert remaining == []
        assert len(outcomes) == 1
        assert outcomes[0].metadata.get("read_only_blocked") is True

    def test_mixed_read_action_survives_coerced_gate(self) -> None:
        remaining, outcomes = _prefilter_one(
            {"action": "status", "target": "x"}, coerced=True, read_only=False
        )
        assert len(remaining) == 1
        assert outcomes == []

    def test_mixed_write_action_coerced_still_rejected(self) -> None:
        remaining, outcomes = _prefilter_one(
            {"action": "apply", "target": "x"}, coerced=True, read_only=False
        )
        assert remaining == []
        assert len(outcomes) == 1
        assert outcomes[0].metadata.get("coerced_arguments_rejected") is True


# ---------------------------------------------------------------------------
# chat_resume._approval_resume_call_window — earlier calls replay without
# re-approval only when their resolved action is non-side-effecting.
# ---------------------------------------------------------------------------

from sidecar.runtime.chat_resume import _approval_resume_call_window  # noqa: E402
from sidecar.runtime.operation_ledger_calls import inject_idempotency_key  # noqa: E402


def _resume_window(first_action: str | None):
    args: dict[str, Any] = {"target": "x"}
    if first_action is not None:
        args["action"] = first_action
    earlier = SimpleNamespace(tool_id="mixer", arguments=args, call_id="c-earlier")
    approved = SimpleNamespace(tool_id="write_file", arguments={"path": "a"}, call_id="c-approved")
    plan = SimpleNamespace(
        approved_call_id="c-approved",
        call_id="c-approved",
        tool_calls=(earlier, approved),
    )
    descriptor = _mixed_descriptor()
    entry = SimpleNamespace(descriptor=descriptor)
    contract = SimpleNamespace(entry=lambda name: entry if name == "mixer" else None)
    return _approval_resume_call_window(plan, kernel=SimpleNamespace(), tool_contract=contract)


class TestResumeWindowActionAwareness:
    def test_mixed_read_call_replays_before_the_approved_call(self) -> None:
        selected, dropped = _resume_window("status")
        assert [c.call_id for c in selected] == ["c-earlier", "c-approved"]
        assert dropped == ()

    def test_mixed_write_call_is_dropped_not_replayed(self) -> None:
        selected, dropped = _resume_window("apply")
        assert [c.call_id for c in selected] == ["c-approved"]
        assert [c.call_id for c in dropped] == ["c-earlier"]

    def test_mixed_unresolvable_action_is_dropped_not_replayed(self) -> None:
        selected, dropped = _resume_window(None)
        assert [c.call_id for c in selected] == ["c-approved"]
        assert [c.call_id for c in dropped] == ["c-earlier"]


# ---------------------------------------------------------------------------
# operation_ledger_calls.inject_idempotency_key — a mixed tool's read action
# carries no idempotency key; its write action still gets one.
# ---------------------------------------------------------------------------


class TestLedgerInjectionActionAwareness:
    def _inject(self, action: str) -> dict[str, object]:
        call = SimpleNamespace(
            tool_id="mixer", arguments={"action": action, "target": "x"}, call_id="c-led"
        )
        runtime = SimpleNamespace(session_id="s", request_id="r")
        args: dict[str, object] = {"action": action, "target": "x"}
        return inject_idempotency_key(
            args, descriptor=_mixed_descriptor(), runtime=runtime, call=call
        )

    def test_mixed_read_action_gets_no_idempotency_key(self) -> None:
        assert "_jenny_idempotency_key" not in self._inject("status")

    def test_mixed_write_action_still_gets_an_idempotency_key(self) -> None:
        assert "_jenny_idempotency_key" in self._inject("apply")
