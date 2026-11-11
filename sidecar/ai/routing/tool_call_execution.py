"""Canonical sequential tool-call preflight and execution.

This module owns the request-contract checks that must run immediately before
tool dispatch and the single in-order execution path shared by live turns and
approval resumes.  Tool calls are never reordered or executed concurrently.
The pre-dispatch filter lives in ``tool_call_prefilter`` and the settlement of
admitted-but-unrun calls in ``tool_call_settlement``; both are re-exported here.
"""

from __future__ import annotations

import logging
from functools import partial
from typing import Any

from sidecar.ai.error_codes import (
    CMP_TOOL_OUTSIDE_WORKSPACE,
    CMP_TOOL_PAUSED_UNATTENDED,
    CMP_TOOL_POLICY_DENIED,
)
from sidecar.ai.routing import loop_event_emit, route_policy_runtime
from sidecar.ai.routing import router as _router
from sidecar.ai.routing import tool_resource_deferral as _tool_resource_deferral
from sidecar.ai.routing import tool_restored_inputs as _tool_restored_inputs
from sidecar.ai.routing.tool_call_prefilter import (
    _blocked_outcome,
    _preparation_blocked,
    pre_filter_tool_calls,
    preparation_refusal,
)
from sidecar.ai.routing.tool_call_settlement import (
    settle_after_turn_boundary,
    settle_app_refused_call,
    settle_dropped_tool_calls,
)
from sidecar.ai.routing.tool_resolution import contract_entry_for_call
from sidecar.ai.tools import assembly as _tool_assembly
from sidecar.ai.tools import contracts as _tool_contracts
from sidecar.ai.tools import sanitization as _sanitization
from sidecar.ai.tools import schema_examples as _tools_schema_examples
from sidecar.ai.tools.failure_taxonomy import classify as _classify_failure
from sidecar.ai.tools.failure_taxonomy import failure_log_level
from sidecar.ai.tools.policy import tool_policy_call_key
from sidecar.ai.tools.tool_actions import effective_side_effecting
from sidecar.runtime import tool_execution_support as _tool_support
from sidecar.runtime.diagnostics import log_event
from sidecar.runtime.turn_state import current_live_run_mode_state

logger = logging.getLogger(__name__)
TOOL_NOT_EXPOSED_REASON = _tool_assembly.TOOL_NOT_EXPOSED_REASON
TOOL_SEARCH_TOOL_NAME = _tool_assembly.TOOL_SEARCH_TOOL_NAME
# FG-009: appended to a Plan-mode outside-root refusal so the model plans the
# read instead of hunting for access it cannot get before approval.
PLAN_MODE_OUTSIDE_ROOT_HINT = (
    "In Plan mode files outside the workspace cannot be read; plan to read them "
    "in the build step after the user approves (Build it)."
)
# 2026-10-31 session review: outside the Plan case the bare refusal left the model
# probing other tools (glob, git_diff cwd, run_command cwd) at the same path.
OUTSIDE_ROOT_HINT = (
    "File tools only reach this chat's project folder. For another git worktree of "
    "this repository, run_command with git -C <path> can read it where commands are "
    "allowed (it asks first); otherwise ask the user to open that folder as its own project."
)


def _sentence(text: str) -> str:
    text = text.strip()
    return text if not text or text.endswith((".", "!", "?")) else f"{text}."


def _outside_root_hint(error_code: str, request_context: Any | None) -> str:
    if error_code != CMP_TOOL_OUTSIDE_WORKSPACE or request_context is None:
        return ""
    live_run_mode = current_live_run_mode_state()
    plan_read_only = (
        getattr(request_context, "plan_mode", False) is True
        and getattr(request_context, "read_only", False) is True
        and (live_run_mode is None or live_run_mode.snapshot()[1])
    )
    return f" {PLAN_MODE_OUTSIDE_ROOT_HINT if plan_read_only else OUTSIDE_ROOT_HINT}"


def should_pause_for_live_prompt(
    kernel: Any,
    call: Any,
    *,
    approvals_pre_granted: bool,
    scan_approval_mode: str | None,
    tool_contract: Any | None = None,
) -> bool:
    live_run_mode = current_live_run_mode_state()
    if live_run_mode is None or live_run_mode.snapshot()[0] != "prompt":
        return False
    if (
        not live_run_mode.is_paused_unattended()
        and (scan_approval_mode != "auto_run" or approvals_pre_granted)
    ):
        return False
    if call.tool_id == TOOL_SEARCH_TOOL_NAME:
        return False
    # The contract entry first: Electron-owned tools (worktree_*, session_message,
    # home, task_board, propose_*) have no client descriptor, so the unattended
    # pause never fired for them (tool review C2 #2).
    _entry, descriptor = contract_entry_for_call(kernel, tool_contract, call.tool_id)
    return descriptor is not None and effective_side_effecting(descriptor, call.arguments) is True


