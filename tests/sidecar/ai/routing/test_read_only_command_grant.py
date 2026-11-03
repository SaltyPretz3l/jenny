"""Row 102: read-only run_command calls run without asking, in Ask, Plan and Propose.

The sidecar half of the rule: flag + builtin ``run_command`` + classifier ALLOWED for the
request root.  The policy half (user rules, paranoid) is checked at the approval gate; the
``grant`` key on the runtime.operation check is Electron's input for the same decision.
"""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from sidecar.ai.config import (
    RuntimeConfig,
    ToolPolicyRule,
    ToolPolicyRuleMatch,
    ToolPolicySnapshot,
)
from sidecar.ai.context.prompt_modes import (
    PLAN_MODE_GUIDANCE,
    PROPOSE_MODE_GUIDANCE,
    READ_ONLY_COMMANDS_PROMPT_LINE,
    append_mode_runtime_overlays,
    build_plan_mode_overlay,
    build_propose_mode_overlay,
)
from sidecar.ai.error_codes import CMP_MODE_TOOL_BLOCKED
from sidecar.ai.execution_policy import (
    BUILTIN_MCP_SERVER_NAME,
    ELECTRON_TOOL_BRIDGE_SERVER_NAME,
)
from sidecar.ai.feature_flags import FEATURE_READ_ONLY_COMMANDS, read_only_commands_enabled
from sidecar.ai.mcp.exceptions import MCPError
from sidecar.ai.routing import tool_execution
from sidecar.ai.routing.loop_runtime import LoopRuntime
from sidecar.ai.routing.router import ToolExecutionOutcome
from sidecar.ai.routing.tool_authority import admit_scoped_tool_call
from sidecar.ai.routing.tool_call_execution import pre_filter_tool_calls
from sidecar.ai.routing.tool_execution import approval_if_needed, filter_tool_calls_by_policy
from sidecar.ai.tools.assembly import (
    READ_ONLY_UNAVAILABLE_REASON,
    ToolAssemblyContext,
    assemble_tool_contract,
)
from sidecar.ai.tools.builtins.shell_security import ClassificationResult, CommandVerdict
from sidecar.ai.tools.catalog import (
    MANAGED_SIDECAR_SURFACE,
    CanonicalToolAvailability,
    CanonicalToolDescriptor,
)
from sidecar.ai.tools.models import ToolCallRequest
from sidecar.ai.tools.policy import ToolPolicyDecision
from sidecar.ai.tools.read_only_command_grant import (
    READ_ONLY_COMMAND_GRANT,
    READ_ONLY_COMMAND_REFUSAL,
    approval_grant_applies,
    is_read_only_command,
)
from sidecar.runtime.execution_context import execution_context_from_params
from sidecar.runtime.operation_admission import (
    RuntimeOperationRequest,
    admit_runtime_operation,
    build_operation_admission_callback,
)

# --------------------------------------------------------------------------- helpers


class _Contract:
    def __init__(self, descriptor: object) -> None:
        self._descriptor = descriptor

    def entry(self, tool_name: str) -> object | None:
        if tool_name != getattr(self._descriptor, "name", ""):
            return None
        return SimpleNamespace(
            available=True, descriptor=self._descriptor, reason=None, deferred=False
        )


def _descriptor(server_name: str = BUILTIN_MCP_SERVER_NAME) -> SimpleNamespace:
    return SimpleNamespace(
        name="run_command",
        side_effecting=True,
        read_only=False,
        input_schema={"type": "object", "properties": {}},
        source_kind="builtin",
        tool_family="shell",
        server_name=server_name,
    )


