from __future__ import annotations

from types import SimpleNamespace

import pytest

from sidecar.ai.config import (
    RuntimeConfig,
    ToolPolicyRule,
    ToolPolicyRuleMatch,
    ToolPolicySnapshot,
)
from sidecar.ai.error_codes import CMP_TOOL_COERCED_ARGS_REJECTED, CMP_TOOL_POLICY_DENIED
from sidecar.ai.routing import tool_execution
from sidecar.ai.routing.tool_execution import approval_if_needed, filter_tool_calls_by_policy
from sidecar.ai.tools.builtins.shell_security import ClassificationResult, CommandVerdict
from sidecar.ai.tools.models import ToolCallRequest
from sidecar.ai.tools.policy import tool_policy_call_key
from sidecar.runtime import turn_state


class _Contract:
    def __init__(self, descriptor: object) -> None:
        self._descriptor = descriptor

    def entry(self, tool_name: str) -> object | None:
        if tool_name != getattr(self._descriptor, "name", ""):
            return None
        return SimpleNamespace(available=True, descriptor=self._descriptor)


def test_paranoid_safety_mode_requires_approval_for_read_only_tool() -> None:
    descriptor = SimpleNamespace(
        name="read_file",
        side_effecting=False,
        input_schema={"type": "object", "properties": {"path": {"type": "string"}}},
    )
    kernel = SimpleNamespace(
        _config=RuntimeConfig(safety_mode="paranoid"),
        _is_direct_deferred_tool_call=lambda call, context: False,
        _mcp_client=SimpleNamespace(tool_descriptor=lambda name: descriptor),
    )

    approval = approval_if_needed(
        kernel,
        (
            ToolCallRequest(
                tool_id="read_file",
                arguments={"path": "README.md"},
                call_id="call-read-1",
            ),
        ),
        mode="assist",
        mode_allows_side_effecting=True,
        require_approval=True,
        approvals_pre_granted=False,
        resolution_context=None,
        tool_contract=_Contract(descriptor),
    )

    assert approval is not None
    assert approval.tool_name == "read_file"
    assert approval.tool_call_id == "call-read-1"
    assert "paranoid safety mode" in approval.reason.lower()


def test_request_policy_snapshot_overrides_interleaved_kernel_policy() -> None:
    descriptor = SimpleNamespace(
        name="read_file",
        side_effecting=False,
        input_schema={"type": "object", "properties": {"path": {"type": "string"}}},
        source_kind="builtin",
        tool_family="filesystem",
        server_name="jenny_builtin",
    )
    kernel = SimpleNamespace(
        _config=RuntimeConfig(tool_policy_snapshot=ToolPolicySnapshot(
            version=10,
            legacy_policies=(("read_file", "deny"),),
        )),
        _is_direct_deferred_tool_call=lambda call, context: False,
        _mcp_client=SimpleNamespace(tool_descriptor=lambda name: descriptor),
    )
    call = ToolCallRequest(
        tool_id="read_file",
        arguments={"path": "README.md"},
        call_id="call-scoped-policy",
    )

    allowed = filter_tool_calls_by_policy(
        kernel,
        (call,),
        mode="assist",
        mode_allows_side_effecting=True,
        resolution_context=None,
        tool_contract=_Contract(descriptor),
        policy_snapshot=ToolPolicySnapshot(
            version=11,
            legacy_policies=(("read_file", "auto"),),
        ),
    )
    denied = filter_tool_calls_by_policy(
        kernel,
        (call,),
        mode="assist",
        mode_allows_side_effecting=True,
        resolution_context=None,
        tool_contract=_Contract(descriptor),
        policy_snapshot=ToolPolicySnapshot(
            version=12,
            legacy_policies=(("read_file", "deny"),),
        ),
    )

    assert allowed.allowed == (call,)
    assert allowed.decisions_by_call[call.call_id].snapshot_version == 11
    assert denied.denied[0].call is call
    assert denied.decisions_by_call[call.call_id].snapshot_version == 12