def _failure_review_metadata(error: object) -> dict[str, object]:
    """Row 34: only the review keys of a failure's user-only result metadata."""
    carried = getattr(error, "result_metadata", None)
    if not isinstance(carried, dict):
        return {}
    return {
        key: carried[key]
        for key in _tool_contracts.TOOL_FAILURE_RESULT_METADATA_KEYS
        if key in carried
    }


def execute_tool_calls_sequentially(  # noqa: C901, PLR0912, PLR0913, PLR0915
    *,
    indexed_calls: list[tuple[Any, int]],
    runtime: Any,
    kernel: Any,
    result: Any,
    request_id: str,
    session_id: str | None,
    tool_resolution_context: Any | None,
    read_snapshot_cache: dict[str, Any],
    outcomes: list[Any],
    working_messages: list[dict[str, object]],
    iteration_calls: list[Any],
    streamed_event_types: set[str],
    tool_payload_ref: list[dict[str, Any]],
    tool_preferences: dict[str, tuple[str, ...]] | None = None,
    request_context: Any | None = None,
    tool_contract: Any | None = None,
    trusted_plan_artifact_write_call_ids: frozenset[str] = frozenset(),
    audit_metadata_by_call: dict[str, dict[str, object]] | None = None,
    approvals_pre_granted: bool = False,
    scan_approval_mode: str | None = None,
    allow_resource_deferral: bool = False,
    on_resource_deferral: Any = None,
    restored_first_input: _tool_restored_inputs.RestoredToolInputs | None = None,
) -> _router.TurnBoundary | None:
    """Execute calls once, in model order, preserving every completed outcome.

    Returns the end-of-turn boundary when a successful ``propose_session`` /
    ``complete_session_handoff`` outcome raised one: the unstarted rest of the
    batch is settled as not executed and the caller must end the turn without
    another model generation. Every other batch returns ``None``.
    """
    if restored_first_input is not None and (
        not indexed_calls or indexed_calls[0][0].tool_id == TOOL_SEARCH_TOOL_NAME
    ):
        raise _tool_restored_inputs.RestoredToolInputError(
            "restored_tool_input_has_no_dispatch_target"
        )
    outcomes_at_entry = len(outcomes)
    for call_position, (call, outcome_index) in enumerate(indexed_calls):
        runtime.raise_if_interrupted()
        call_id = str(call.call_id or "").strip()
        dispatch_ready = False

        def _mark_dispatch_ready(
            *, _call: Any = call, _outcome_index: int = outcome_index
        ) -> None:
            nonlocal call_id, dispatch_ready
            if dispatch_ready:
                return
            call_id = loop_event_emit.emit_tool_executing(
                runtime, _call, request_id, _outcome_index
            )
            if runtime.streaming:
                streamed_event_types.add("tool.executing")
            dispatch_ready = True

        try:
            if should_pause_for_live_prompt(
                kernel,
                call,
                approvals_pre_granted=approvals_pre_granted,
                scan_approval_mode=scan_approval_mode,
                tool_contract=tool_contract,
            ):
                message = (
                    f"Tool '{call.tool_id}' was not executed: auto run was paused because "
                    "the user stepped away. Re-issue the call; it will ask for approval."
                )
                log_event(
                    logger,
                    logging.INFO,
                    component="ai.router",
                    event="ai.router.tool_dispatch_paused_unattended",
                    message=message,
                    data={"tool": call.tool_id, "code": CMP_TOOL_PAUSED_UNATTENDED},
                    request_id=request_id,
                    session_id=session_id,
                )
                raise _tool_contracts.ToolExecutionFailure(
                    code=CMP_TOOL_PAUSED_UNATTENDED,
                    message=message,
                    retryable=True,
                )
            if call.tool_id == TOOL_SEARCH_TOOL_NAME:
                kernel_config = getattr(kernel, "_config", None)
                tool_result = _preparation_blocked(call, request_context)
                if tool_result is not None:
                    pass  # a preparation turn never searches (resume callers skip the pre-filter)
                elif route_policy_runtime.hosted_tool_search_denied(kernel_config):
                    tool_result = _blocked_outcome(
                        call,
                        output=(
                            "Tool 'tool_search' is unavailable in the hosted "
                            "execution policy."
                        ),
                        error_code=CMP_TOOL_POLICY_DENIED,
                        metadata={"host_policy_denied": True},
                    )
                else:
                    _mark_dispatch_ready()
                    tool_result = kernel._execute_tool_search(
                        call,
                        resolution_context=tool_resolution_context,
                        runtime=runtime,
                    )
                    tool_payload_ref[:] = kernel._build_tool_payload(
                        tool_resolution_context,
                        tool_preferences=tool_preferences,
                        request_context=request_context,
                    )
                    if runtime.remaining_tool_calls == 0:
                        tool_payload_ref.clear()
            else:
                trusted_execution_kwargs: dict[str, Any] = {}
                if call.tool_id == "ask_user":
                    # Runtime assembly imports this dispatcher; defer the reverse dependency.
                    from sidecar.runtime.decision_checkpoint import (
                        prepare_question_decision,
                    )
                    trusted_execution_kwargs["on_frozen_input"] = partial(
                        prepare_question_decision, runtime=runtime, request_context=request_context,
                        config=kernel._config,
                        tool_contract=tool_contract,
                        pending_calls=tuple(item for item, _ in indexed_calls[call_position:]),
                        completed_outcomes=tuple(outcomes),
                    )
                if call_position == 0 and restored_first_input is not None:
                    trusted_execution_kwargs["restored_inputs"] = restored_first_input
                if call.tool_id in {"propose_change", "recall_tool_output"}:
                    # Plan Plus: the overlap and batch rules see this request's
                    # earlier suggestions (router-injected, never model-supplied).
                    trusted_execution_kwargs["request_outcomes"] = tuple(outcomes)
                if (
                    tool_policy_call_key(call)
                    in trusted_plan_artifact_write_call_ids
                ):
                    trusted_execution_kwargs["trusted_plan_artifact_write"] = True
                tool_result = kernel._execute_tool(
                    call,
                    request_id=request_id,
                    session_id=session_id,
                    read_snapshot_cache=read_snapshot_cache,
                    tool_contract=tool_contract,
                    audit_metadata=(audit_metadata_by_call or {}).get(
                        tool_policy_call_key(call)
                    ),
                    runtime=runtime,
                    on_dispatch_ready=_mark_dispatch_ready,
                    **trusted_execution_kwargs,
                )
        except (
            _tool_resource_deferral.ToolResourceDeferred, _tool_contracts.ToolExecutionFailure
        ) as error:
            if isinstance(error, _tool_resource_deferral.ToolResourceDeferred):
                if not dispatch_ready and callable(on_resource_deferral):
                    on_resource_deferral(
                        error, tuple(item for item, _ in indexed_calls[call_position:]))
                if (
                    allow_resource_deferral
                    and call_position == 0
                    and len(outcomes) == outcomes_at_entry
                    and not dispatch_ready
                ):
                    raise
                exc = _tool_resource_deferral.resource_wait_failure(error.wait)
            else:
                exc = error
            failure_metadata: dict[str, object] = {
                key: value for key, value in exc.to_error_data().items()
            }
            failure_metadata.update(_failure_review_metadata(exc))
            # The outcome carries no retryable flag: settle the class while the failure does.
            failure_metadata.setdefault("failure_class", _classify_failure(
                exc.code, retryable=exc.retryable, error_details=failure_metadata))
            # HB-017: the failure text keeps real paths for the model; the log does not.
            log_message = _sanitization.redact_error_paths(exc.message)
            log_event(
                logger,
                failure_log_level(exc.code, error_details=failure_metadata),
                component="ai.router",
                event="ai.router.tool_execution_recovered",
                message=log_message,
                status="recovered",
                data={
                    "tool": call.tool_id,
                    "code": exc.code,
                    "error_message": log_message,
                    "request_id": request_id,
                    "path": "sequential",
                },
                request_id=request_id,
                session_id=session_id,
            )
            failure_output = (
                f"Tool '{call.tool_id}' failed: {_sentence(exc.message)}"
                f"{_outside_root_hint(exc.code, request_context)}"
            )
            config = getattr(kernel, "_config", None)
            if getattr(config, "tool_result_envelope_enabled", False) is not True:
                failure_output += (
                    " Review the error and retry with corrected arguments if applicable."
                )
            tool_result = _blocked_outcome(
                call,
                output=failure_output,
                error_code=exc.code,
                metadata=failure_metadata,
            )

        _mark_dispatch_ready()
        outcomes.append(tool_result)
        loop_event_emit.emit_tool_result(runtime, tool_result, call_id)
        if runtime.streaming:
            streamed_event_types.add("tool.result")
        # Cancellation is observed after the completed result has been paired
        # with its executing event, so a finished tool never becomes an orphan.
        runtime.raise_if_interrupted()

        kernel._update_read_snapshot_cache(
            read_snapshot_cache,
            tool_name=tool_result.tool_name,
            success=tool_result.success,
            metadata=tool_result.metadata,
            execution_context=getattr(
                getattr(runtime, "request_context", None), "execution_context", None
            ),
        )
        working_messages.append(kernel._assistant_tool_call_message(result, call))
        working_messages.append(kernel._tool_result_message(call, tool_result))
        iteration_calls.append(call)
        boundary = _router.detect_turn_boundary(tool_result)
        if boundary is not None:
            settle_after_turn_boundary(
                kernel=kernel, runtime=runtime, result=result, request_id=request_id,
                session_id=session_id, boundary=boundary,
                unstarted_calls=indexed_calls[call_position + 1:], outcomes=outcomes,
                working_messages=working_messages, iteration_calls=iteration_calls,
                streamed_event_types=streamed_event_types,
            )
            return boundary
    return None