def _kernel(  # noqa: PLR0913
    descriptor: SimpleNamespace,
    *,
    flags: dict[str, bool] | None = None,
    safety_mode: str = "normal",
    snapshot: ToolPolicySnapshot | None = None,
    host_mode: str = "desktop",
    shell_enabled: bool = True,
) -> SimpleNamespace:
    config = RuntimeConfig(
        tools_shell_enabled=shell_enabled,
        tools_confirm_side_effects=True,
        feature_flags={"shell_security": True, **(flags or {})},
        safety_mode=safety_mode,
        host_mode=host_mode,
        tool_policy_snapshot=snapshot,
    )
    return SimpleNamespace(
        _config=config,
        _is_direct_deferred_tool_call=lambda call, context: False,
        _mcp_client=SimpleNamespace(tool_descriptor=lambda name: descriptor),
    )


def _gate(  # noqa: PLR0913
    command: str,
    root: Path,
    *,
    server_name: str = BUILTIN_MCP_SERVER_NAME,
    approval_mode: str = "prompt",
    read_only: bool = False,
    plan_mode: bool = False,
    **kernel_options: Any,
) -> object | None:
    descriptor = _descriptor(server_name)
    kernel = _kernel(descriptor, **kernel_options)
    call = ToolCallRequest(
        tool_id="run_command", arguments={"command": command}, call_id="call-ro-1"
    )
    contract = _Contract(descriptor)
    common: dict[str, Any] = {
        "mode": "assist",
        "mode_allows_side_effecting": True,
        "resolution_context": None,
        "tool_contract": contract,
        "plan_mode": plan_mode,
        "read_only": read_only,
    }
    policy_filter = filter_tool_calls_by_policy(kernel, (call,), **common)
    return approval_if_needed(
        kernel,
        (call,),
        require_approval=True,
        approvals_pre_granted=False,
        policy_decisions_by_call=policy_filter.decisions_by_call,
        approval_mode=approval_mode,
        execution_context=SimpleNamespace(root_path=str(root)),
        **common,
    )


def _ask_rule(tool_id: str = "run_command") -> ToolPolicySnapshot:
    return ToolPolicySnapshot(
        version=3,
        rules=(
            ToolPolicyRule(
                id="user-ask-shell",
                decision="ask",
                reason="Review every command",
                match=ToolPolicyRuleMatch(tool_id=tool_id),
            ),
        ),
    )


@pytest.fixture
def root(tmp_path: Path) -> Path:
    workspace = tmp_path / "workspace"
    (workspace / "src").mkdir(parents=True)
    (tmp_path / "secret.txt").write_text("secret", encoding="utf-8")
    return workspace


# --------------------------------------------------------------- 1. Ask-mode approval gate


@pytest.mark.parametrize("command", ["git log -5", "rg foo src", "git diff --stat"])
def test_ask_mode_read_only_command_needs_no_approval(command: str, root: Path) -> None:
    assert _gate(command, root) is None


@pytest.mark.parametrize(
    "command",
    ["sed -i s/a/b/ x.txt", "cat ../secret.txt", "npm test", "python -c 1"],
)
def test_ask_mode_non_read_only_command_still_asks(command: str, root: Path) -> None:
    approval = _gate(command, root)
    assert approval is not None
    assert approval.tool_name == "run_command"


def test_user_ask_rule_still_asks_for_a_read_only_command(root: Path) -> None:
    assert _gate("git log -5", root, snapshot=_ask_rule()) is not None


def test_paranoid_safety_mode_still_asks_for_a_read_only_command(root: Path) -> None:
    assert _gate("git log -5", root, safety_mode="paranoid") is not None


def test_flag_off_keeps_todays_approval(root: Path) -> None:
    assert _gate("git log -5", root, flags={FEATURE_READ_ONLY_COMMANDS: False}) is not None
    # Absent means on.
    assert _gate("git log -5", root, flags={}) is None


def test_hosted_and_bridge_run_command_never_qualify(root: Path) -> None:
    assert _gate("git log -5", root, host_mode="server") is not None
    assert (
        _gate("git log -5", root, server_name=ELECTRON_TOOL_BRIDGE_SERVER_NAME) is not None
    )