def test_policy_ask_forces_approval_for_read_only_tool() -> None:
    descriptor = SimpleNamespace(
        name="read_file",
        side_effecting=False,
        input_schema={"type": "object", "properties": {"path": {"type": "string"}}},
        source_kind="mcp",
        tool_family="filesystem",
        server_name="tools",
    )
    snapshot = ToolPolicySnapshot(
        version=2,
        rules=(
            ToolPolicyRule(
                id="ask-reads",
                decision="ask",
                reason="Review all file reads",
                match=ToolPolicyRuleMatch(tool_id="read_file"),
            ),
        ),
    )
    kernel = SimpleNamespace(
        _config=RuntimeConfig(safety_mode="normal", tool_policy_snapshot=snapshot),
        _is_direct_deferred_tool_call=lambda call, context: False,
        _mcp_client=SimpleNamespace(tool_descriptor=lambda name: descriptor),
    )
    call = ToolCallRequest(
        tool_id="read_file",
        arguments={"path": "README.md"},
        call_id="call-read-policy-ask",
    )
    policy_filter = filter_tool_calls_by_policy(
        kernel,
        (call,),
        mode="assist",
        mode_allows_side_effecting=True,
        resolution_context=None,
        tool_contract=_Contract(descriptor),
    )

    approval = approval_if_needed(
        kernel,
        policy_filter.allowed,
        mode="assist",
        mode_allows_side_effecting=True,
        require_approval=True,
        approvals_pre_granted=False,
        resolution_context=None,
        tool_contract=_Contract(descriptor),
        policy_decisions_by_call=policy_filter.decisions_by_call,
    )

    assert approval is not None
    assert approval.tool_name == "read_file"
    assert approval.tool_call_id == "call-read-policy-ask"
    assert approval.policy_decision_id is not None
    assert approval.policy_scope == "Workspace files"
    assert approval.policy_consequence == "May read data in this scope."
    assert approval.to_payload()["policy_scope"] == "Workspace files"
    assert approval.to_payload()["policy_consequence"] == "May read data in this scope."
    assert "policy requires approval" in approval.reason.lower()


def _blanket_snapshot() -> ToolPolicySnapshot:
    return ToolPolicySnapshot(
        version=2,
        rules=(
            ToolPolicyRule(
                id="blanket_auto_approve",
                decision="auto",
                reason="Blanket auto-approve enabled in Settings",
                match=ToolPolicyRuleMatch(),
            ),
        ),
    )


def _write_file_descriptor() -> SimpleNamespace:
    return SimpleNamespace(
        name="write_file",
        side_effecting=True,
        input_schema={"type": "object", "properties": {"path": {"type": "string"}}},
        source_kind="mcp",
        tool_family="filesystem",
        server_name="tools",
    )


@pytest.mark.parametrize("decision", ["auto", "ask", "deny"])
@pytest.mark.parametrize("reverse_order", [False, True])
def test_write_aliases_share_one_policy_path(
    decision: str,
    reverse_order: bool,
) -> None:
    descriptor = _write_file_descriptor()
    snapshot = ToolPolicySnapshot(
        version=2,
        rules=(
            ToolPolicyRule(
                id=f"{decision}-safe-write",
                decision=decision,
                reason="Scoped write rule",
                match=ToolPolicyRuleMatch(
                    tool_id="write_file",
                    path_prefix="safe/",
                ),
            ),
        ),
    )
    kernel = SimpleNamespace(
        _config=RuntimeConfig(safety_mode="normal", tool_policy_snapshot=snapshot),
        _is_direct_deferred_tool_call=lambda call, context: False,
        _mcp_client=SimpleNamespace(tool_descriptor=lambda name: descriptor),
    )
    pairs = [
        ("path", "safe/notes.md"),
        ("file_path", "safe/notes.md"),
        ("content", "hello"),
    ]
    if reverse_order:
        pairs.reverse()
    call = ToolCallRequest(
        tool_id="write_file",
        arguments=dict(pairs),
        call_id=f"call-{decision}-{reverse_order}",
    )

    result = filter_tool_calls_by_policy(
        kernel,
        (call,),
        mode="assist",
        mode_allows_side_effecting=True,
        resolution_context=None,
        tool_contract=_Contract(descriptor),
    )

    selected = result.denied[0].call if decision == "deny" else result.allowed[0]
    assert selected.arguments == {"path": "safe/notes.md", "content": "hello"}
    if decision == "deny":
        assert result.denied[0].error_code == CMP_TOOL_POLICY_DENIED
    else:
        assert result.denied == ()