def prevalidate_call_arguments(
    *,
    kernel: Any,
    call: Any,
    tool_contract: Any | None,
) -> dict[str, Any] | None:
    """Schema-validate a call BEFORE the approval gate.

    Dispatch validates too, but dispatch runs AFTER the user has already
    answered the approval prompt. For an ordinary tool that only wastes a
    click; for ``exit_plan_mode`` it stranded a live turn -- the user approved a
    plan and the very same arguments were then rejected, discarding the
    proposal they had just accepted. Returning the failure here lets the caller
    record a recoverable per-call outcome, carrying the same repair hints
    dispatch would have produced, without ever interrupting the user.

    Returns ``None`` when the call is valid or not ours to validate.
    ``delegate`` is exempt: its own validator normalizes aliases that the raw
    schema would reject.
    """
    if call.tool_id == "delegate":
        return None
    entry, descriptor = contract_entry_for_call(kernel, tool_contract, call.tool_id)
    if entry is not None and not entry.available:
        return None
    if descriptor is None or (
        call.coerced and not effective_side_effecting(descriptor, call.arguments)
    ):
        return None
    try:
        _tool_support.validate_tool_arguments(
            tool_name=call.tool_id,
            arguments=call.arguments,
            input_schema=descriptor.input_schema,
            prune_empty_optional_arrays=_tool_contracts.executor_prunes_empty_optional_arrays(
                descriptor
            ),
        )
    except _tool_contracts.ToolExecutionFailure as error:
        repair_hints = _tools_schema_examples.tool_schema_repair_hints(
            _tool_assembly.model_facing_parameters(descriptor)
        )
        return {
            "message": (
                f"Tool '{call.tool_id}' rejected malformed arguments: "
                f"{_sentence(_tool_contracts.validation_detail(error.message))}"
                f"{_tools_schema_examples.tool_schema_hint_text(repair_hints)}"
            ),
            "metadata": {
                "validation_error": error.message,
                "required_keys": repair_hints["required_keys"],
                "minimal_valid_arguments": repair_hints["minimal_valid_arguments"],
            },
        }
    return _launcher_refusal(descriptor, call.arguments)