def test_a_command_with_no_bound_root_still_asks(root: Path) -> None:
    descriptor = _descriptor()
    kernel = _kernel(descriptor)
    call = ToolCallRequest(
        tool_id="run_command", arguments={"command": "cat ../secret.txt"}, call_id="c"
    )
    approval = approval_if_needed(
        kernel,
        (call,),
        mode="assist",
        mode_allows_side_effecting=True,
        require_approval=True,
        approvals_pre_granted=False,
        resolution_context=None,
        tool_contract=_Contract(descriptor),
        execution_context=SimpleNamespace(root_path=None),
    )
    assert approval is not None


def test_a_read_only_command_in_auto_keeps_the_auto_run_path(root: Path) -> None:
    assert _gate("git log -5", root, approval_mode="auto_run") is None


# ------------------------------------------------------------------ helper unit contract


def _decision(decision: str, *, stage: str, rule: str | None) -> ToolPolicyDecision:
    return ToolPolicyDecision(
        decision=decision,
        stage=stage,
        matched_rule_id=rule,
        reason="r",
        snapshot_version=1,
        tool_name="run_command",
        tool_family="shell",
        source_kind="builtin",
        mode="assist",
    )


def test_approval_grant_applies_only_for_the_tool_default_or_auto() -> None:
    assert approval_grant_applies(None, paranoid=False)
    assert approval_grant_applies(_decision("auto", stage="rule", rule="r1"), paranoid=False)
    assert approval_grant_applies(
        _decision("ask", stage="tool_default", rule=None), paranoid=False
    )
    assert not approval_grant_applies(
        _decision("ask", stage="tool_default", rule=None), paranoid=True
    )
    assert not approval_grant_applies(
        _decision("ask", stage="rule", rule="user-ask"), paranoid=False
    )
    assert not approval_grant_applies(
        _decision("ask", stage="tool_default", rule="r"), paranoid=False
    )
    assert not approval_grant_applies(
        _decision("deny", stage="hard_safety_deny", rule=None), paranoid=False
    )


def _allowed() -> ClassificationResult:
    return ClassificationResult(CommandVerdict.ALLOWED, "ok", "git", "git log")


def test_is_read_only_command_needs_flag_tool_server_and_an_allowed_verdict() -> None:
    config = RuntimeConfig(tools_shell_enabled=True)
    assert is_read_only_command(config, _descriptor(), _allowed())
    needs = ClassificationResult(CommandVerdict.NEEDS_APPROVAL, "x", "npm", "npm test")
    assert not is_read_only_command(config, _descriptor(), needs)
    assert not is_read_only_command(config, _descriptor(), None)
    assert not is_read_only_command(config, None, _allowed())
    other = _descriptor()
    other.name = "run_temp_script"
    assert not is_read_only_command(config, other, _allowed())
    assert not is_read_only_command(
        config, _descriptor(ELECTRON_TOOL_BRIDGE_SERVER_NAME), _allowed()
    )
    off = RuntimeConfig(tools_shell_enabled=True, feature_flags={FEATURE_READ_ONLY_COMMANDS: False})
    assert not is_read_only_command(off, _descriptor(), _allowed())


def test_read_only_commands_enabled_reads_flag_shell_and_host_mode() -> None:
    assert read_only_commands_enabled(RuntimeConfig(tools_shell_enabled=True))
    assert read_only_commands_enabled({"tools_shell_enabled": True, "feature_flags": {}})
    assert not read_only_commands_enabled(RuntimeConfig(tools_shell_enabled=False))
    assert not read_only_commands_enabled(
        RuntimeConfig(tools_shell_enabled=True, feature_flags={FEATURE_READ_ONLY_COMMANDS: False})
    )
    assert not read_only_commands_enabled(
        RuntimeConfig(tools_shell_enabled=True, host_mode="server")
    )


# ---------------------------------------------------- 2. Plan and Propose listing + dispatch