@pytest.mark.parametrize("reverse_order", [False, True])
def test_conflicting_write_aliases_fail_before_policy(reverse_order: bool) -> None:
    descriptor = _write_file_descriptor()
    snapshot = ToolPolicySnapshot(
        version=2,
        rules=(
            ToolPolicyRule(
                id="auto-safe-write",
                decision="auto",
                reason="Scoped write rule",
                match=ToolPolicyRuleMatch(tool_id="write_file", path_prefix="safe/"),
            ),
        ),
    )
    kernel = SimpleNamespace(
        _config=RuntimeConfig(safety_mode="normal", tool_policy_snapshot=snapshot),
        _is_direct_deferred_tool_call=lambda call, context: False,
        _mcp_client=SimpleNamespace(tool_descriptor=lambda name: descriptor),
    )
    pairs = [
        ("path", "restricted/target.md"),
        ("file_path", "safe/decoy.md"),
        ("content", "blocked"),
    ]
    if reverse_order:
        pairs.reverse()

    result = filter_tool_calls_by_policy(
        kernel,
        (
            ToolCallRequest(
                tool_id="write_file",
                arguments=dict(pairs),
                call_id=f"call-conflict-{reverse_order}",
            ),
        ),
        mode="assist",
        mode_allows_side_effecting=True,
        resolution_context=None,
        tool_contract=_Contract(descriptor),
    )

    assert result.allowed == ()
    assert len(result.denied) == 1
    assert result.denied[0].error_code == CMP_TOOL_COERCED_ARGS_REJECTED
    assert result.denied[0].metadata["hard_blocked"] is True


def test_blanket_auto_approve_skips_side_effecting_approval() -> None:
    """Blanket ON: side-effecting calls run without an approval round-trip."""
    descriptor = _write_file_descriptor()
    kernel = SimpleNamespace(
        _config=RuntimeConfig(
            safety_mode="normal", tool_policy_snapshot=_blanket_snapshot()
        ),
        _is_direct_deferred_tool_call=lambda call, context: False,
        _mcp_client=SimpleNamespace(tool_descriptor=lambda name: descriptor),
    )
    call = ToolCallRequest(
        tool_id="write_file",
        arguments={"path": "notes.md"},
        call_id="call-write-blanket",
    )
    policy_filter = filter_tool_calls_by_policy(
        kernel,
        (call,),
        mode="assist",
        mode_allows_side_effecting=True,
        resolution_context=None,
        tool_contract=_Contract(descriptor),
    )

    approval = approval_if_needed(
        kernel,
        policy_filter.allowed,
        mode="assist",
        mode_allows_side_effecting=True,
        require_approval=True,
        approvals_pre_granted=False,
        resolution_context=None,
        tool_contract=_Contract(descriptor),
        policy_decisions_by_call=policy_filter.decisions_by_call,
    )

    assert approval is None


def test_paranoid_safety_mode_overrides_blanket_auto_approve() -> None:
    """Paranoid mode still prompts even with blanket auto-approve ON."""
    descriptor = _write_file_descriptor()
    kernel = SimpleNamespace(
        _config=RuntimeConfig(
            safety_mode="paranoid", tool_policy_snapshot=_blanket_snapshot()
        ),
        _is_direct_deferred_tool_call=lambda call, context: False,
        _mcp_client=SimpleNamespace(tool_descriptor=lambda name: descriptor),
    )
    call = ToolCallRequest(
        tool_id="write_file",
        arguments={"path": "notes.md"},
        call_id="call-write-paranoid",
    )
    policy_filter = filter_tool_calls_by_policy(
        kernel,
        (call,),
        mode="assist",
        mode_allows_side_effecting=True,
        resolution_context=None,
        tool_contract=_Contract(descriptor),
    )

    approval = approval_if_needed(
        kernel,
        policy_filter.allowed,
        mode="assist",
        mode_allows_side_effecting=True,
        require_approval=True,
        approvals_pre_granted=False,
        resolution_context=None,
        tool_contract=_Contract(descriptor),
        policy_decisions_by_call=policy_filter.decisions_by_call,
    )

    assert approval is not None
    assert approval.tool_name == "write_file"


