"""Security review item 7: the first ``verify`` run after a workspace write asks once.

The policy filter, the per-turn escalation and the real approval gate run together;
the turn's outcomes are the only state, as in the tool loop.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from sidecar.ai.config import (
    RuntimeConfig,
    ToolPolicyRule,
    ToolPolicyRuleMatch,
    ToolPolicySnapshot,
)
from sidecar.ai.error_codes import CMP_TOOL_APPROVAL_DENIED
from sidecar.ai.mcp.models import MCPToolDescriptor
from sidecar.ai.routing import tool_loop, verify_after_write
from sidecar.ai.routing.router import ToolExecutionOutcome
from sidecar.ai.routing.tool_execution import approval_if_needed, filter_tool_calls_by_policy
from sidecar.ai.routing.verify_after_write import armed_by_outcomes, escalate_after_writes
from sidecar.ai.tools.models import ToolCallRequest
from sidecar.ai.tools.policy import (
    POLICY_DECISION_ASK,
    POLICY_DECISION_AUTO,
    VERIFY_AFTER_WRITE_REASON,
    VERIFY_AFTER_WRITE_STAGE,
)
from sidecar.ai.tools.tool_actions import ToolActionSpec

_SCHEMA = {"type": "object", "properties": {}}
_VERIFY = MCPToolDescriptor(
    name="verify",
    description="Run a saved test configuration",
    input_schema=_SCHEMA,
    side_effecting=True,
    server_name="electron_tool_bridge",
    source_kind="builtin",
    tool_family="workspace",
    actions={
        "list": ToolActionSpec(side_effecting=False),
        "run": ToolActionSpec(side_effecting=True),
        "gate": ToolActionSpec(side_effecting=True),
    },
)
_WRITE = MCPToolDescriptor(
    name="write_file",
    description="Write a file",
    input_schema=_SCHEMA,
    side_effecting=True,
    server_name="jenny_local_tools",
    source_kind="builtin",
    tool_family="filesystem",
)
_DESCRIPTORS = {descriptor.name: descriptor for descriptor in (_VERIFY, _WRITE)}


class _Contract:
    def entry(self, tool_name: str) -> object | None:
        descriptor = _DESCRIPTORS.get(tool_name)
        if descriptor is None:
            return None
        return SimpleNamespace(available=True, descriptor=descriptor, reason=None, deferred=False)


_CONTRACT = _Contract()


def _kernel(snapshot: ToolPolicySnapshot | None = None) -> SimpleNamespace:
    config = RuntimeConfig(tools_confirm_side_effects=True, tool_policy_snapshot=snapshot)
    return SimpleNamespace(
        _config=config,
        _is_direct_deferred_tool_call=lambda call, context: False,
        _mcp_client=SimpleNamespace(tool_descriptor=_DESCRIPTORS.get),
    )


def _verify_call(call_id: str = "call-verify", action: str = "run") -> ToolCallRequest:
    return ToolCallRequest(
        tool_id="verify", arguments={"action": action, "config_id": "unit"}, call_id=call_id
    )


def _write_call(call_id: str = "call-write") -> ToolCallRequest:
    return ToolCallRequest(
        tool_id="write_file", arguments={"path": "a.py", "content": "x"}, call_id=call_id
    )


def _write_outcome(*, success: bool = True) -> ToolExecutionOutcome:
    return ToolExecutionOutcome(
        tool_name="write_file", output="ok", success=success, tool_input={"path": "a.py"}
    )


def _verify_outcome(*, success: bool = True, error_code: str | None = None) -> ToolExecutionOutcome:
    return ToolExecutionOutcome(
        tool_name="verify",
        output="Verification passed",
        success=success,
        tool_input={"action": "run", "config_id": "unit"},
        error_code=error_code,
    )


def _gate(
    calls: tuple[ToolCallRequest, ...],
    outcomes: list[Any],
    *,
    snapshot: ToolPolicySnapshot | None = None,
    approval_mode: str = "prompt",
) -> tuple[Any, Any]:
    """The loop's sequence: policy filter, per-turn escalation, approval gate."""
    kernel = _kernel(snapshot)
    common: dict[str, Any] = {
        "mode": "assist",
        "mode_allows_side_effecting": True,
        "resolution_context": None,
        "tool_contract": _CONTRACT,
    }
    policy = filter_tool_calls_by_policy(kernel, calls, policy_snapshot=snapshot, **common)
    policy = escalate_after_writes(policy, outcomes=outcomes, tool_contract=_CONTRACT)
    approval = None
    for call in policy.allowed:  # one call at a time, as approval_with_recovery does
        approval = approval_if_needed(
            kernel,
            (call,),
            require_approval=True,
            approvals_pre_granted=False,
            policy_decisions_by_call=policy.decisions_by_call,
            approval_mode=approval_mode,
            **common,
        )
        if approval is not None:
            break
    return approval, policy