def _contract_for(
    *, plan_mode: bool, propose_mode: bool, flags: dict[str, bool] | None = None
) -> Any:
    descriptor = CanonicalToolDescriptor(
        name="run_command",
        description="run",
        input_schema={"type": "object", "properties": {"command": {"type": "string"}}},
        side_effecting=True,
        read_only=False,
        tool_family="shell",
        availability=CanonicalToolAvailability(config_flag="tools_shell_enabled"),
        runtime_registered=True,
        server_name=BUILTIN_MCP_SERVER_NAME,
    )
    config = RuntimeConfig(tools_shell_enabled=True, feature_flags=flags or {})
    return assemble_tool_contract(
        (descriptor,),
        ToolAssemblyContext(
            surface=MANAGED_SIDECAR_SURFACE,
            config=config,
            mode="assist",
            plan_mode=plan_mode,
            propose_mode=propose_mode,
            read_only=True,
            workspace_root_present=True,
        ),
    )


@pytest.mark.parametrize(
    ("plan_mode", "propose_mode"), [(True, False), (False, True)], ids=["plan", "propose"]
)
def test_run_command_is_listed_in_read_only_contexts(plan_mode: bool, propose_mode: bool) -> None:
    entry = _contract_for(plan_mode=plan_mode, propose_mode=propose_mode).entry("run_command")
    assert entry is not None and entry.available is True


@pytest.mark.parametrize(
    ("plan_mode", "propose_mode"), [(True, False), (False, True)], ids=["plan", "propose"]
)
def test_flag_off_leaves_run_command_unlisted_as_before(
    plan_mode: bool, propose_mode: bool
) -> None:
    contract = _contract_for(
        plan_mode=plan_mode, propose_mode=propose_mode,
        flags={FEATURE_READ_ONLY_COMMANDS: False},
    )
    entry = contract.entry("run_command")
    assert entry is not None and entry.available is False
    assert entry.reason == READ_ONLY_UNAVAILABLE_REASON


def _prefilter(
    command: str, root: Path, *, flags: dict[str, bool] | None = None,
    plan_mode: bool = True, server_name: str = BUILTIN_MCP_SERVER_NAME,
) -> tuple[list[Any], list[ToolExecutionOutcome]]:
    descriptor = _descriptor(server_name)
    kernel = _kernel(descriptor, flags=flags)
    kernel._assert_valid_tool_call = lambda call: None
    kernel._assistant_tool_call_message = lambda result, call: {"role": "assistant"}
    kernel._tool_result_message = lambda call, outcome: {"role": "tool"}
    call = ToolCallRequest(
        tool_id="run_command", arguments={"command": command}, call_id="call-ro-pre"
    )
    runtime = LoopRuntime(
        request_id="req-1", session_id="session-1", streaming=True, tool_call_limit=20,
        request_context=SimpleNamespace(execution_context=SimpleNamespace(root_path=str(root))),
    )
    outcomes: list[ToolExecutionOutcome] = []
    remaining, _ = pre_filter_tool_calls(
        [call],
        kernel=kernel,
        runtime=runtime,
        result=SimpleNamespace(),
        request_id="req-1",
        session_id="session-1",
        tool_resolution_context=None,
        tool_contract=_Contract(descriptor),
        plan_mode=plan_mode,
        read_only=True,
        outcomes=outcomes,
        working_messages=[],
        iteration_calls=[],
        streamed_event_types=set(),
        outcome_index=0,
    )
    return remaining, outcomes


@pytest.mark.parametrize("plan_mode", [True, False], ids=["plan", "propose"])
def test_read_only_command_passes_the_read_only_dispatch_check(
    plan_mode: bool, root: Path
) -> None:
    remaining, outcomes = _prefilter("rg foo", root, plan_mode=plan_mode)
    assert len(remaining) == 1 and outcomes == []


@pytest.mark.parametrize("plan_mode", [True, False], ids=["plan", "propose"])
def test_other_commands_are_refused_with_the_read_only_commands_message(
    plan_mode: bool, root: Path
) -> None:
    for command in ("npm test", "cat ../secret.txt"):
        remaining, outcomes = _prefilter(command, root, plan_mode=plan_mode)
        assert remaining == []
        assert outcomes[0].error_code == CMP_MODE_TOOL_BLOCKED
        assert outcomes[0].output == READ_ONLY_COMMAND_REFUSAL
        assert outcomes[0].metadata["read_only_blocked"] is True