def test_one_send_auto_run_skips_ordinary_write_approval() -> None:
    descriptor = _write_file_descriptor()
    kernel = SimpleNamespace(
        _config=RuntimeConfig(safety_mode="normal"),
        _is_direct_deferred_tool_call=lambda call, context: False,
        _mcp_client=SimpleNamespace(tool_descriptor=lambda name: descriptor),
    )
    approval = approval_if_needed(
        kernel,
        (ToolCallRequest(tool_id="write_file", arguments={"path": "notes.md"}, call_id="auto-run"),),
        mode="assist",
        mode_allows_side_effecting=True,
        require_approval=True,
        approvals_pre_granted=False,
        resolution_context=None,
        tool_contract=_Contract(descriptor),
        approval_mode="auto_run",
    )
    assert approval is None


def _auto_run_approval(
    *, cap: int, state: turn_state.LiveRunModeState | None
) -> object | None:
    descriptor = _write_file_descriptor()
    kernel = SimpleNamespace(
        _config=RuntimeConfig(safety_mode="normal", auto_approve_streak_cap=cap),
        _is_direct_deferred_tool_call=lambda call, context: False,
        _mcp_client=SimpleNamespace(tool_descriptor=lambda name: descriptor),
    )
    call = ToolCallRequest(
        tool_id="write_file",
        arguments={"path": "notes.md"},
        call_id="auto-run-streak",
    )
    if state is None:
        return approval_if_needed(
            kernel,
            (call,),
            mode="assist",
            mode_allows_side_effecting=True,
            require_approval=True,
            approvals_pre_granted=False,
            resolution_context=None,
            tool_contract=_Contract(descriptor),
            approval_mode="auto_run",
        )
    with turn_state.bind_live_run_mode_state(state):
        return approval_if_needed(
            kernel,
            (call,),
            mode="assist",
            mode_allows_side_effecting=True,
            require_approval=True,
            approvals_pre_granted=False,
            resolution_context=None,
            tool_contract=_Contract(descriptor),
            approval_mode="auto_run",
        )


def test_auto_run_streak_cap_requests_one_off_approval() -> None:
    state = turn_state.LiveRunModeState(approval_mode="auto_run", auto_approvals=2)

    approval = _auto_run_approval(cap=2, state=state)

    assert approval is not None
    assert approval.reason == (
        "2 consecutive automatic approvals in this turn. Approve to continue."
    )
    assert approval.policy_decision_id is None
    assert approval.one_off_only is True
    assert approval.to_payload()["one_off_only"] is True
    assert state.auto_approvals == 2


def test_auto_run_below_streak_cap_records_approval() -> None:
    state = turn_state.LiveRunModeState(approval_mode="auto_run", auto_approvals=1)

    assert _auto_run_approval(cap=2, state=state) is None
    assert state.auto_approvals == 2


def test_auto_run_zero_streak_cap_never_prompts() -> None:
    state = turn_state.LiveRunModeState(approval_mode="auto_run", auto_approvals=500)

    assert _auto_run_approval(cap=0, state=state) is None
    assert state.auto_approvals == 501


def test_auto_run_streak_cap_is_ignored_without_live_state() -> None:
    assert _auto_run_approval(cap=1, state=None) is None


def test_policy_auto_approval_records_the_turn_streak() -> None:
    descriptor = _write_file_descriptor()
    kernel = SimpleNamespace(
        _config=RuntimeConfig(tool_policy_snapshot=_blanket_snapshot()),
        _is_direct_deferred_tool_call=lambda call, context: False,
        _mcp_client=SimpleNamespace(tool_descriptor=lambda name: descriptor),
    )
    call = ToolCallRequest(
        tool_id="write_file", arguments={"path": "notes.md"}, call_id="policy-auto"
    )
    policy_filter = filter_tool_calls_by_policy(
        kernel,
        (call,),
        mode="assist",
        mode_allows_side_effecting=True,
        resolution_context=None,
        tool_contract=_Contract(descriptor),
    )
    state = turn_state.LiveRunModeState()

    with turn_state.bind_live_run_mode_state(state):
        approval = approval_if_needed(
            kernel,
            policy_filter.allowed,
            mode="assist",
            mode_allows_side_effecting=True,
            require_approval=True,
            approvals_pre_granted=False,
            resolution_context=None,
            tool_contract=_Contract(descriptor),
            policy_decisions_by_call=policy_filter.decisions_by_call,
        )

    assert approval is None
    assert state.auto_approvals == 1


