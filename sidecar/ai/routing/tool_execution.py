"""Extracted tool-execution helpers for AgentKernel.

Every public function in this module corresponds to a former private method on
AgentKernel.  Instance methods receive a ``kernel`` parameter (the
AgentKernel instance); former ``@staticmethod`` / ``@classmethod`` methods
are plain module-level functions.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any

from sidecar.ai.error_codes import (
    CMP_TOOL_EXECUTION_FAILED,
    CMP_TOOL_POLICY_DENIED,
)
from sidecar.ai.routing import delegate as _delegate
from sidecar.ai.routing import harness_helpers as _harness_helpers
from sidecar.ai.routing import loop_events as _loop_events
from sidecar.ai.routing import resource_pressure as _resource_pressure
from sidecar.ai.routing import route_policy_runtime as _route_policy_runtime
from sidecar.ai.routing import tool_execution_ask_user_wait as _ask_user_wait
from sidecar.ai.routing import tool_execution_results as _results
from sidecar.ai.routing import tool_execution_snapshots as _snap
from sidecar.ai.routing import tool_execution_tool_handlers as _handlers
from sidecar.ai.routing import tool_observation as _tool_observation
from sidecar.ai.tools import assembly as _tools_assembly
from sidecar.ai.tools import plan_artifact_policy as _plan_artifact_policy
from sidecar.ai.tools import schema_examples as _tools_schema_examples
from sidecar.ai.tools import tool_actions as _tool_actions
from sidecar.ai.tools.builtins import shell_security as _shell_security
from sidecar.ai.tools.policy import (
    POLICY_DECISION_ASK,
    POLICY_DECISION_AUTO,
    POLICY_DECISION_DENY,
    ToolPolicyDecision,
    ToolPolicyFilterContext,
    ToolPolicyFilterResult,
    tool_policy_call_key,
)
from sidecar.ai.tools.policy import filter_tool_calls_by_policy as _filter_tool_calls_by_policy
from sidecar.ai.tools.trusted_attachments import (
    admit_trusted_attachments,
    strip_attachment_shaped_metadata,
)
from sidecar.runtime import operation_ledger as _operation_ledger
from sidecar.runtime.chat_models import TerminalChatStateError
from sidecar.runtime.diagnostics import log_event
from sidecar.runtime.electron_tool_bridge import (
    ElectronToolBridgeRequest,
    execute_electron_tool,
)
from sidecar.runtime.tool_execution_support import (
    CMP_LOOP_INVALID_TOOL_CALL,
    CMP_LOOP_TOOL_INPUT_VALIDATION,
    CMP_MODE_TOOL_BLOCKED,
    CMP_TOOL_COMMAND_BLOCKED,
    CMP_TOOL_DISABLED,
    FEATURE_SHELL_SECURITY,
    CommandVerdict,
    MCPError,
    ToolCallRequest,
    ToolExecutionFailure,
    classify_command,
    is_feature_flag_enabled,
    scan_tool_arguments,
    validate_tool_arguments,
)
from sidecar.runtime.turn_state import (
    TERMINAL_SUBCODE_TIMEOUT_TOOL,
    TURN_STATE_TIMEOUT,
    current_live_run_mode_state,
)

if TYPE_CHECKING:
    from sidecar.runtime.tool_execution_support import ApprovalRequest, ToolExecutionOutcome

MAX_RESPONSE_CHARS = _harness_helpers.MAX_RESPONSE_CHARS
_ALWAYS_ASK_DESTRUCTIVE_TOOLS = frozenset({"delete_file", "move_file", "worktree_delete"})
assistant_tool_call_message = _results.assistant_tool_call_message
bounded_tool_output = _results.bounded_tool_output
tool_result_message = _results.tool_result_message
_bounded_tool_output = _results.bounded_tool_output
derive_idempotency_key = _operation_ledger.derive_idempotency_key
inject_idempotency_key = _operation_ledger.inject_idempotency_key
__all__ = (
    "assistant_tool_call_message",
    "tool_result_message",
)
increment_counter_for_kernel = _route_policy_runtime.increment_counter_for_kernel
KIND_TOOL_EXECUTION_FAILED = _tool_observation.KIND_TOOL_EXECUTION_FAILED
KIND_TOOL_EXECUTION_OBSERVED = _tool_observation.KIND_TOOL_EXECUTION_OBSERVED
KIND_TOOL_EXECUTION_STARTED = _tool_observation.KIND_TOOL_EXECUTION_STARTED
schema_placeholder_value = _tools_schema_examples.schema_placeholder_value
tool_schema_hint_text = _tools_schema_examples.tool_schema_hint_text
tool_schema_repair_hints = _tools_schema_examples.tool_schema_repair_hints
blocked_tool_error_code = _tools_assembly.blocked_tool_error_code
blocked_tool_message = _tools_assembly.blocked_tool_message
blocked_tool_metadata = _tools_assembly.blocked_tool_metadata
# Kept as a hub attribute so tests can patch the synthetic executor.
execute_delegate_tool = _delegate.execute_delegate_tool
apply_tool_pressure_backoff = _resource_pressure.apply_tool_pressure_backoff
build_tool_pressure_backoff_decision = _resource_pressure.build_tool_pressure_backoff_decision

# Re-export sibling implementations used by the hub and compatibility imports.
normalize_snapshot_lookup_path = _snap.normalize_snapshot_lookup_path
update_read_snapshot_cache = _snap.update_read_snapshot_cache
rebuild_read_snapshot_cache = _snap.rebuild_read_snapshot_cache
effective_mutation_path_arg = _snap.effective_mutation_path_arg
inject_expected_read_snapshot = _snap.inject_expected_read_snapshot
freeze_effective_execution_inputs = _snap.freeze_effective_execution_inputs
_execute_monitor_tool = _handlers._execute_monitor_tool
_format_monitor_digest = _handlers._format_monitor_digest
_execute_check_monitor_tool = _handlers._execute_check_monitor_tool
_execute_delegate_synthetic_tool = _handlers._execute_delegate_synthetic_tool
tool_outcome_from_handler_result = _handlers.tool_outcome_from_handler_result
execute_tool_search = _handlers.execute_tool_search

# Lazy import helpers -- resolved once and cached at module level so that
# the heavy ``router`` module is *never* imported at module-load time.
_router_module: Any = None


def _router() -> Any:
    global _router_module
    if _router_module is None:
        from sidecar.ai.routing import router as _mod

        _router_module = _mod
    return _router_module


def _is_paranoid_safety_mode(config: Any) -> bool:
    return str(getattr(config, "safety_mode", "normal")).lower() == "paranoid"


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
        if not lines and not partial:
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
):
    dispatch_kwargs: dict[str, Any] = {}
    if on_output_chunk is not None:
        # Passed conditionally so MCP-client fakes without the parameter stay
        # byte-compatible; only streaming-capable calls ever build an emitter.
        dispatch_kwargs["on_output_chunk"] = on_output_chunk
    if (
        descriptor is not None
        and getattr(descriptor, "server_name", "") == "electron_tool_bridge"
    ):
        request_context = getattr(runtime, "request_context", None)
        return execute_electron_tool(ElectronToolBridgeRequest(
            tool_name=call.tool_id,
            arguments=tool_arguments,
            request_id=request_id,
            trace_id=getattr(runtime, "trace_id", None) if runtime is not None else None,
            session_id=session_id,
            tool_call_id=str(call.call_id or "").strip(),
            write_message=getattr(runtime, "electron_tool_writer", None)
            if runtime is not None else None,
            read_message=getattr(runtime, "electron_tool_reader", None)
            if runtime is not None else None,
            response_reader_factory=getattr(
                runtime,
                "electron_tool_reader_factory",
                None,
            )
            if runtime is not None
            else None,
            timeout_seconds=timeout_seconds,
            logger=logger,
            cancel_handle=cancel_handle,
            plan_mode=bool(getattr(request_context, "plan_mode", False)),
            read_only=bool(getattr(request_context, "read_only", False)),
            plan_decision=str(getattr(request_context, "plan_decision", "") or ""),
            plan_feedback=str(getattr(request_context, "plan_feedback", "") or "")[:800],
            edited_plan=getattr(request_context, "edited_plan", None)
            if call.tool_id == "exit_plan_mode" else None,
        ))
    return kernel._mcp_client.execute_tool(
        call.tool_id,
        tool_arguments,
        timeout_seconds=timeout_seconds,
        cancel_handle=cancel_handle,
        **dispatch_kwargs,
    )


def _tool_timeout_for_runtime(
    kernel: Any,
    runtime: Any | None,
    call: ToolCallRequest | None = None,
) -> float | None:
    from sidecar.ai.routing import iteration_limits as _iteration_limits

    configured_timeout = _iteration_limits.effective_tools_execution_timeout_seconds(
        kernel._config
    )
    if call is not None and call.tool_id == "run_command":
        requested = call.arguments.get("timeout_seconds")
        if isinstance(requested, (int, float)) and not isinstance(requested, bool):
            # The outer transport deadline must not preempt the handler's
            # advertised timeout before it can terminate and report the child.
            configured_timeout = max(configured_timeout, min(600.0, float(requested)) + 5.0)
    if runtime is None:
        return configured_timeout
    remaining = runtime.remaining_wall_clock_seconds()
    if remaining is not None and remaining <= 0:
        raise TerminalChatStateError(
            status=TURN_STATE_TIMEOUT,
            terminal_subcode=TERMINAL_SUBCODE_TIMEOUT_TOOL,
            message="Tool execution skipped because the loop wall-clock budget is exhausted.",
        )
    if call is not None and call.tool_id == "ask_user" and remaining is not None:
        return remaining
    return runtime.tool_timeout_seconds(configured_timeout)


def _descriptor_validation_outcome(
    *,
    kernel: Any,
    call: ToolCallRequest,
    descriptor: Any | None,
    visible_tool_arguments: dict[str, object],
    request_id: str,
    outcome_type: Any,
) -> ToolExecutionOutcome | None:
    if descriptor is None or (
        call.coerced and not _tool_actions.effective_side_effecting(descriptor, call.arguments)
    ):
        return None
    try:
        validate_tool_arguments(
            tool_name=call.tool_id,
            arguments=visible_tool_arguments,
            input_schema=descriptor.input_schema,
        )
    except ToolExecutionFailure as error:
        repair_hints = tool_schema_repair_hints(descriptor.input_schema)
        hint_text = tool_schema_hint_text(repair_hints)
        log_event(
            logger,
            logging.WARNING,
            component="ai.router",
            event="ai.router.tool_call_input_validation_failed",
            message=f"Rejected tool call with invalid arguments: {call.tool_id}",
            status="failure",
            data={
                "tool": call.tool_id,
                "validation_error": error.message,
                "code": CMP_LOOP_TOOL_INPUT_VALIDATION,
                "request_id": request_id,
            },
        )
        increment_counter_for_kernel(kernel, "validation_failure")
        return outcome_type(
            tool_name=call.tool_id,
            output=(
                f"Tool '{call.tool_id}' rejected malformed arguments: "
                f"{error.message}.{hint_text}"
            ),
            success=False,
            tool_input=visible_tool_arguments,
            error_code=CMP_LOOP_TOOL_INPUT_VALIDATION,
            metadata={
                "validation_error": error.message,
                "required_keys": repair_hints["required_keys"],
                "minimal_valid_arguments": repair_hints["minimal_valid_arguments"],
            },
            call_id=call.call_id,
        )
    return None


# ---------------------------------------------------------------------------
# approval_if_needed
# ---------------------------------------------------------------------------


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
) -> ApprovalRequest | None:
    # NOTE: this scan is per-call independent (every check reads only `call`),
    # a property tool_loop_recovery.approval_with_recovery relies on to
    # evaluate calls one at a time and attribute failures to the exact
    # offending call. Keep new checks per-call.
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
        entry = tool_contract.entry(call.tool_id) if tool_contract is not None else None
        if entry is not None and not entry.available:
            continue
        descriptor = (
            entry.descriptor
            if entry is not None
            else kernel._mcp_client.tool_descriptor(call.tool_id)
        )
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
        if descriptor.name == "run_command" and not kernel._config.tools_shell_enabled:
            raise ToolExecutionFailure(
                code=CMP_TOOL_DISABLED,
                message="shell tool is disabled by configuration",
                retryable=False,
            )
        call_side_effecting = _tool_actions.effective_side_effecting(descriptor, call.arguments)
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
        shell_classification = classify_run_command_for_approval(
            kernel,
            call,
            descriptor_name=descriptor.name,
        )
        paranoid_mode = _is_paranoid_safety_mode(kernel._config)
        if shell_classification is not None:
            if shell_classification.verdict is CommandVerdict.BLOCKED:
                raise ToolExecutionFailure(
                    code=CMP_TOOL_COMMAND_BLOCKED,
                    message=(
                        f"command blocked by security classifier: {shell_classification.reason}"
                    ),
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
        plan_mode_only = bool(
            getattr(getattr(descriptor, "availability", None), "plan_mode_only", False)
        )
        # Python is resource-contained but deliberately not a filesystem or
        # network sandbox. Every initial Python execution remains approval-
        # gated, even for a one-send auto-run grant or an AUTO policy rule.
        if descriptor.name == "python_execute" and not approvals_pre_granted:
            return _route_policy_runtime.build_approval_request(
                ApprovalRequest_, call, descriptor,
                mode=mode,
                reason="Python execution always requires approval.",
                policy_decision=policy_decision,
            )
        # Raw shell rm always asks; typed equivalents must too, or auto_run
        # could route around the file-safety gate.
        if descriptor.name in _ALWAYS_ASK_DESTRUCTIVE_TOOLS and not approvals_pre_granted:
            return _route_policy_runtime.build_approval_request(
                ApprovalRequest_, call, descriptor,
                mode=mode,
                reason=_route_policy_runtime.destructive_tool_approval_reason(
                    descriptor.name, call.arguments,
                ),
                # The UI must not offer to persist an always-allow rule this gate never honours.
                policy_decision=None,
            )
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
            continue
        # An AUTO policy decision reflects explicit user intent for this tool
        # (the one-send auto-run grant or per-tool "Always allow" — run_command's
        # built-in default is `ask`), so it also covers the shell classifier's
        # NEEDS_APPROVAL verdict. BLOCKED commands were already rejected above
        # and paranoid mode still prompts.
        if (
            policy_decision is not None
            and policy_decision.decision == POLICY_DECISION_AUTO
            and not paranoid_mode
        ):
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


def filter_tool_calls_by_policy(
    kernel: Any,
    calls: tuple[ToolCallRequest, ...],
    *,
    mode: str,
    mode_allows_side_effecting: bool,
    resolution_context: Any | None,
    tool_contract: Any | None = None,
    plan_mode: bool = False,
    read_only: bool = False,
    request_disabled_tools: frozenset[str] = frozenset(),
) -> ToolPolicyFilterResult:
    return _filter_tool_calls_by_policy(
        kernel,
        calls,
        ToolPolicyFilterContext(
            mode=mode,
            mode_allows_side_effecting=mode_allows_side_effecting,
            resolution_context=resolution_context,
            tool_contract=tool_contract,
            plan_mode=plan_mode,
            read_only=read_only,
            request_disabled_tools=request_disabled_tools,
        ),
    )


# ---------------------------------------------------------------------------
# classify_run_command_for_approval
# ---------------------------------------------------------------------------


def classify_run_command_for_approval(
    kernel: Any,
    call: ToolCallRequest,
    *,
    descriptor_name: str,
) -> Any | None:
    if not is_feature_flag_enabled(kernel._config.feature_flags or {}, FEATURE_SHELL_SECURITY):
        return None
    raw_command = _shell_security.shell_command_for_tool(descriptor_name, call.arguments)
    if raw_command is None:
        return None
    return classify_command(
        raw_command,
        powershell=_shell_security.shell_command_uses_powershell(
            descriptor_name,
            call.arguments,
        ),
    )


# ---------------------------------------------------------------------------
# assert_valid_tool_call  (formerly @staticmethod)
# ---------------------------------------------------------------------------


def assert_valid_tool_call(call: ToolCallRequest) -> None:
    if not call.tool_id.strip():
        raise ToolExecutionFailure(
            code=CMP_LOOP_INVALID_TOOL_CALL,
            message="model returned a tool call without a tool_id",
            retryable=False,
        )
    if not isinstance(call.arguments, dict):
        raise ToolExecutionFailure(
            code=CMP_LOOP_INVALID_TOOL_CALL,
            message=f"tool '{call.tool_id}' arguments must be an object",
            retryable=False,
        )


def _merge_result_metadata(
    base_metadata: dict[str, object],
    audit_metadata: dict[str, object] | None,
) -> dict[str, object]:
    metadata = dict(base_metadata)
    if audit_metadata:
        metadata.update(dict(audit_metadata))
    return metadata


# ---------------------------------------------------------------------------
# execute_tool
# ---------------------------------------------------------------------------


# Error-code prefixes the renderer's chat-error-recovery `classifyAssistantError`
# (services/backend/chat-error-recovery.js) routes to the recoverable *tool*
# class. A tool failure must carry one of these so it never lands in the generic
# `unknown` ("Turn failed") bucket that has no actionable recovery.
_TOOL_RECOVERABLE_CODE_PREFIXES = ("CMP-TOOL-", "CMP-MCP-", "CMP-WEB-", "CMP-TSRCH-")


def _coerce_tool_failure_code(code: Any) -> str:
    """Guarantee a tool-recoverable error code on a tool execution failure.

    A tool failure must reach the renderer with a code the chat-error recovery
    layer routes to the *tool* class (retry / diagnostics), not the generic
    ``unknown`` bucket. Runtime MCP servers and the Electron tool bridge can pass
    an arbitrary, empty, or wrong-domain ``code`` through ``MCPError``; only a
    well-formed upper-case code in a tool-recoverable family (CMP-TOOL-/MCP-/WEB-
    /TSRCH-, e.g. ``CMP-MCP-0004``) is preserved for its diagnostics. Anything
    else is defaulted to ``CMP_TOOL_EXECUTION_FAILED`` (CMP-TOOL-0008).
    """
    text = str(code or "").strip()
    if text == text.upper() and text.startswith(_TOOL_RECOVERABLE_CODE_PREFIXES):
        return text
    return CMP_TOOL_EXECUTION_FAILED


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
    except Exception:
        pass
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
) -> ToolExecutionOutcome:
    cancel_handle = getattr(runtime, "cancel_handle", None)
    if runtime is not None:
        runtime.raise_if_interrupted()
        runtime.audit(
            KIND_TOOL_EXECUTION_STARTED,
            tool_call_id=str(call.call_id or ""),
            tool_name=str(call.tool_id or ""),
            summary=f"tool_execution_started {call.tool_id}",
        )
    mod = _router()
    ToolExecutionOutcome_ = mod.ToolExecutionOutcome
    request_context = getattr(runtime, "request_context", None)

    frozen_inputs = freeze_effective_execution_inputs(
        kernel,
        call,
        session_id=session_id,
        read_snapshot_cache=read_snapshot_cache,
        tool_contract=tool_contract,
        plan_mode=bool(getattr(request_context, "plan_mode", False)),
        read_only=bool(getattr(request_context, "read_only", False)),
        approved_plan=getattr(request_context, "approved_plan", None),
        trusted_plan_artifact_write=trusted_plan_artifact_write,
        turn_id=request_id,
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
            root=getattr(getattr(kernel, "_config", None), "tools_workspace_root", None),
        ),
    )
    entry = tool_contract.entry(call.tool_id) if tool_contract is not None else None
    if entry is not None and not entry.available:
        return ToolExecutionOutcome_(
            tool_name=call.tool_id,
            output=blocked_tool_message(call.tool_id, entry.reason),
            success=False,
            tool_input=visible_tool_arguments,
            error_code=blocked_tool_error_code(entry.reason),
            metadata=blocked_tool_metadata(entry.reason),
            call_id=call.call_id,
        )
    descriptor = (
        entry.descriptor if entry is not None else kernel._mcp_client.tool_descriptor(call.tool_id)
    )
    # Delegate validation normalizes aliases and isolates malformed array items.
    if call.tool_id == "delegate":
        validation_outcome = _delegate.delegate_validation_outcome(
            kernel=kernel,
            call=call,
            descriptor=descriptor,
            visible_tool_arguments=visible_tool_arguments,
            request_id=request_id,
            outcome_type=ToolExecutionOutcome_,
            increment_counter=increment_counter_for_kernel,
        )
        if validation_outcome is not None:
            return validation_outcome
    else:
        validation_outcome = _descriptor_validation_outcome(
            kernel=kernel,
            call=call,
            descriptor=descriptor,
            visible_tool_arguments=visible_tool_arguments,
            request_id=request_id,
            outcome_type=ToolExecutionOutcome_,
        )
        if validation_outcome is not None:
            return validation_outcome
    tool_arguments = dict(frozen_inputs.effective_tool_arguments)
    plan_artifact_write = (
        tool_arguments.pop(_plan_artifact_policy.PLAN_ARTIFACT_WRITE_ARG, None) is True
    )
    if call.tool_id == "mermaid_generate" and plan_artifact_write:
        tool_arguments["_jenny_read_only"] = False
    if call.tool_id == "monitor":
        return _execute_monitor_tool(
            kernel=kernel,
            call=call,
            tool_arguments=tool_arguments,
            visible_tool_arguments=visible_tool_arguments,
            request_id=request_id,
            session_id=session_id,
            audit_metadata=audit_metadata,
            runtime=runtime,
            outcome_type=ToolExecutionOutcome_,
        )
    if call.tool_id == "check_monitor":
        return _execute_check_monitor_tool(
            kernel=kernel,
            call=call,
            tool_arguments=tool_arguments,
            visible_tool_arguments=visible_tool_arguments,
            audit_metadata=audit_metadata,
            runtime=runtime,
            outcome_type=ToolExecutionOutcome_,
        )
    if call.tool_id == "delegate":
        return _execute_delegate_synthetic_tool(
            kernel=kernel,
            call=call,
            tool_arguments=tool_arguments,
            visible_tool_arguments=visible_tool_arguments,
            audit_metadata=audit_metadata,
            runtime=runtime,
            outcome_type=ToolExecutionOutcome_,
        )
    try:
        # Electron-bridge tools already carry trace_id as a first-class request
        # field; a stray _jenny_* argument key would cross the IPC wire contract.
        if getattr(descriptor, "server_name", "") != "electron_tool_bridge":
            tool_arguments = inject_dispatch_trace_id(
                tool_arguments,
                descriptor=descriptor,
                runtime=runtime,
                call=call,
            )
            tool_arguments = inject_idempotency_key(
                tool_arguments,
                descriptor=descriptor,
                runtime=runtime,
                call=call,
            )
        timeout_seconds = _tool_timeout_for_runtime(kernel, runtime, call)
        # See tool_execution_ask_user_wait for the approval-parity rationale:
        # a human-answer wait must not burn the turn's working-time budget.
        wait_started_at = _ask_user_wait.ask_user_wait_started_at(runtime, call)
        try:
            if call.tool_id == "connections_list":
                tool_arguments["_jenny_session_offline_lockdown"] = (
                    getattr(request_context, "session_offline_lockdown", False) is True
                )
            result = _dispatch_tool_call(
                kernel=kernel,
                call=call,
                tool_arguments=tool_arguments,
                descriptor=descriptor,
                request_id=request_id,
                session_id=session_id,
                runtime=runtime,
                timeout_seconds=timeout_seconds,
                cancel_handle=cancel_handle,
                on_output_chunk=_build_output_chunk_emitter(runtime, call),
            )
        finally:
            _ask_user_wait.credit_ask_user_wait(runtime, wait_started_at)
        # NO post-dispatch interruption check here. Once ``_dispatch_tool_call``
        # returns, the tool's effect is already committed; raising
        # ``TerminalChatStateError`` at this point would skip the whole
        # outcome-construction block below and report a COMMITTED tool as a
        # retryable interruption (CMP-LOOP-0013). The pre-dispatch guard above
        # still refuses to start work after cancellation, and the sole caller
        # (``execute_tool_calls_sequentially``) observes interruption only after
        # the completed result has been appended and its ``tool.result`` emitted.
    except MCPError as error:
        # Runtime MCP servers / the Electron bridge may surface a blank or
        # non-`CMP-` code; normalise to a `CMP-TOOL-*` subcode so the failure
        # never reaches the chat error path uncoded (which would classify as
        # `unknown` instead of a recoverable tool failure).
        failure_code = _coerce_tool_failure_code(error.code)
        log_event(
            logger,
            logging.WARNING,
            component="ai.router",
            event="ai.router.tool_call_failed",
            message=f"MCP tool call failed: {call.tool_id}",
            status="failure",
            data={
                "tool": call.tool_id,
                "code": failure_code,
                "mcp_code": str(error.code or ""),
                "error_message": error.message,
                "request_id": request_id,
                **error.to_metadata(),
            },
        )
        if runtime is not None:
            runtime.audit(
                KIND_TOOL_EXECUTION_FAILED,
                tool_call_id=str(call.call_id or ""),
                tool_name=str(call.tool_id or ""),
                error_code=failure_code,
                summary=f"tool_execution_failed {call.tool_id}",
            )
        raise ToolExecutionFailure(
            code=failure_code,
            message=error.message,
            retryable=error.retryable,
            error_details=error.to_metadata(),
        ) from error
    except (TerminalChatStateError, ToolExecutionFailure):
        raise
    except Exception as error:
        log_event(
            logger,
            logging.WARNING,
            component="ai.router",
            event="ai.router.tool_call_failed",
            message=f"MCP tool call raised unexpected exception: {call.tool_id}",
            status="failure",
            data={
                "tool": call.tool_id,
                "code": CMP_TOOL_EXECUTION_FAILED,
                "error_type": type(error).__name__,
                "error_message": str(error),
                "request_id": request_id,
            },
        )
        if runtime is not None:
            runtime.audit(
                KIND_TOOL_EXECUTION_FAILED,
                tool_call_id=str(call.call_id or ""),
                tool_name=str(call.tool_id or ""),
                error_code=CMP_TOOL_EXECUTION_FAILED,
                summary=f"tool_execution_failed {call.tool_id}",
            )
        raise ToolExecutionFailure(
            code=CMP_TOOL_EXECUTION_FAILED,
            message=f"tool '{call.tool_id}' execution failed: {error}",
            retryable=True,
        ) from error

    result_tool_name = str(result.tool_name or call.tool_id or "")
    sanitized_output, router_output_truncated = bounded_tool_output(
        result.output,
        tool_name=result_tool_name,
        max_chars=MAX_RESPONSE_CHARS,
    )
    metadata = _merge_result_metadata(result.metadata, audit_metadata)
    if call.tool_id == "read_file":
        snapshot = metadata.get("read_snapshot")
        scope = snapshot.get("scope") if isinstance(snapshot, dict) else None
        metadata.setdefault("snapshot_scope", scope)
        metadata.setdefault("write_eligible", bool(scope == "full"))
        metadata.setdefault("content_display_truncated", False)
    if router_output_truncated:
        metadata["router_output_truncated"] = True
        metadata["router_output_limit_chars"] = MAX_RESPONSE_CHARS
        if call.tool_id == "read_file" and metadata.get("snapshot_scope") == "full":
            metadata["content_display_truncated"] = True
    # WIDE-019 fail-closed admission: only builtin read_file/python_execute
    # results may carry typed attachments; anything else (external MCP,
    # electron bridge, spoofed payloads) is stripped here. Attachment-shaped
    # payloads smuggled through metadata are stripped unconditionally — the
    # typed field is the only channel.
    metadata = strip_attachment_shaped_metadata(metadata)
    admitted_attachments = admit_trusted_attachments(
        attachments=getattr(result, "trusted_attachments", ()) or (),
        tool_id=str(call.tool_id or ""),
        source_kind=str(getattr(descriptor, "source_kind", "") or "") if descriptor else "",
    )

    if runtime is not None:
        outcome_kind = (
            KIND_TOOL_EXECUTION_OBSERVED if result.success else KIND_TOOL_EXECUTION_FAILED
        )
        runtime.audit(
            outcome_kind,
            tool_call_id=str(call.call_id or ""),
            tool_name=str(result.tool_name or call.tool_id or ""),
            error_code=None if result.success else (str(result.error_code or "") or None),
            summary=f"{outcome_kind} {result.tool_name}",
        )
    return ToolExecutionOutcome_(
        tool_name=result.tool_name,
        output=sanitized_output,
        success=result.success,
        tool_input=visible_tool_arguments,
        content_type=result.content_type,
        ui_payload=result.ui_payload,
        generated_artifacts=tuple(dict(item) for item in result.generated_artifacts),
        error_code=result.error_code,
        metadata=metadata,
        call_id=call.call_id,
        trusted_attachments=admitted_attachments,
    )