def test_flag_off_rejects_run_command_with_the_generic_read_only_message(root: Path) -> None:
    remaining, outcomes = _prefilter("rg foo", root, flags={FEATURE_READ_ONLY_COMMANDS: False})
    assert remaining == []
    assert outcomes[0].error_code == CMP_MODE_TOOL_BLOCKED
    assert outcomes[0].output == "Tool 'run_command' is unavailable because this request is read-only."


def test_bridge_run_command_is_still_rejected_in_read_only(root: Path) -> None:
    remaining, outcomes = _prefilter(
        "rg foo", root, server_name=ELECTRON_TOOL_BRIDGE_SERVER_NAME
    )
    assert remaining == []
    assert outcomes[0].error_code == CMP_MODE_TOOL_BLOCKED


# ------------------------------------------------------------ 3. runtime.operation payload


def _admission_context(root: Path) -> Any:
    context = execution_context_from_params({"execution_context": {
        "schema_version": 1, "authority_revision": "rev_1",
        "project_id": "project_alpha", "root_path": str(root.resolve()),
        "root_id": "root_1234567890abcdef12345678", "root_revision": 1,
        "device_id": None, "inode": None,
        "tool_policy_snapshot": {"version": 1}, "knowledge_roots": [],
    }})
    assert context is not None
    return context


def _admit(root: Path, grant: object = None, **extra: Any) -> dict[str, Any]:
    sent: list[dict[str, Any]] = []

    def reader_factory(rpc_id: int, **_kwargs: Any) -> Any:
        def read(_timeout: float) -> dict[str, Any]:
            return {"id": rpc_id, "result": {
                "schema_version": 1, "status": "granted", "operation_id": "call_7",
            }}
        return read

    admit_runtime_operation(RuntimeOperationRequest(
        request_id="request_1", session_id="session_1",
        execution_context=_admission_context(root), operation_id="call_7",
        tool_name="run_command", arguments={"command": "git log"},
        write_message=sent.append, response_reader_factory=reader_factory,
        **({"grant": grant} if grant is not None else {}), **extra,
    ))
    return sent[0]["params"]


def test_admission_payload_carries_the_grant_only_when_given(root: Path) -> None:
    assert _admit(root, READ_ONLY_COMMAND_GRANT)["grant"] == "read_only_command"
    assert "grant" not in _admit(root)


def test_admission_refuses_an_unknown_grant_before_sending(root: Path) -> None:
    sent: list[dict[str, Any]] = []
    with pytest.raises(MCPError):
        admit_runtime_operation(RuntimeOperationRequest(
            request_id="request_1", session_id="session_1",
            execution_context=_admission_context(root), operation_id="call_7",
            tool_name="run_command", arguments={}, grant="always_allow",
            write_message=sent.append,
            response_reader_factory=lambda rpc_id, **_kwargs: (lambda _t: {}),
        ))
    assert sent == []


def test_admission_callback_forwards_the_grant(root: Path) -> None:
    sent: list[dict[str, Any]] = []

    def reader_factory(rpc_id: int, **_kwargs: Any) -> Any:
        return lambda _t: {"id": rpc_id, "result": {
            "schema_version": 1, "status": "granted", "operation_id": "call_7",
        }}

    admit = build_operation_admission_callback(
        request_id="request_1", session_id="session_1",
        execution_context=_admission_context(root), write_message=sent.append,
        response_reader_factory=reader_factory, cancel_handle=None,
    )
    assert admit is not None
    admit(operation_id="call_7", tool_name="run_command", arguments={}, grant="read_only_command")
    admit(operation_id="call_7", tool_name="run_command", arguments={})
    assert sent[0]["params"]["grant"] == "read_only_command"
    assert "grant" not in sent[1]["params"]