def test_unattended_pause_prompts_for_pregranted_policy_auto_call() -> None:
    descriptor = _write_file_descriptor()
    kernel = SimpleNamespace(
        _config=RuntimeConfig(tool_policy_snapshot=_blanket_snapshot()),
        _is_direct_deferred_tool_call=lambda call, context: False,
        _mcp_client=SimpleNamespace(tool_descriptor=lambda name: descriptor),
    )
    call = ToolCallRequest(
        tool_id="write_file", arguments={"path": "notes.md"}, call_id="paused-auto"
    )
    policy_filter = filter_tool_calls_by_policy(
        kernel,
        (call,),
        mode="assist",
        mode_allows_side_effecting=True,
        resolution_context=None,
        tool_contract=_Contract(descriptor),
    )
    state = turn_state.LiveRunModeState(
        approval_mode="prompt", paused_unattended=True
    )

    with turn_state.bind_live_run_mode_state(state):
        approval = approval_if_needed(
            kernel,
            policy_filter.allowed,
            mode="assist",
            mode_allows_side_effecting=True,
            require_approval=True,
            approvals_pre_granted=True,
            resolution_context=None,
            tool_contract=_Contract(descriptor),
            policy_decisions_by_call=policy_filter.decisions_by_call,
            approval_mode="auto_run",
        )

    assert approval is not None
    assert approval.reason == "The model requested a side-effecting MCP tool call."


def test_live_run_mode_auto_approval_streak_resets() -> None:
    state = turn_state.LiveRunModeState(auto_approvals=4)

    state.reset_auto_approvals()

    assert state.auto_approvals == 0


def test_live_run_mode_updates_apply_to_the_next_approval_scan() -> None:
    descriptor = _write_file_descriptor()
    kernel = SimpleNamespace(
        _config=RuntimeConfig(safety_mode="normal"),
        _is_direct_deferred_tool_call=lambda call, context: False,
        _mcp_client=SimpleNamespace(tool_descriptor=lambda name: descriptor),
    )
    call = ToolCallRequest(
        tool_id="write_file",
        arguments={"path": "notes.md"},
        call_id="live-mode",
    )
    state = turn_state.LiveRunModeState(approval_mode="prompt", read_only=False)

    with turn_state.bind_live_run_mode_state(state):
        raised = approval_if_needed(
            kernel,
            (call,),
            mode="assist",
            mode_allows_side_effecting=True,
            require_approval=True,
            approvals_pre_granted=False,
            resolution_context=None,
            tool_contract=_Contract(descriptor),
            approval_mode="prompt",
        )
        state.update(approval_mode="auto_run", read_only=False)
        auto_result = approval_if_needed(
            kernel,
            (call,),
            mode="assist",
            mode_allows_side_effecting=True,
            require_approval=True,
            approvals_pre_granted=False,
            resolution_context=None,
            tool_contract=_Contract(descriptor),
            approval_mode="prompt",
        )
        state.update(approval_mode="prompt", read_only=False)
        ask_result = approval_if_needed(
            kernel,
            (call,),
            mode="assist",
            mode_allows_side_effecting=True,
            require_approval=True,
            approvals_pre_granted=False,
            resolution_context=None,
            tool_contract=_Contract(descriptor),
            approval_mode="auto_run",
        )

    assert raised is not None
    assert raised.tool_call_id == "live-mode"
    assert auto_result is None
    assert ask_result is not None


def test_plan_mode_only_ask_precedes_auto_run() -> None:
    descriptor = SimpleNamespace(
        name="exit_plan_mode",
        side_effecting=False,
        input_schema={"type": "object", "properties": {}},
        source_kind="builtin",
        tool_family="planning",
        availability=SimpleNamespace(plan_mode_only=True),
    )
    snapshot = ToolPolicySnapshot(
        version=2,
        rules=(
            ToolPolicyRule(
                id="ask-plan-exit",
                decision="ask",
                reason="Plan exit requires approval",
                match=ToolPolicyRuleMatch(tool_id="exit_plan_mode"),
            ),
        ),
    )
    kernel = SimpleNamespace(
        _config=RuntimeConfig(safety_mode="normal", tool_policy_snapshot=snapshot),
        _is_direct_deferred_tool_call=lambda call, context: False,
        _mcp_client=SimpleNamespace(tool_descriptor=lambda name: descriptor),
    )
    call = ToolCallRequest(
        tool_id="exit_plan_mode",
        arguments={"title": "Build", "steps": ["Implement"]},
        call_id="plan-exit",
    )
    contract = _Contract(descriptor)
    policy_filter = filter_tool_calls_by_policy(
        kernel,
        (call,),
        mode="assist",
        mode_allows_side_effecting=True,
        resolution_context=None,
        tool_contract=contract,
        read_only=True,
    )
    approval = approval_if_needed(
        kernel,
        policy_filter.allowed,
        mode="assist",
        mode_allows_side_effecting=True,
        require_approval=True,
        approvals_pre_granted=False,
        resolution_context=None,
        tool_contract=contract,
        read_only=True,
        policy_decisions_by_call=policy_filter.decisions_by_call,
        approval_mode="auto_run",
    )

    assert approval is not None
    assert approval.tool_name == "exit_plan_mode"


