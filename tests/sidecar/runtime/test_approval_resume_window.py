"""Approval resume: which calls after the approved one run without a new prompt."""

from __future__ import annotations

from functools import partial
from types import SimpleNamespace
from typing import Any

import pytest

from sidecar.ai.config import RuntimeConfig
from sidecar.ai.routing.tool_execution import approval_if_needed
from sidecar.ai.tools.models import ToolCallRequest
from sidecar.ai.tools.policy import (
    POLICY_DECISION_ASK,
    PolicyDeniedToolCall,
    ToolPolicyDecision,
    ToolPolicyFilterResult,
)
from sidecar.runtime.approval_resume_window import _approval_resume_call_window, approved_call

_SIDE_EFFECTING = {
    "read_file": False,
    "workspace_present": False,
    "edit_file": True,
    "write_file": True,
}


class _Contract:
    def entry(self, tool_id: str) -> Any:
        if tool_id not in _SIDE_EFFECTING:
            return None
        descriptor = SimpleNamespace(
            name=tool_id,
            side_effecting=_SIDE_EFFECTING[tool_id],
            input_schema={"type": "object"},
        )
        return SimpleNamespace(available=True, descriptor=descriptor)


def _decision(call: ToolCallRequest, decision: str) -> ToolPolicyDecision:
    return ToolPolicyDecision(
        decision=decision,
        stage="rule",
        matched_rule_id="rule-1",
        reason="matched a rule",
        snapshot_version=1,
        tool_name=call.tool_id,
        tool_family="filesystem",
        source_kind="builtin",
        mode="assist",
    )


def _kernel(
    config: RuntimeConfig,
    *,
    ask: frozenset[str] = frozenset(),
    deny: frozenset[str] = frozenset(),
) -> SimpleNamespace:
    kernel = SimpleNamespace(
        _config=config,
        _is_direct_deferred_tool_call=lambda call, context: False,
        _mcp_client=SimpleNamespace(tool_descriptor=lambda name: None),
        _request_tool_set=lambda preferences, key: frozenset(),
    )

    def _filter(calls: tuple[ToolCallRequest, ...], **_kwargs: Any) -> ToolPolicyFilterResult:
        denied = tuple(
            PolicyDeniedToolCall(call=call, decision=_decision(call, "deny"), metadata={})
            for call in calls
            if call.tool_id in deny
        )
        return ToolPolicyFilterResult(
            allowed=tuple(call for call in calls if call.tool_id not in deny),
            denied=denied,
            decisions_by_call={
                call.call_id: _decision(call, POLICY_DECISION_ASK)
                for call in calls
                if call.tool_id in ask
            },
            audit_metadata_by_call={},
        )

    kernel._filter_tool_calls_by_policy = _filter
    kernel._approval_if_needed = partial(approval_if_needed, kernel)
    return kernel


def _plan(*tool_ids: str, approved: str = "c1", approval_mode: str = "prompt") -> Any:
    return SimpleNamespace(
        approved_call_id=approved,
        call_id=approved,
        tool_calls=tuple(
            ToolCallRequest(tool_id=tool_id, arguments={"path": "a"}, call_id=f"c{index}")
            for index, tool_id in enumerate(tool_ids, start=1)
        ),
        request_context=SimpleNamespace(
            mode="assist",
            plan_mode=False,
            read_only=False,
            tool_preferences={},
            execution_context=None,
            approval_mode=approval_mode,
        ),
        tool_resolution_context=None,
    )


def _window(plan: Any, kernel: Any, *, recheck_trailing: bool = True) -> tuple[list, list]:
    selected, dropped = _approval_resume_call_window(
        plan, kernel=kernel, tool_contract=_Contract(), recheck_trailing=recheck_trailing
    )
    return [call.call_id for call in selected], [call.call_id for call in dropped]


def test_read_only_calls_after_the_approved_edit_run_in_the_window() -> None:
    plan = _plan("edit_file", "workspace_present", "read_file")

    assert _window(plan, _kernel(RuntimeConfig())) == (["c1", "c2", "c3"], [])


def test_the_window_stops_at_the_first_side_effecting_call() -> None:
    plan = _plan("edit_file", "workspace_present", "write_file", "read_file")

    assert _window(plan, _kernel(RuntimeConfig())) == (["c1", "c2"], ["c3", "c4"])


def test_paranoid_mode_keeps_every_trailing_call_out_of_the_window() -> None:
    plan = _plan("edit_file", "workspace_present")

    assert _window(plan, _kernel(RuntimeConfig(safety_mode="paranoid"))) == (["c1"], ["c2"])


@pytest.mark.parametrize("approval_mode", ["prompt", "auto_run"])
def test_an_ask_rule_stops_the_window(approval_mode: str) -> None:
    plan = _plan("edit_file", "read_file", "workspace_present", approval_mode=approval_mode)
    kernel = _kernel(RuntimeConfig(), ask=frozenset({"workspace_present"}))

    selected, dropped = _window(plan, kernel)
    if approval_mode == "prompt":
        assert (selected, dropped) == (["c1", "c2"], ["c3"])
    else:
        # Auto-run honours an ASK rule for an ordinary tool, as the live gate does.
        assert (selected, dropped) == (["c1", "c2", "c3"], [])


def test_a_policy_deny_stops_the_window() -> None:
    plan = _plan("edit_file", "read_file", "workspace_present")
    kernel = _kernel(RuntimeConfig(), deny=frozenset({"read_file"}))

    assert _window(plan, kernel) == (["c1"], ["c2", "c3"])


def test_a_kernel_that_cannot_evaluate_the_policy_fails_closed() -> None:
    plan = _plan("edit_file", "read_file")
    kernel = SimpleNamespace(_mcp_client=None)

    assert _window(plan, kernel) == (["c1"], ["c2"])


def test_without_the_recheck_every_trailing_call_is_dropped() -> None:
    plan = _plan("edit_file", "workspace_present")

    assert _window(plan, _kernel(RuntimeConfig()), recheck_trailing=False) == (["c1"], ["c2"])


def test_approved_call_is_found_by_id_not_position() -> None:
    plan = _plan("read_file", "edit_file", "workspace_present", approved="c2")
    selected, _dropped = _approval_resume_call_window(
        plan, kernel=_kernel(RuntimeConfig()), tool_contract=_Contract(), recheck_trailing=True
    )

    assert [call.call_id for call in selected] == ["c1", "c2", "c3"]
    assert approved_call(plan, selected).tool_id == "edit_file"