def test_verify_with_no_prior_write_stays_auto() -> None:
    approval, policy = _gate((_verify_call(),), [])

    assert approval is None
    assert policy.decisions_by_call["call-verify"].decision == POLICY_DECISION_AUTO


def test_write_then_verify_requests_approval_once() -> None:
    approval, policy = _gate((_verify_call(),), [_write_outcome()])

    assert approval is not None
    assert approval.tool_name == "verify"
    assert approval.tool_call_id == "call-verify"
    assert VERIFY_AFTER_WRITE_REASON in approval.reason
    decision = policy.decisions_by_call["call-verify"]
    assert (decision.decision, decision.stage) == (POLICY_DECISION_ASK, VERIFY_AFTER_WRITE_STAGE)
    assert approval.policy_decision_id == decision.id
    audited = policy.audit_metadata_by_call["call-verify"]["policy_decision"]
    assert audited["stage"] == VERIFY_AFTER_WRITE_STAGE


def test_approved_verify_run_keeps_later_verify_runs_auto() -> None:
    outcomes = [_write_outcome(), _verify_outcome()]  # the approved run executed

    approval, _policy = _gate((_verify_call("call-verify-2"),), outcomes)

    assert approval is None


def test_a_failing_test_run_still_counts_as_the_approved_run() -> None:
    # verify reports failing tests as a successful tool result (isError false).
    outcomes = [_write_outcome(), _verify_outcome(success=True)]

    assert armed_by_outcomes(outcomes, tool_contract=_CONTRACT) is False


def test_a_second_write_asks_again() -> None:
    outcomes = [_write_outcome(), _verify_outcome(), _write_outcome()]

    approval, _policy = _gate((_verify_call("call-verify-3"),), outcomes)

    assert approval is not None
    assert VERIFY_AFTER_WRITE_REASON in approval.reason


@pytest.mark.parametrize(
    "denied",
    [
        _verify_outcome(success=False, error_code=CMP_TOOL_APPROVAL_DENIED),
        _verify_outcome(success=False, error_code="CMP-TOOL-0003"),
    ],
    ids=["denied", "refused"],
)
def test_a_denied_or_refused_verify_does_not_disarm(denied: ToolExecutionOutcome) -> None:
    # A denial ends the turn like any denied call; nothing it left behind counts
    # as the approved run, so the next verify in the turn still asks.
    approval, _policy = _gate((_verify_call("call-verify-4"),), [_write_outcome(), denied])

    assert approval is not None


def test_a_failed_write_does_not_arm() -> None:
    approval, _policy = _gate((_verify_call(),), [_write_outcome(success=False)])

    assert approval is None


@pytest.mark.parametrize(
    ("metadata", "expected"),
    [({"workspace_changed": True}, True), ({"workspace_changed": False}, False), ({}, False)],
)
def test_a_command_arms_only_on_change_evidence(metadata: dict[str, object], expected: bool) -> None:
    outcome = ToolExecutionOutcome(
        tool_name="run_command", output="", success=True, metadata=metadata
    )

    assert armed_by_outcomes([outcome], tool_contract=_CONTRACT) is expected


def test_verify_list_after_a_write_stays_auto() -> None:
    approval, _policy = _gate((_verify_call(action="list"),), [_write_outcome()])

    assert approval is None


def test_a_write_earlier_in_the_same_batch_arms_the_check() -> None:
    # A user AUTO rule for write_file lets the write through unprompted; the verify
    # after it in the same batch must not ride along before the write has run.
    snapshot = ToolPolicySnapshot(
        rules=(
            ToolPolicyRule(
                id="user-auto-write",
                decision="auto",
                reason="Trust writes",
                match=ToolPolicyRuleMatch(tool_id="write_file"),
            ),
        )
    )

    approval, _policy = _gate((_write_call(), _verify_call()), [], snapshot=snapshot)

    assert approval is not None
    assert approval.tool_name == "verify"