def test_scoped_admission_forwards_a_grant_only_when_given() -> None:
    seen: list[dict[str, Any]] = []

    def admission(**kwargs: Any) -> dict[str, Any]:
        seen.append(kwargs)
        return {"schema_version": 1}

    runtime = SimpleNamespace(
        request_context=SimpleNamespace(execution_context=object()), operation_admission=admission
    )
    call = SimpleNamespace(call_id="call_7", tool_id="run_command")
    common: dict[str, Any] = {
        "runtime": runtime, "call": call, "descriptor": _descriptor(),
        "tool_arguments": {}, "visible_arguments": {"command": "git log"},
        "builtin_server_name": BUILTIN_MCP_SERVER_NAME, "timeout_seconds": None,
    }
    admit_scoped_tool_call(**common)
    admit_scoped_tool_call(**common, grant=READ_ONLY_COMMAND_GRANT)
    assert "grant" not in seen[0]
    assert seen[1]["grant"] == "read_only_command"


def _dispatch_grants(root: Path, command: str, tool_id: str = "run_command", **options: Any) -> list[Any]:
    """Run the real dispatch path and return the grant seen by the admission callback."""
    grants: list[Any] = []

    def admission(**kwargs: Any) -> dict[str, Any]:
        grants.append(kwargs.get("grant"))
        return {"schema_version": 1}

    admission.acquire_resource = lambda **_kwargs: SimpleNamespace(  # type: ignore[attr-defined]
        settle=lambda *_args, **_kwargs: None
    )
    descriptor = _descriptor(options.pop("server_name", BUILTIN_MCP_SERVER_NAME))
    descriptor.name = tool_id
    kernel = _kernel(descriptor, **options)
    kernel._mcp_client.execute_tool = lambda *_args, **_kwargs: SimpleNamespace(
        success=True, metadata={}
    )
    runtime = SimpleNamespace(
        request_context=SimpleNamespace(
            execution_context=SimpleNamespace(root_path=str(root)), handoff_preparation=None,
        ),
        operation_admission=admission, trace_id="trace",
    )
    arguments = {"command": command}
    tool_execution._dispatch_tool_call(
        kernel=kernel,
        call=ToolCallRequest(tool_id=tool_id, arguments=dict(arguments), call_id="call_7"),
        tool_arguments=dict(arguments), descriptor=descriptor, request_id="request_1",
        session_id="session_1", runtime=runtime, timeout_seconds=5.0, cancel_handle=None,
        admission_arguments=dict(arguments),
    )
    return grants


def test_dispatch_admission_carries_the_grant_for_a_read_only_command(root: Path) -> None:
    assert _dispatch_grants(root, "git log -5") == ["read_only_command"]


@pytest.mark.parametrize("command", ["npm test", "sed -i s/a/b/ x.txt", "cat ../secret.txt"])
def test_dispatch_admission_has_no_grant_for_other_commands(command: str, root: Path) -> None:
    assert _dispatch_grants(root, command) == [None]


def test_dispatch_admission_has_no_grant_for_other_tools_or_with_the_flag_off(root: Path) -> None:
    assert _dispatch_grants(root, "git log -5", tool_id="run_temp_script") == [None]
    assert _dispatch_grants(
        root, "git log -5", flags={FEATURE_READ_ONLY_COMMANDS: False}
    ) == [None]
    assert _dispatch_grants(root, "git log -5", host_mode="server") == [None]


# ------------------------------------------------------------------- 4. prompt overlays


def test_plan_and_propose_overlays_mention_read_only_commands_only_when_enabled() -> None:
    assert READ_ONLY_COMMANDS_PROMPT_LINE not in build_plan_mode_overlay(plan_mode_active=True)
    plan = build_plan_mode_overlay(plan_mode_active=True, read_only_commands=True)
    assert plan.endswith(READ_ONLY_COMMANDS_PROMPT_LINE)
    assert PLAN_MODE_GUIDANCE in plan
    propose = build_propose_mode_overlay(propose_mode_active=True, read_only_commands=True)
    assert propose.endswith(READ_ONLY_COMMANDS_PROMPT_LINE)
    assert PROPOSE_MODE_GUIDANCE in propose
    assert READ_ONLY_COMMANDS_PROMPT_LINE not in build_propose_mode_overlay(
        propose_mode_active=True
    )
    assert build_plan_mode_overlay(plan_mode_active=False, read_only_commands=True) == ""