def _launcher_refusal(descriptor: Any, arguments: Any) -> dict[str, Any] | None:
    """Refuse a command the sidecar's shell would silently truncate (HB-013).

    Runs with the schema prevalidation, before the approval gate and before
    any runtime operation is admitted or resource lease acquired, so the
    refusal leaves nothing to settle. Bridge-owned ``run_command`` (desktop
    sandbox, hosted worker) runs POSIX ``/bin/sh`` and keeps every line.
    """
    if (
        getattr(descriptor, "name", "") != "run_command"
        or getattr(descriptor, "server_name", "") == "electron_tool_bridge"
        or not isinstance(arguments, dict)
        or not isinstance(arguments.get("command"), str)
    ):
        return None
    refusal = _tool_support.cmd_exe_multiline_refusal(arguments["command"])
    if refusal is None:
        return None
    return {
        "message": (
            f"Tool 'run_command' was not executed: {refusal} "
            "Adjust the arguments or choose a different approach, then continue."
        ),
        # The fix is a one-line command, not a permission the user could grant,
        # so the envelope must not read "denied: do not retry" (HB-039).
        "metadata": {
            "pre_dispatch_blocked": True,
            "refusal": "cmd_exe_multiline_command",
            "failure_class": "bad_arguments",
            "effects": "none",
        },
        "error_code": _tool_support.CMP_TOOL_COMMAND_BLOCKED,
    }


__all__ = [
    "execute_tool_calls_sequentially", "pre_filter_tool_calls", "preparation_refusal",
    "prevalidate_call_arguments", "settle_after_turn_boundary", "settle_app_refused_call",
    "settle_dropped_tool_calls",
    "should_pause_for_live_prompt",
]