def test_a_verify_before_the_write_in_a_batch_stays_auto() -> None:
    snapshot = ToolPolicySnapshot(
        rules=(
            ToolPolicyRule(
                id="user-auto-write",
                decision="auto",
                reason="Trust writes",
                match=ToolPolicyRuleMatch(tool_id="write_file"),
            ),
        )
    )

    approval, _policy = _gate((_verify_call(), _write_call()), [], snapshot=snapshot)

    assert approval is None


@pytest.mark.parametrize(
    "snapshot",
    [
        ToolPolicySnapshot(
            rules=(
                ToolPolicyRule(
                    id="user-auto-verify",
                    decision="auto",
                    reason="Run my tests",
                    match=ToolPolicyRuleMatch(tool_id="verify"),
                ),
            )
        ),
        ToolPolicySnapshot(legacy_policies=(("verify", "auto"),)),
    ],
    ids=["user-rule", "stored-per-tool-policy"],
)
def test_a_saved_auto_policy_for_verify_keeps_its_precedence(snapshot: ToolPolicySnapshot) -> None:
    approval, policy = _gate((_verify_call(),), [_write_outcome()], snapshot=snapshot)

    assert approval is None
    assert policy.decisions_by_call["call-verify"].stage != VERIFY_AFTER_WRITE_STAGE


def test_a_user_ask_rule_for_verify_still_asks_with_its_own_reason() -> None:
    snapshot = ToolPolicySnapshot(
        rules=(
            ToolPolicyRule(
                id="user-ask-verify",
                decision="ask",
                reason="Check every run",
                match=ToolPolicyRuleMatch(tool_id="verify"),
            ),
        )
    )

    approval, _policy = _gate((_verify_call(),), [_write_outcome()], snapshot=snapshot)

    assert approval is not None
    assert "Check every run" in approval.reason


def test_a_one_send_auto_run_grant_covers_the_escalated_ask() -> None:
    approval, policy = _gate((_verify_call(),), [_write_outcome()], approval_mode="auto_run")

    assert approval is None
    assert policy.decisions_by_call["call-verify"].stage == VERIFY_AFTER_WRITE_STAGE


def test_the_tool_loop_hub_exposes_the_escalation() -> None:
    # tool_loop_calls and the continuation preflight reach it through the hub.
    assert tool_loop.verify_after_write is verify_after_write


def test_the_real_tool_loop_asks_for_verify_after_an_auto_write() -> None:
    from dataclasses import replace

    from sidecar.ai.routing.loop_runtime import LoopRuntime
    from sidecar.ai.tools.models import GenerationResult
    from tests.sidecar.ai.routing.test_tool_loop import (
        _build_router,
        _StubMCPClient,
        _ToolLoopEngine,
        _ToolPlan,
    )

    engine = _ToolLoopEngine(
        plans=[
            _ToolPlan(result=GenerationResult(content="", tool_calls=(_write_call(),))),
            _ToolPlan(result=GenerationResult(content="", tool_calls=(_verify_call(),))),
        ]
    )
    mcp_client = _StubMCPClient(
        (replace(_WRITE, server_name="tools"), replace(_VERIFY, server_name="tools"))
    )
    router = _build_router(engine=engine, mcp_client=mcp_client)
    snapshot = ToolPolicySnapshot(
        rules=(
            ToolPolicyRule(
                id="user-auto-write",
                decision="auto",
                reason="Trust writes",
                match=ToolPolicyRuleMatch(tool_id="write_file"),
            ),
        )
    )
    router._config = replace(router._config, tool_policy_snapshot=snapshot, tools_verify_enabled=True)

    decision = router.build_chat_decision(
        request_id="req_verify_after_write",
        messages=[{"role": "user", "content": "write it and test it"}],
        latest_user_content="write it and test it",
        mode="assist",
        approvals_pre_granted=False,
        runtime=LoopRuntime(request_id="req_verify_after_write", max_iterations=4),
    )

    assert [name for name, _args in mcp_client.executions] == ["write_file"]
    assert decision.approval_request is not None
    assert decision.approval_request.tool_name == "verify"
    assert VERIFY_AFTER_WRITE_REASON in decision.approval_request.reason
