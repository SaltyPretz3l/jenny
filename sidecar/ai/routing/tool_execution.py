"""Extracted tool-execution helpers for AgentKernel.

Every public function in this module corresponds to a former private method on
AgentKernel.  Instance methods receive a ``kernel`` parameter (the
AgentKernel instance); former ``@staticmethod`` / ``@classmethod`` methods
are plain module-level functions.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any, Callable

from sidecar.ai.error_codes import (
    CMP_LOOP_TOOL_INTERRUPTED,
    CMP_TOOL_POLICY_DENIED,
)
from sidecar.ai.execution_policy import desktop_policy_is_enforced
from sidecar.ai.feature_flags import FEATURE_SHELL_HEAD_TAIL_OUTPUT as _HEAD_TAIL
from sidecar.ai.feature_flags import is_default_on_flag_enabled as _default_on
from sidecar.ai.routing import delegate as _delegate
from sidecar.ai.routing import harness_helpers as _harness_helpers
from sidecar.ai.routing import loop_events as _loop_events
from sidecar.ai.routing import resource_pressure as _resource_pressure
from sidecar.ai.routing import route_policy_runtime as _route_policy_runtime
from sidecar.ai.routing import tool_authority as _tool_authority
from sidecar.ai.routing import tool_dispatch as _tool_dispatch
from sidecar.ai.routing import tool_execution_admission as _admission
from sidecar.ai.routing import tool_execution_ask_user_wait as _ask_user_wait
from sidecar.ai.routing import tool_execution_outcomes as _outcomes
from sidecar.ai.routing import tool_execution_results as _results
from sidecar.ai.routing import tool_execution_snapshots as _snap
from sidecar.ai.routing import tool_execution_tool_handlers as _handlers
from sidecar.ai.routing import tool_observation as _tool_observation
from sidecar.ai.routing import tool_resource_deferral as _tool_resource_deferral
from sidecar.ai.routing import tool_restored_inputs as _tool_restored_inputs
from sidecar.ai.routing.tool_resolution import contract_entry_for_call
from sidecar.ai.tools import assembly as _tools_assembly
from sidecar.ai.tools import plan_artifact_policy as _plan_artifact_policy
from sidecar.ai.tools import read_only_command_grant as _read_only
from sidecar.ai.tools import tool_actions as _tool_actions
from sidecar.ai.tools.builtins import shell_security as _shell_security
from sidecar.ai.tools.catalog import BUILTIN_MCP_SERVER_NAME
from sidecar.ai.tools.policy import (
    POLICY_DECISION_ASK,
    POLICY_DECISION_AUTO,
    POLICY_DECISION_DENY,
    ToolPolicyDecision,
    tool_policy_call_key,
)
from sidecar.runtime import operation_ledger as _operation_ledger
from sidecar.runtime.chat_models import TerminalChatStateError
from sidecar.runtime.electron_tool_bridge import (
    ElectronToolBridgeRequest,
    execute_electron_tool,
)
from sidecar.runtime.tool_execution_support import (
    CMP_LOOP_INVALID_TOOL_CALL,
    CMP_MODE_TOOL_BLOCKED,
    CMP_TOOL_COMMAND_BLOCKED,
    CMP_TOOL_DISABLED,
    FEATURE_SHELL_SECURITY,
    CommandVerdict,
    MCPError,
    ToolCallRequest,
    ToolExecutionFailure,
    classify_command,
    escalate_out_of_root,
    is_feature_flag_enabled,
    scan_tool_arguments,
)
from sidecar.runtime.turn_state import current_live_run_mode_state

if TYPE_CHECKING:
    from sidecar.runtime.tool_execution_support import ApprovalRequest, ToolExecutionOutcome

MAX_RESPONSE_CHARS = _harness_helpers.MAX_RESPONSE_CHARS
# Hub attributes below have consumers outside this module (router.py, tool_recall.py,
# tool_execution_tool_handlers.py) or are monkeypatch seams in tests; keep each one live.
assistant_tool_call_message = _results.assistant_tool_call_message
bounded_tool_output = _results.bounded_tool_output
tool_result_message = _results.tool_result_message
_merge_result_metadata = _results.merge_result_metadata
derive_idempotency_key = _operation_ledger.derive_idempotency_key
inject_idempotency_key = _operation_ledger.inject_idempotency_key
increment_counter_for_kernel = _route_policy_runtime.increment_counter_for_kernel
KIND_TOOL_EXECUTION_FAILED = _tool_observation.KIND_TOOL_EXECUTION_FAILED
KIND_TOOL_EXECUTION_OBSERVED = _tool_observation.KIND_TOOL_EXECUTION_OBSERVED
KIND_TOOL_EXECUTION_STARTED = _tool_observation.KIND_TOOL_EXECUTION_STARTED
blocked_tool_error_code = _tools_assembly.blocked_tool_error_code
blocked_tool_message = _tools_assembly.blocked_tool_message
blocked_tool_metadata = _tools_assembly.blocked_tool_metadata
execute_delegate_tool = _delegate.execute_delegate_tool
apply_tool_pressure_backoff = _resource_pressure.apply_tool_pressure_backoff
build_tool_pressure_backoff_decision = _resource_pressure.build_tool_pressure_backoff_decision
update_read_snapshot_cache = _snap.update_read_snapshot_cache
rebuild_read_snapshot_cache = _snap.rebuild_read_snapshot_cache
freeze_effective_execution_inputs = _snap.freeze_effective_execution_inputs
tool_outcome_from_handler_result = _handlers.tool_outcome_from_handler_result
execute_tool_search = _handlers.execute_tool_search
assert_valid_tool_call = _admission.assert_valid_tool_call
filter_tool_calls_by_policy = _admission.filter_tool_calls_by_policy
_descriptor_validation_outcome = _admission.descriptor_validation_outcome
_blocked_outcome = _admission.blocked_outcome
_audit_tool_event = _outcomes.audit_tool_event

# Lazy import helpers -- resolved once and cached at module level so that
# the heavy ``router`` module is *never* imported at module-load time.
_router_module: Any = None


def _router() -> Any:
    global _router_module
    if _router_module is None:
        from sidecar.ai.routing import router as _mod

        _router_module = _mod
    return _router_module


logger = logging.getLogger(__name__)


# W2-1 live tool-output tail: host-side re-bounding of transport chunk
# payloads. The builtin server already sanitizes and bounds what it emits, but
# the notification arrives over an MCP transport any stdio server can write
# to — treat it as untrusted and re-validate shape + sizes here.
_MAX_CHUNK_LINES = 50
_MAX_CHUNK_LINE_CHARS = 4_000


# Only run_command streams live output today; scoping the emitter here keeps
# every other tool's dispatch (and its test fakes) byte-identical.
_STREAMING_OUTPUT_TOOLS = frozenset({"run_command"})


def _build_output_chunk_emitter(runtime: Any, call: ToolCallRequest) -> Any:
    if runtime is None or not callable(getattr(runtime, "emit", None)):
        return None
    tool_name = str(call.tool_id or "")
    if tool_name not in _STREAMING_OUTPUT_TOOLS:
        return None
    call_id = str(call.call_id or "").strip()
    if not call_id:
        return None

    def _coerce_count(params: dict[str, Any], key: str) -> int:
        try:
            return max(0, int(params.get(key) or 0))
        except (TypeError, ValueError):
            return 0

    def _emit(params: Any) -> None:
        if not isinstance(params, dict):
            return
        raw_lines = params.get("lines")
        lines: list[dict[str, str]] = []
        if isinstance(raw_lines, list):
            for item in raw_lines[:_MAX_CHUNK_LINES]:
                if not isinstance(item, dict):
                    continue
                stream = "stderr" if item.get("stream") == "stderr" else "stdout"
                text = str(item.get("text") or "")[:_MAX_CHUNK_LINE_CHARS]
                if text:
                    lines.append({"stream": stream, "text": text})
        partial = str(params.get("partial") or "")[:_MAX_CHUNK_LINE_CHARS]
        raw_progress = params.get("test_progress")
        test_progress = raw_progress if isinstance(raw_progress, dict) else None
        if not lines and not partial and test_progress is None:
            return
        runtime.emit(
            _loop_events.ToolOutputChunkEvent(
                call_id=call_id,
                tool_name=tool_name,
                sequence=_coerce_count(params, "sequence"),
                lines=tuple(lines),
                partial=partial,
                emitted_lines=_coerce_count(params, "emitted_lines"),
                dropped_lines=_coerce_count(params, "dropped_lines"),
                elapsed_ms=_coerce_count(params, "elapsed_ms"),
                test_progress=test_progress,
            )
        )

    return _emit


def _dispatch_tool_call(
    *,
    kernel: Any,
    call: ToolCallRequest,
    tool_arguments: dict[str, Any],
    descriptor: Any,
    request_id: str,
    session_id: str | None,
    runtime: Any,
    timeout_seconds: float | None,
    cancel_handle: Any,
    on_output_chunk: Any = None,
    admission_arguments: dict[str, Any] | None = None,
    on_dispatch_ready: Callable[[], None] | None = None,
    decision_snapshot: Any = None,
):
    return _tool_dispatch.dispatch_tool_call(
        kernel=kernel, call=call, tool_arguments=tool_arguments, descriptor=descriptor,
        request_id=request_id, session_id=session_id, runtime=runtime,
        timeout_seconds=timeout_seconds, cancel_handle=cancel_handle,
        on_output_chunk=on_output_chunk, admission_arguments=admission_arguments or {},
        builtin_server_name=BUILTIN_MCP_SERVER_NAME,
        electron_server_name="electron_tool_bridge",
        electron_request_type=ElectronToolBridgeRequest,
        electron_executor=execute_electron_tool, logger=logger,
        on_dispatch_ready=on_dispatch_ready, decision_snapshot=decision_snapshot,
        read_only_grant=lambda: _read_only.read_only_grant(kernel, call, descriptor, runtime),
    )


def _tool_timeout_for_runtime(
    kernel: Any,
    runtime: Any | None,
    call: ToolCallRequest | None = None,
) -> float | None:
    from sidecar.ai.routing import iteration_limits as _iteration_limits

    return _iteration_limits.tool_timeout_for_runtime(kernel._config, runtime, call)


def approval_if_needed(
    kernel: Any,
    calls: tuple[ToolCallRequest, ...],
    *,
    mode: str,
    mode_allows_side_effecting: bool,
    require_approval: bool,
    approvals_pre_granted: bool,
    resolution_context: Any | None,
    tool_contract: Any | None = None,
    plan_mode: bool = False,
    read_only: bool = False,
    request_disabled_tools: frozenset[str] = frozenset(),
    policy_decisions_by_call: dict[str, ToolPolicyDecision] | None = None,
    approval_mode: str = "prompt",
    execution_context: Any | None = None,
) -> ApprovalRequest | None:
    # Keep every check per-call for tool_loop_recovery.approval_with_recovery.
    mod = _router()
    ApprovalRequest_ = mod.ApprovalRequest

    for call in calls:
        live_run_mode = current_live_run_mode_state()
        if live_run_mode is not None:
            approval_mode, read_only = live_run_mode.snapshot()
        assert_valid_tool_call(call)
        if call.tool_id == "tool_search":
            continue
        if kernel._is_direct_deferred_tool_call(call, resolution_context):
            continue
        if call.tool_id in request_disabled_tools:
            continue
        scan_tool_arguments(call.arguments, tool_name=call.tool_id)
        entry, descriptor = contract_entry_for_call(kernel, tool_contract, call.tool_id)
        if entry is not None and not entry.available:
            continue
        if descriptor is None:
            if call.tool_id == "run_command" and not kernel._config.tools_shell_enabled:
                raise ToolExecutionFailure(
                    code=CMP_TOOL_DISABLED,
                    message="shell tool is disabled by configuration",
                    retryable=False,
                )
            raise ToolExecutionFailure(
                code=CMP_LOOP_INVALID_TOOL_CALL,
                message=f"model requested unknown tool '{call.tool_id}'",
                retryable=False,
            )
        _route_policy_runtime.require_desktop_tool_dispatch(descriptor, kernel._config)
        if descriptor.name == "run_command" and not kernel._config.tools_shell_enabled:
            raise ToolExecutionFailure(
                code=CMP_TOOL_DISABLED,
                message="shell tool is disabled by configuration",
                retryable=False,
            )
        desktop_bridge_command = (
            desktop_policy_is_enforced(kernel._config)
            and descriptor.name == "run_command"
            and getattr(descriptor, "server_name", "") == "electron_tool_bridge"
        )
        # Row 102: a read-only command is not side-effecting for the mode and unattended gates.
        shell_classification = _read_only.candidate_classification(
            kernel, call, descriptor, execution_context
        )
        read_only_command = _read_only.is_read_only_command(
            kernel._config, descriptor, shell_classification
        )
        call_side_effecting = _tool_actions.effective_side_effecting(
            descriptor, call.arguments
        ) and not read_only_command
        plan_artifact_write = _plan_artifact_policy.is_plan_artifact_write_eligible(
            descriptor,
            call.tool_id,
            call.arguments,
            plan_mode=plan_mode,
            read_only=read_only,
        )
        if read_only and call_side_effecting and not plan_artifact_write:
            continue
        if call_side_effecting and not mode_allows_side_effecting and not plan_artifact_write:
            raise ToolExecutionFailure(
                code=CMP_MODE_TOOL_BLOCKED,
                message=f"side-effecting tools are disabled in '{mode}' mode",
                retryable=False,
            )
        # Electron performs the authoritative sandbox admission and explicit
        # approval for bridge-owned run_command.  Sidecar must not prompt a
        # second time or apply its host-shell classifier to that call.
        if desktop_bridge_command:
            continue
        hosted_approval = _route_policy_runtime.hosted_approval_request(
            kernel._config, approvals_pre_granted, ApprovalRequest_, call, descriptor, mode
        )
        if hosted_approval is not None:
            return hosted_approval
        if shell_classification is None:  # a non-candidate is classified only past the exits
            shell_classification = classify_run_command_for_approval(
                kernel, call, descriptor_name=descriptor.name, execution_context=execution_context
            )
        request_safety = _route_policy_runtime.current_request_safety()
        paranoid_mode = (
            _route_policy_runtime.resolve_safety_mode(request_safety, kernel._config) == "paranoid"
        )
        if shell_classification and shell_classification.verdict is CommandVerdict.BLOCKED:
            raise ToolExecutionFailure(
                code=CMP_TOOL_COMMAND_BLOCKED,
                message=f"command blocked by security classifier: {shell_classification.reason}",
                retryable=False,
            )
        policy_decision = (policy_decisions_by_call or {}).get(tool_policy_call_key(call))
        if policy_decision is not None:
            if policy_decision.decision == POLICY_DECISION_DENY:
                raise ToolExecutionFailure(
                    code=CMP_TOOL_POLICY_DENIED,
                    message=f"tool denied by policy: {policy_decision.reason}",
                    retryable=False,
                )
        auto_run = approval_mode == "auto_run" and not paranoid_mode
        plan_mode_only = _tools_assembly.mode_only_tool(descriptor)
        # Python is resource-contained but deliberately not a filesystem or
        # network sandbox. Every initial Python execution remains approval-
        # gated, even for a one-send auto-run grant or an AUTO policy rule.
        if _admission.runs_python(descriptor.name, call.arguments) and not approvals_pre_granted:
            return _route_policy_runtime.build_approval_request(
                ApprovalRequest_, call, descriptor,
                mode=mode,
                reason="Python execution always requires approval.",
                policy_decision=policy_decision,
            )
        # Raw shell rm always asks; typed equivalents must too, or auto_run
        # could route around the file-safety gate.
        if (
            descriptor.name in _admission.ALWAYS_ASK_DESTRUCTIVE_TOOLS
            and not approvals_pre_granted
        ):
            return _route_policy_runtime.build_approval_request(
                ApprovalRequest_, call, descriptor,
                mode=mode,
                reason=_route_policy_runtime.destructive_tool_approval_reason(
                    descriptor.name, call.arguments,
                ),
                # The UI must not offer to persist an always-allow rule this gate never honours.
                policy_decision=None,
            )
        always_card = descriptor.name in _route_policy_runtime.ALWAYS_ASK_CARD_TOOLS
        if always_card and not approvals_pre_granted:
            return _route_policy_runtime.build_approval_request(
                ApprovalRequest_, call, descriptor,
                mode=mode,
                reason=_route_policy_runtime.always_ask_card_reason(descriptor.name),
                policy_decision=None,
            )
        if read_only_command and not auto_run and _read_only.approval_grant_applies(
            policy_decision, paranoid=paranoid_mode
        ):
            continue  # not counted toward the Auto streak cap
        if (
            policy_decision is not None
            and policy_decision.decision == POLICY_DECISION_ASK
            and not approvals_pre_granted
            and (plan_mode_only or not auto_run)
        ):
            return _route_policy_runtime.build_approval_request(
                ApprovalRequest_, call, descriptor,
                mode=mode,
                reason=f"Tool policy requires approval: {policy_decision.reason}",
                policy_decision=policy_decision,
            )
        raw_shell_command = _shell_security.shell_command_for_tool(
            descriptor.name,
            call.arguments,
        )
        shell_uses_powershell = _shell_security.shell_command_uses_powershell(
            descriptor.name,
            call.arguments,
        )
        destructive_executable = (
            _shell_security.find_destructive_executable(
                raw_shell_command,
                powershell=shell_uses_powershell,
            )
            if raw_shell_command is not None
            else None
        )
        if destructive_executable is not None and not approvals_pre_granted:
            return _route_policy_runtime.build_approval_request(
                ApprovalRequest_, call, descriptor,
                mode=mode,
                reason=(
                    "This command can delete or overwrite files "
                    f"({destructive_executable}). Approve to continue."
                ),
                policy_decision=policy_decision,
            )
        if (
            auto_run
            and is_feature_flag_enabled(
                kernel._config.feature_flags or {},
                _shell_security.FEATURE_STRICT_AUTO_RUN,
            )
            and shell_classification is not None
            and shell_classification.verdict is CommandVerdict.NEEDS_APPROVAL
            and not approvals_pre_granted
        ):
            return _route_policy_runtime.build_approval_request(
                ApprovalRequest_, call, descriptor,
                mode=mode,
                reason=(
                    f"The requested shell command needs approval: "
                    f"{shell_classification.reason}"
                ),
                policy_decision=policy_decision,
            )
        if auto_run:
            streak_request = _route_policy_runtime.streak_cap_request(
                live_run_mode,
                _route_policy_runtime.resolve_streak_cap(request_safety, kernel._config),
                call, descriptor, mode,
            )
            if streak_request is not None:
                return streak_request
            continue
        if (paused_request := _route_policy_runtime.paused_unattended_approval_request(
            live_run_mode, call_side_effecting, call, descriptor, mode
        )) is not None:
            return paused_request
        if (
            policy_decision is not None
            and policy_decision.decision == POLICY_DECISION_AUTO
            and not paranoid_mode
        ):
            _route_policy_runtime.record_auto_approval(live_run_mode)
            continue
        if shell_classification is not None:
            if (
                shell_classification.verdict is CommandVerdict.NEEDS_APPROVAL
                and not paranoid_mode
                and not approvals_pre_granted
            ):
                return _route_policy_runtime.build_approval_request(
                    ApprovalRequest_, call, descriptor,
                    mode=mode,
                    reason=(
                        f"The requested shell command needs approval: "
                        f"{shell_classification.reason}"
                    ),
                    policy_decision=policy_decision,
                )
            if shell_classification.verdict is CommandVerdict.ALLOWED and not paranoid_mode:
                continue
        should_confirm = (
            paranoid_mode
            or (
                call_side_effecting
                and kernel._config.tools_confirm_side_effects
                and require_approval
            )
        )
        if should_confirm and not approvals_pre_granted:
            reason = "The model requested a side-effecting MCP tool call."
            if paranoid_mode:
                reason = "Paranoid safety mode requires approval for every tool call."
            if shell_classification is not None:
                reason = (
                    f"The requested shell command needs approval: {shell_classification.reason}"
                )
            return _route_policy_runtime.build_approval_request(
                ApprovalRequest_, call, descriptor,
                mode=mode,
                reason=reason,
                policy_decision=policy_decision,
            )
    return None


def classify_run_command_for_approval(
    kernel: Any,
    call: ToolCallRequest,
    *,
    descriptor_name: str,
    execution_context: Any | None = None,
) -> Any | None:
    if not is_feature_flag_enabled(kernel._config.feature_flags or {}, FEATURE_SHELL_SECURITY):
        return None
    raw_command = _shell_security.shell_command_for_tool(descriptor_name, call.arguments)
    if raw_command is None:
        return None
    powershell = _shell_security.shell_command_uses_powershell(descriptor_name, call.arguments)
    cwd = call.arguments.get("cwd")
    # An ALLOWED read must not reach outside the request's root (security review item 1);
    # a request context without a root binds none, so every path-like argument asks.
    root = (
        getattr(execution_context, "root_path", None)
        if execution_context is not None
        else getattr(kernel._config, "tools_workspace_root", None)
    )
    return escalate_out_of_root(
        classify_command(raw_command, powershell=powershell),
        root=root,
        cwd=cwd if isinstance(cwd, str) else None,
        powershell=powershell,
    )


def inject_dispatch_trace_id(
    tool_arguments: dict[str, object],
    *,
    descriptor: Any | None,
    runtime: Any | None,
    call: ToolCallRequest,
) -> dict[str, object]:
    try:
        if descriptor is None or getattr(descriptor, "source_kind", "mcp") == "mcp":
            return tool_arguments
        trace_id = str(getattr(runtime, "trace_id", "") or "").strip()
        call_id = str(call.call_id or "").strip()
        if trace_id and call_id:
            tool_arguments["_jenny_trace_id"] = f"{trace_id}.{call_id}"
    except Exception:  # noqa: BLE001 - diagnostic
        logger.debug("dispatch trace id not injected", exc_info=True)
    return tool_arguments


def execute_tool(
    kernel: Any,
    call: ToolCallRequest,
    *,
    request_id: str,
    session_id: str | None = None,
    read_snapshot_cache: dict[str, dict[str, object]],
    tool_contract: Any | None = None,
    trusted_plan_artifact_write: bool | None = None,
    audit_metadata: dict[str, object] | None = None,
    runtime: Any | None = None,
    on_dispatch_ready: Callable[[], None] | None = None,
    restored_inputs: _tool_restored_inputs.RestoredToolInputs | None = None,
    on_frozen_input: Callable[[Any], Any] | None = None,
    request_outcomes: tuple[Any, ...] | None = None,
) -> ToolExecutionOutcome:
    cancel_handle = getattr(runtime, "cancel_handle", None)
    if runtime is not None:
        runtime.raise_if_interrupted()
    dispatch_started = failure_audited = False

    def _audit_started_failure(error: BaseException) -> None:
        # A STARTED event must always be paired: cancellation, a deadline or a
        # dispatch-side ToolExecutionFailure after dispatch-ready audits FAILED once.
        nonlocal failure_audited
        if dispatch_started and not failure_audited:
            failure_audited = True
            code = str(getattr(error, "code", "") or "") or CMP_LOOP_TOOL_INTERRUPTED
            _audit_tool_event(runtime, KIND_TOOL_EXECUTION_FAILED, call, error_code=code)

    def _mark_dispatch_ready() -> None:
        nonlocal dispatch_started
        if dispatch_started:
            return
        if callable(on_dispatch_ready):
            on_dispatch_ready()
        # Set before the interrupt check so a second call can never re-audit STARTED.
        dispatch_started = True
        if runtime is not None:
            _audit_tool_event(runtime, KIND_TOOL_EXECUTION_STARTED, call)
            try:
                runtime.raise_if_interrupted()
            except TerminalChatStateError as error:
                _audit_started_failure(error)
                raise
    mod = _router()
    ToolExecutionOutcome_ = mod.ToolExecutionOutcome
    request_context = getattr(runtime, "request_context", None)
    refusal = getattr(request_context, "preparation_refusal", None)
    preparation_reason = refusal(call.tool_id) if callable(refusal) else None
    if preparation_reason is not None:
        # Before any descriptor lookup: a preparation turn resolves no other tool, MCP included.
        _mark_dispatch_ready()
        return _blocked_outcome(
            ToolExecutionOutcome_, call, preparation_reason, dict(call.arguments or {})
        )
    execution_context = getattr(request_context, "execution_context", None)
    logical_turn_id = str(getattr(runtime, "logical_turn_id", "") or request_id)
    if restored_inputs is not None:
        frozen_inputs = restored_inputs.bind_for_attempt(
            call=call, session_id=session_id, logical_turn_id=logical_turn_id,
            execution_context=execution_context,
        )
        _tool_restored_inputs.refuse_restored_mode_drift(
            frozen_inputs,
            read_only=bool(getattr(request_context, "read_only", False)),
            approved_plan=getattr(request_context, "approved_plan", None),
            trusted_plan_artifact_write=bool(trusted_plan_artifact_write),
        )
    else:
        frozen_inputs = freeze_effective_execution_inputs(
            kernel, call, session_id=session_id,
            read_snapshot_cache=read_snapshot_cache, tool_contract=tool_contract,
            plan_mode=bool(getattr(request_context, "plan_mode", False)),
            read_only=bool(getattr(request_context, "read_only", False)),
            approved_plan=getattr(request_context, "approved_plan", None),
            trusted_plan_artifact_write=trusted_plan_artifact_write,
            turn_id=logical_turn_id, execution_context=execution_context,
            request_context=request_context, request_outcomes=request_outcomes,
        )
    scan_tool_arguments(call.arguments, tool_name=call.tool_id)
    visible_tool_arguments = dict(frozen_inputs.visible_tool_arguments)
    apply_tool_pressure_backoff(
        tool_name=call.tool_id,
        request_id=request_id,
        session_id=session_id,
        runtime=runtime,
        decision=build_tool_pressure_backoff_decision(
            config=getattr(kernel, "_config", None),
            root=(
                getattr(execution_context, "root_path", None)
                if execution_context is not None
                else getattr(getattr(kernel, "_config", None), "tools_workspace_root", None)
            ),
        ),
    )
    entry, descriptor = contract_entry_for_call(kernel, tool_contract, call.tool_id)
    if entry is not None and not entry.available:
        _mark_dispatch_ready()
        return _blocked_outcome(ToolExecutionOutcome_, call, entry.reason, visible_tool_arguments)
    host_allowed, host_reason = _route_policy_runtime.hosted_tool_dispatch_decision(
        descriptor if descriptor is not None else call.tool_id,
        getattr(kernel, "_config", None),
    )
    if not host_allowed:
        raise ToolExecutionFailure(
            code=CMP_TOOL_POLICY_DENIED,
            message=host_reason or "tool denied by hosted execution policy",
            retryable=False,
        )
    _route_policy_runtime.require_desktop_tool_dispatch(
        descriptor if descriptor is not None else call.tool_id, getattr(kernel, "_config", None)
    )
    # Delegate validation normalizes aliases and isolates malformed array items.
    is_delegate = call.tool_id == "delegate"
    validate = (
        _delegate.delegate_validation_outcome if is_delegate else _descriptor_validation_outcome
    )
    validation_outcome = validate(
        kernel=kernel, call=call, descriptor=descriptor,
        visible_tool_arguments=visible_tool_arguments, request_id=request_id,
        outcome_type=ToolExecutionOutcome_,
        **({"increment_counter": increment_counter_for_kernel} if is_delegate else {}),
    )
    if validation_outcome is not None:
        _mark_dispatch_ready()
        return validation_outcome
    tool_arguments = dict(frozen_inputs.effective_tool_arguments)
    # The reserved plan-artifact marker never reaches a handler.
    tool_arguments.pop(_plan_artifact_policy.PLAN_ARTIFACT_WRITE_ARG, None)
    timeout_seconds = _tool_timeout_for_runtime(kernel, runtime, call)
    # Sidecar-owned synthetic tools run in-process through one name -> handler table.
    synthetic_handler = _handlers.SYNTHETIC_TOOL_HANDLERS.get(call.tool_id)
    if synthetic_handler is not None:
        _tool_authority.admit_scoped_tool_call(
            runtime=runtime, call=call, descriptor=descriptor, tool_arguments=tool_arguments,
            visible_arguments=visible_tool_arguments,
            builtin_server_name=BUILTIN_MCP_SERVER_NAME, timeout_seconds=timeout_seconds,
            inject_trusted_envelope=False,
        )
        _mark_dispatch_ready()
        return synthetic_handler(
            kernel=kernel, call=call, tool_arguments=tool_arguments,
            visible_tool_arguments=visible_tool_arguments, request_id=request_id,
            session_id=session_id, audit_metadata=audit_metadata, runtime=runtime,
            outcome_type=ToolExecutionOutcome_,
            **({"request_outcomes": request_outcomes}
               if call.tool_id == "recall_tool_output" else {}),
        )
    try:
        # Electron-bridge tools already carry trace_id as a first-class request
        # field; a stray _jenny_* argument key would cross the IPC wire contract.
        if getattr(descriptor, "server_name", "") != "electron_tool_bridge":
            for inject in (inject_dispatch_trace_id, inject_idempotency_key):
                tool_arguments = inject(
                    tool_arguments, descriptor=descriptor, runtime=runtime, call=call
                )
        # See tool_execution_ask_user_wait for the approval-parity rationale:
        # a human answer or exact-content consent must not burn working time.
        decision_snapshot = on_frozen_input(frozen_inputs) if callable(on_frozen_input) else None
        wait_started_at = _ask_user_wait.ask_user_wait_started_at(runtime, call, descriptor)
        try:
            if call.tool_id == "connections_list":
                tool_arguments["_jenny_session_offline_lockdown"] = (
                    getattr(request_context, "session_offline_lockdown", False) is True
                )
            result = _dispatch_tool_call(
                kernel=kernel, call=call, descriptor=descriptor,
                tool_arguments=tool_arguments, admission_arguments=visible_tool_arguments,
                request_id=request_id, session_id=session_id, runtime=runtime,
                timeout_seconds=timeout_seconds, cancel_handle=cancel_handle,
                on_output_chunk=_build_output_chunk_emitter(runtime, call),
                on_dispatch_ready=_mark_dispatch_ready, decision_snapshot=decision_snapshot,
            )
        finally:
            _ask_user_wait.credit_ask_user_wait(runtime, wait_started_at)
        # Never check interruption after dispatch: its effect is already committed.
        # The sequential caller first appends/emits the completed result, then
        # observes cancellation. Otherwise committed work becomes a retryable
        # interruption (CMP-LOOP-0013).
    except (
        _tool_resource_deferral.ToolLoopSuspended, _tool_resource_deferral.DecisionSuspensionError
    ):
        raise
    except _tool_resource_deferral.ToolResourceDeferred as error:
        try:
            raise error.prepare(
                call_id=str(call.call_id or ""),
                tool_id=str(call.tool_id or ""),
                frozen_inputs=frozen_inputs,
            ) from error
        except ValueError:
            raise _tool_resource_deferral.resource_wait_failure(error.wait) from error
    except MCPError as error:
        raise _outcomes.mcp_tool_failure(
            error, call=call, descriptor=descriptor, runtime=runtime, request_id=request_id
        ) from error
    except (TerminalChatStateError, ToolExecutionFailure) as error:
        _audit_started_failure(error)
        raise
    except Exception as error:
        raise _outcomes.unexpected_tool_failure(
            error, call=call, runtime=runtime, request_id=request_id
        ) from error
    _ask_user_wait.credit_browser_consent_wait(runtime, call, descriptor, result)
    result_tool_name = str(result.tool_name or call.tool_id or "")
    sanitized_output, router_output_truncated = bounded_tool_output(
        result.output,
        tool_name=result_tool_name,
        max_chars=MAX_RESPONSE_CHARS,
        keep_edges=_default_on(getattr(kernel._config, "feature_flags", None), _HEAD_TAIL),
    )
    metadata = _results.merge_result_metadata(result.metadata, audit_metadata)
    from sidecar.ai.routing import preview_vision as _preview_vision

    delivery, notice = _preview_vision.admit_preview(
        runtime, getattr(kernel, "_engine", None), call, result, descriptor,
    )
    if delivery:
        metadata["model_delivery_status"] = delivery
        sanitized_output += "\n" + notice
    return _outcomes.finalize_tool_outcome(
        call=call, result=result, descriptor=descriptor, runtime=runtime,
        metadata=metadata, sanitized_output=sanitized_output,
        router_output_truncated=router_output_truncated,
        max_response_chars=MAX_RESPONSE_CHARS,
        visible_tool_arguments=visible_tool_arguments,
        outcome_type=ToolExecutionOutcome_,
    )