def test_pre_granted_shell_call_skips_needs_approval_prompt(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    descriptor = SimpleNamespace(
        name="run_command",
        side_effecting=True,
        input_schema={"type": "object", "properties": {}},
        source_kind="mcp",
        tool_family="shell",
        server_name="tools",
    )
    kernel = SimpleNamespace(
        _config=RuntimeConfig(
            tools_shell_enabled=True,
            tools_confirm_side_effects=True,
            feature_flags={"shell_security": True},
            safety_mode="normal",
        ),
        _is_direct_deferred_tool_call=lambda call, context: False,
        _mcp_client=SimpleNamespace(tool_descriptor=lambda name: descriptor),
    )
    monkeypatch.setattr(
        tool_execution,
        "classify_command",
        lambda command, *, powershell=False: ClassificationResult(
            verdict=CommandVerdict.NEEDS_APPROVAL,
            reason="needs approval",
            executable="cmd",
            raw_command=command,
        ),
    )

    approval = approval_if_needed(
        kernel,
        (ToolCallRequest(tool_id="run_command", arguments={"command": "example"}),),
        mode="assist",
        mode_allows_side_effecting=True,
        require_approval=True,
        approvals_pre_granted=True,
        resolution_context=None,
        tool_contract=_Contract(descriptor),
    )

    assert approval is None


def _auto_run_shell_approval(command: str, *, strict: bool) -> object | None:
    descriptor = SimpleNamespace(
        name="run_command",
        side_effecting=True,
        input_schema={"type": "object", "properties": {}},
        source_kind="mcp",
        tool_family="shell",
        server_name="tools",
    )
    kernel = SimpleNamespace(
        _config=RuntimeConfig(
            tools_shell_enabled=True,
            tools_confirm_side_effects=True,
            feature_flags={"shell_security": True, "strict_auto_run": strict},
            safety_mode="normal",
        ),
        _is_direct_deferred_tool_call=lambda call, context: False,
        _mcp_client=SimpleNamespace(tool_descriptor=lambda name: descriptor),
    )
    return approval_if_needed(
        kernel,
        (
            ToolCallRequest(
                tool_id="run_command",
                arguments={"command": command},
                call_id="shell-auto-run",
            ),
        ),
        mode="assist",
        mode_allows_side_effecting=True,
        require_approval=True,
        approvals_pre_granted=False,
        resolution_context=None,
        tool_contract=_Contract(descriptor),
        approval_mode="auto_run",
    )


def test_strict_auto_run_does_not_run_append_redirect_unattended() -> None:
    approval = _auto_run_shell_approval("echo harmless >> audit.txt", strict=True)
    assert approval is not None
    assert "output overwrite redirect" in approval.reason


def test_auto_run_always_asks_for_destructive_start_wrapper() -> None:
    approval = _auto_run_shell_approval(
        'start "" /b cmd /c "del audit.txt"',
        strict=False,
    )
    assert approval is not None
    assert "(del)" in approval.reason


def test_python_approval_is_mandatory_during_one_send_auto_run() -> None:
    descriptor = SimpleNamespace(
        name="python_execute",
        side_effecting=True,
        input_schema={"type": "object", "properties": {"code": {"type": "string"}}},
        source_kind="builtin",
        tool_family="python",
    )
    kernel = SimpleNamespace(
        _config=RuntimeConfig(safety_mode="normal"),
        _is_direct_deferred_tool_call=lambda call, context: False,
        _mcp_client=SimpleNamespace(tool_descriptor=lambda name: descriptor),
    )
    approval = approval_if_needed(
        kernel,
        (ToolCallRequest(tool_id="python_execute", arguments={"code": "print(1)"}, call_id="python"),),
        mode="assist",
        mode_allows_side_effecting=True,
        require_approval=True,
        approvals_pre_granted=False,
        resolution_context=None,
        tool_contract=_Contract(descriptor),
        approval_mode="auto_run",
    )
    assert approval is not None
    assert "always requires approval" in approval.reason.lower()


def test_policy_ask_forces_approval_without_provider_call_id() -> None:
    descriptor = SimpleNamespace(
        name="read_file",
        side_effecting=False,
        input_schema={"type": "object", "properties": {"path": {"type": "string"}}},
        source_kind="mcp",
        tool_family="filesystem",
        server_name="tools",
    )
    snapshot = ToolPolicySnapshot(
        version=2,
        rules=(
            ToolPolicyRule(
                id="ask-reads",
                decision="ask",
                reason="Review all file reads",
                match=ToolPolicyRuleMatch(tool_id="read_file"),
            ),
        ),
    )
    kernel = SimpleNamespace(
        _config=RuntimeConfig(safety_mode="normal", tool_policy_snapshot=snapshot),
        _is_direct_deferred_tool_call=lambda call, context: False,
        _mcp_client=SimpleNamespace(tool_descriptor=lambda name: descriptor),
    )
    call = ToolCallRequest(
        tool_id="read_file",
        arguments={"path": "README.md"},
    )
    policy_filter = filter_tool_calls_by_policy(
        kernel,
        (call,),
        mode="assist",
        mode_allows_side_effecting=True,
        resolution_context=None,
        tool_contract=_Contract(descriptor),
    )

    approval = approval_if_needed(
        kernel,
        policy_filter.allowed,
        mode="assist",
        mode_allows_side_effecting=True,
        require_approval=True,
        approvals_pre_granted=False,
        resolution_context=None,
        tool_contract=_Contract(descriptor),
        policy_decisions_by_call=policy_filter.decisions_by_call,
    )

    assert approval is not None
    assert approval.tool_name == "read_file"
    assert approval.tool_call_id == tool_policy_call_key(call)
    assert approval.policy_decision_id is not None


def test_policy_auto_skips_default_side_effect_approval() -> None:
    descriptor = SimpleNamespace(
        name="write_file",
        side_effecting=True,
        input_schema={"type": "object", "properties": {"path": {"type": "string"}}},
        source_kind="mcp",
        tool_family="filesystem",
        server_name="tools",
    )
    snapshot = ToolPolicySnapshot(
        version=2,
        legacy_policies=(("write_file", "auto"),),
    )
    kernel = SimpleNamespace(
        _config=RuntimeConfig(safety_mode="normal", tool_policy_snapshot=snapshot),
        _is_direct_deferred_tool_call=lambda call, context: False,
        _mcp_client=SimpleNamespace(tool_descriptor=lambda name: descriptor),
    )
    call = ToolCallRequest(
        tool_id="write_file",
        arguments={"path": "notes.md", "content": "hello"},
        call_id="call-write-policy-auto",
    )
    policy_filter = filter_tool_calls_by_policy(
        kernel,
        (call,),
        mode="assist",
        mode_allows_side_effecting=True,
        resolution_context=None,
        tool_contract=_Contract(descriptor),
    )

    approval = approval_if_needed(
        kernel,
        policy_filter.allowed,
        mode="assist",
        mode_allows_side_effecting=True,
        require_approval=True,
        approvals_pre_granted=False,
        resolution_context=None,
        tool_contract=_Contract(descriptor),
        policy_decisions_by_call=policy_filter.decisions_by_call,
    )

    assert approval is None
    assert policy_filter.audit_metadata_by_call["call-write-policy-auto"]["policy_decision"][
        "decision"
    ] == "auto"


def _plan_artifact_descriptor() -> SimpleNamespace:
    return SimpleNamespace(
        name="create_artifact",
        side_effecting=True,
        read_only=False,
        input_schema={"type": "object", "properties": {}},
        source_kind="builtin",
        tool_family="artifact",
        server_name="tools",
        availability=SimpleNamespace(plan_mode_artifact_write=True),
    )


def _plan_artifact_call() -> ToolCallRequest:
    return ToolCallRequest(
        tool_id="create_artifact",
        call_id="call-plan-artifact",
        arguments={
            "artifact_kind": "document",
            "title": "Plan",
            "content": "# Plan",
            "language": "markdown",
            "extension": ".md",
        },
    )


def test_bounded_plan_artifact_converts_only_builtin_default_ask_to_auto() -> None:
    descriptor = _plan_artifact_descriptor()
    kernel = SimpleNamespace(
        _config=RuntimeConfig(safety_mode="normal"),
        _is_direct_deferred_tool_call=lambda call, context: False,
        _mcp_client=SimpleNamespace(tool_descriptor=lambda name: descriptor),
    )
    policy_filter = filter_tool_calls_by_policy(
        kernel,
        (_plan_artifact_call(),),
        mode="assist",
        mode_allows_side_effecting=False,
        resolution_context=None,
        tool_contract=_Contract(descriptor),
        plan_mode=True,
        read_only=True,
    )

    decision = policy_filter.decisions_by_call["call-plan-artifact"]
    assert decision.decision == "auto"
    # Inert documents default to auto in every mode since 2026-09-22, so the
    # built-in default no longer needs the Plan Mode conversion.
    assert decision.stage == "tool_default"
    assert approval_if_needed(
        kernel,
        policy_filter.allowed,
        mode="assist",
        mode_allows_side_effecting=False,
        require_approval=True,
        approvals_pre_granted=False,
        resolution_context=None,
        tool_contract=_Contract(descriptor),
        plan_mode=True,
        read_only=True,
        policy_decisions_by_call=policy_filter.decisions_by_call,
    ) is None


def test_explicit_ask_and_paranoid_mode_still_gate_plan_artifacts() -> None:
    descriptor = _plan_artifact_descriptor()
    snapshot = ToolPolicySnapshot(
        version=2,
        rules=(
            ToolPolicyRule(
                id="ask-plan-artifacts",
                decision="ask",
                reason="Review plan artifacts",
                match=ToolPolicyRuleMatch(tool_id="create_artifact"),
            ),
        ),
    )
    kernel = SimpleNamespace(
        _config=RuntimeConfig(safety_mode="paranoid", tool_policy_snapshot=snapshot),
        _is_direct_deferred_tool_call=lambda call, context: False,
        _mcp_client=SimpleNamespace(tool_descriptor=lambda name: descriptor),
    )
    policy_filter = filter_tool_calls_by_policy(
        kernel,
        (_plan_artifact_call(),),
        mode="assist",
        mode_allows_side_effecting=False,
        resolution_context=None,
        tool_contract=_Contract(descriptor),
        plan_mode=True,
        read_only=True,
    )

    decision = policy_filter.decisions_by_call["call-plan-artifact"]
    assert decision.decision == "ask"
    assert decision.matched_rule_id == "ask-plan-artifacts"
    approval = approval_if_needed(
        kernel,
        policy_filter.allowed,
        mode="assist",
        mode_allows_side_effecting=False,
        require_approval=True,
        approvals_pre_granted=False,
        resolution_context=None,
        tool_contract=_Contract(descriptor),
        plan_mode=True,
        read_only=True,
        policy_decisions_by_call=policy_filter.decisions_by_call,
    )
    assert approval is not None


def test_explicit_policy_deny_disables_automatic_plan_artifact_write() -> None:
    descriptor = _plan_artifact_descriptor()
    snapshot = ToolPolicySnapshot(
        version=2,
        rules=(
            ToolPolicyRule(
                id="deny-plan-artifacts",
                decision="deny",
                reason="Plan artifacts disabled",
                match=ToolPolicyRuleMatch(tool_id="create_artifact"),
            ),
        ),
    )
    kernel = SimpleNamespace(
        _config=RuntimeConfig(safety_mode="normal", tool_policy_snapshot=snapshot),
        _is_direct_deferred_tool_call=lambda call, context: False,
        _mcp_client=SimpleNamespace(tool_descriptor=lambda name: descriptor),
    )

    policy_filter = filter_tool_calls_by_policy(
        kernel,
        (_plan_artifact_call(),),
        mode="assist",
        mode_allows_side_effecting=False,
        resolution_context=None,
        tool_contract=_Contract(descriptor),
        plan_mode=True,
        read_only=True,
    )

    assert policy_filter.allowed == ()
    assert policy_filter.denied[0].error_code == CMP_TOOL_POLICY_DENIED
    assert policy_filter.decisions_by_call["call-plan-artifact"].decision == "deny"