def test_runtime_overlays_carry_the_line_when_asked() -> None:
    plain: list[str] = []
    append_mode_runtime_overlays(
        plain, request_context=SimpleNamespace(plan_mode=True, propose_mode=True)
    )
    assert not any(READ_ONLY_COMMANDS_PROMPT_LINE in entry for entry in plain)
    enabled: list[str] = []
    append_mode_runtime_overlays(
        enabled, request_context=SimpleNamespace(plan_mode=True, propose_mode=True),
        config={"tools_shell_enabled": True, "feature_flags": {}},
    )
    assert sum(READ_ONLY_COMMANDS_PROMPT_LINE in entry for entry in enabled) == 2
    disabled: list[str] = []
    append_mode_runtime_overlays(
        disabled, request_context=SimpleNamespace(plan_mode=True, propose_mode=True),
        config={"tools_shell_enabled": True, "feature_flags": {"read_only_commands": False}},
    )
    assert not any(READ_ONLY_COMMANDS_PROMPT_LINE in entry for entry in disabled)


# ------------------------------------------------------------ 9. final-review fixes


@pytest.mark.parametrize(
    "command",
    [
        "uniq a.txt b.txt",  # the second operand is an output file
        "ag --pager calc foo",  # the pager is a program
        "ack foo",  # a project .ackrc can set the pager
        "file -C -m magic",  # compiles a .mgc file
        "date -s 2020-01-01",
        "hostname build-box",
    ],
)
def test_allowlisted_names_that_write_or_launch_still_ask(command: str, root: Path) -> None:
    assert _gate(command, root) is not None
    remaining, outcomes = _prefilter(command, root)
    assert remaining == []
    assert outcomes[0].output == READ_ONLY_COMMAND_REFUSAL


@pytest.mark.parametrize("command", ["uniq -c a.txt", "ag foo src", "file a.py", "date", "hostname"])
def test_their_plain_reads_still_run(command: str, root: Path) -> None:
    (root / "a.txt").write_text("a", encoding="utf-8")
    (root / "a.py").write_text("", encoding="utf-8")
    assert _gate(command, root) is None


def test_a_stored_legacy_run_command_policy_is_not_the_untouched_default(root: Path) -> None:
    legacy = ToolPolicySnapshot(version=1, legacy_policies=(("run_command", "ask"),))
    assert _gate("git log -5", root, snapshot=legacy) is not None
    decision = SimpleNamespace(
        decision="ask", stage="tool_default", matched_rule_id=None,
        reason="legacy per-tool policy: run_command=ask",
    )
    assert approval_grant_applies(decision, paranoid=False) is False
    assert approval_grant_applies(
        SimpleNamespace(decision="ask", stage="tool_default", matched_rule_id=None, reason=""),
        paranoid=False,
    ) is True


def test_the_refusal_names_read_only_commands_only_when_the_classifier_asked(root: Path) -> None:
    _remaining, blocked = _prefilter("rm -rf /", root)  # BLOCKED, not NEEDS_APPROVAL
    assert blocked[0].output != READ_ONLY_COMMAND_REFUSAL
    _remaining, bridged = _prefilter("npm test", root, server_name="electron_tool_bridge")
    assert bridged[0].output != READ_ONLY_COMMAND_REFUSAL
    _remaining, unclassified = _prefilter("npm test", root, flags={"shell_security": False})
    assert unclassified[0].output != READ_ONLY_COMMAND_REFUSAL


def test_a_granted_read_only_command_is_not_counted_toward_the_auto_streak(
    root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from sidecar.ai.routing import route_policy_runtime

    counted: list[object] = []
    monkeypatch.setattr(route_policy_runtime, "record_auto_approval", counted.append)
    assert _gate("git log -5", root) is None
    assert counted == []
