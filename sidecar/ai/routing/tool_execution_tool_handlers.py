"""Synthetic and builtin tool handlers.

``_tool_timeout_for_runtime`` and ``_merge_result_metadata`` remain hub-owned.
Imports of ``tool_execution`` must stay function-local to avoid the hub's
circular import.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from sidecar.ai.error_codes import (
    CMP_TOOL_BACKGROUND_NOT_FOUND,
    CMP_TOOL_EXECUTION_FAILED,
)
from sidecar.ai.routing import harness_helpers as _harness_helpers
from sidecar.ai.routing import tool_observation as _tool_observation
from sidecar.ai.tools.trusted_attachments import strip_attachment_shaped_metadata
from sidecar.runtime.tool_execution_support import (
    ToolCallRequest,
    ToolExecutionFailure,
    handle_tool_search,
    sanitize_tool_output,
)

if TYPE_CHECKING:
    from sidecar.runtime.tool_execution_support import ToolExecutionOutcome

MAX_RESPONSE_CHARS = _harness_helpers.MAX_RESPONSE_CHARS
KIND_TOOL_EXECUTION_FAILED = _tool_observation.KIND_TOOL_EXECUTION_FAILED
KIND_TOOL_EXECUTION_OBSERVED = _tool_observation.KIND_TOOL_EXECUTION_OBSERVED

def _execute_monitor_tool(
    *,
    kernel: Any,
    call: ToolCallRequest,
    tool_arguments: dict[str, object],
    visible_tool_arguments: dict[str, object],
    request_id: str,
    session_id: str | None,
    audit_metadata: dict[str, object] | None,
    runtime: Any | None,
    outcome_type: Any,
) -> ToolExecutionOutcome:
    from sidecar.ai.routing import tool_execution as _te_hub

    _merge_result_metadata = _te_hub._merge_result_metadata
    manager = getattr(kernel, "_monitor_manager", None)
    if manager is None:
        raise ToolExecutionFailure(
            code=CMP_TOOL_EXECUTION_FAILED,
            message="monitor runtime is unavailable",
            retryable=True,
        )
    config = getattr(kernel, "_config", None)
    workspace_root = (
        getattr(config, "tools_workspace_root", None)
        or getattr(config, "agent_workspace_root", None)
    )
    result = manager.start_monitor(
        command=str(tool_arguments.get("command") or ""),
        description=str(tool_arguments.get("description") or ""),
        timeout_ms=tool_arguments.get("timeout_ms"),
        persistent=tool_arguments.get("persistent") is True,
        cwd=tool_arguments.get("cwd"),
        match_patterns=tool_arguments.get("match_patterns"),
        ignore_patterns=tool_arguments.get("ignore_patterns"),
        dedupe=tool_arguments.get("dedupe") is True,
        workspace_root=workspace_root,
        request_id=request_id,
        trace_id=str(getattr(runtime, "trace_id", "") or request_id),
        session_id=str(session_id or getattr(runtime, "session_id", "") or ""),
        tool_call_id=str(call.call_id or ""),
        notification_writer=getattr(runtime, "notification_writer", None),
    )
    metadata = _merge_result_metadata(result.metadata, audit_metadata)
    if runtime is not None:
        runtime.audit(
            KIND_TOOL_EXECUTION_OBSERVED,
            tool_call_id=str(call.call_id or ""),
            tool_name="monitor",
            summary="tool_execution_observed monitor",
        )
    return outcome_type(
        tool_name="monitor",
        output=sanitize_tool_output(
            result.output,
            max_chars=MAX_RESPONSE_CHARS,
            tool_name="monitor",
        ),
        success=True,
        tool_input=visible_tool_arguments,
        metadata=metadata,
        call_id=call.call_id,
    )


def _format_monitor_digest(digest: dict[str, Any]) -> str:
    state = str(digest.get("state") or "unknown")
    head = f"monitor {digest.get('monitor_id')} [{state}"
    if digest.get("terminal") and digest.get("exit_code") is not None:
        head += f", exit {digest.get('exit_code')}"
    head += "]"
    new_count = int(digest.get("new_event_count") or 0)
    summary = (
        f"{head} — {new_count} new matching event(s) since seq "
        f"{digest.get('since_sequence')} (cursor {digest.get('cursor')}); "
        f"{int(digest.get('suppressed_event_count') or 0)} suppressed, "
        f"{int(digest.get('dropped_event_count') or 0)} dropped, "
        f"{int(digest.get('event_count') or 0)} total."
    )
    lines = [summary]
    for event in digest.get("new_events") or []:
        if not isinstance(event, dict):
            continue
        stream = event.get("stream") or "stdout"
        lines.append(f"[{event.get('sequence')}] {stream}: {event.get('text') or ''}")
    if digest.get("terminal"):
        lines.append("Monitor finished.")
    elif new_count:
        lines.append(f"(poll again with since_sequence={digest.get('cursor')})")
    return "\n".join(lines)


def _execute_check_monitor_tool(
    *,
    kernel: Any,
    call: ToolCallRequest,
    tool_arguments: dict[str, object],
    visible_tool_arguments: dict[str, object],
    audit_metadata: dict[str, object] | None,
    runtime: Any | None,
    outcome_type: Any,
) -> ToolExecutionOutcome:
    from sidecar.ai.routing import tool_execution as _te_hub

    _merge_result_metadata = _te_hub._merge_result_metadata
    manager = getattr(kernel, "_monitor_manager", None)
    if manager is None:
        raise ToolExecutionFailure(
            code=CMP_TOOL_EXECUTION_FAILED,
            message="monitor runtime is unavailable",
            retryable=True,
        )
    monitor_id = str(tool_arguments.get("monitor_id") or "").strip()
    if not monitor_id:
        raise ToolExecutionFailure(
            code=CMP_TOOL_EXECUTION_FAILED,
            message="tool argument 'monitor_id' must be a non-empty string",
            retryable=False,
        )
    digest = manager.poll_monitor(
        monitor_id,
        since_sequence=tool_arguments.get("since_sequence"),
        wait_ms=tool_arguments.get("wait_ms"),
    )
    if digest.get("state") == "not_found":
        raise ToolExecutionFailure(
            code=CMP_TOOL_BACKGROUND_NOT_FOUND,
            message=f"no monitor found with id: {monitor_id}",
            retryable=False,
        )
    metadata = _merge_result_metadata({"monitor": digest}, audit_metadata)
    if runtime is not None:
        runtime.audit(
            KIND_TOOL_EXECUTION_OBSERVED,
            tool_call_id=str(call.call_id or ""),
            tool_name="check_monitor",
            summary="tool_execution_observed check_monitor",
        )
    return outcome_type(
        tool_name="check_monitor",
        output=sanitize_tool_output(
            _format_monitor_digest(digest),
            max_chars=MAX_RESPONSE_CHARS,
            tool_name="check_monitor",
        ),
        success=True,
        tool_input=visible_tool_arguments,
        metadata=metadata,
        call_id=call.call_id,
    )


def _execute_delegate_synthetic_tool(  # noqa: PLR0913 - mirrors synthetic tool dispatch.
    *,
    kernel: Any,
    call: ToolCallRequest,
    tool_arguments: dict[str, object],
    visible_tool_arguments: dict[str, object],
    audit_metadata: dict[str, object] | None,
    runtime: Any | None,
    outcome_type: Any,
) -> ToolExecutionOutcome:
    from sidecar.ai.routing import tool_execution as _te_hub

    return _execute_subagent_synthetic_tool(
        executor=_te_hub.execute_delegate_tool,
        tool_name="delegate",
        kernel=kernel,
        call=call,
        tool_arguments=tool_arguments,
        visible_tool_arguments=visible_tool_arguments,
        audit_metadata=audit_metadata,
        runtime=runtime,
        outcome_type=outcome_type,
    )


def _execute_subagent_synthetic_tool(  # noqa: PLR0913 - shared synthetic settlement fields.
    *,
    executor: Any,
    tool_name: str,
    kernel: Any,
    call: ToolCallRequest,
    tool_arguments: dict[str, object],
    visible_tool_arguments: dict[str, object],
    audit_metadata: dict[str, object] | None,
    runtime: Any | None,
    outcome_type: Any,
) -> ToolExecutionOutcome:
    from sidecar.ai.routing import tool_execution as _te_hub

    outcome = executor(
        router=kernel,
        arguments=tool_arguments,
        runtime=runtime,
        outcome_type=outcome_type,
        visible_tool_arguments=visible_tool_arguments,
        call_id=call.call_id,
    )
    outcome_metadata = _te_hub._merge_result_metadata(
        dict(outcome.metadata or {}),
        audit_metadata,
    )
    if runtime is not None:
        runtime.audit(
            KIND_TOOL_EXECUTION_OBSERVED if outcome.success else KIND_TOOL_EXECUTION_FAILED,
            tool_call_id=str(call.call_id or ""),
            tool_name=tool_name,
            error_code=None if outcome.success else (str(outcome.error_code or "") or None),
            summary=(
                f"tool_execution_observed {tool_name}"
                if outcome.success
                else f"tool_execution_failed {tool_name}"
            ),
        )
    return outcome_type(
        tool_name=outcome.tool_name,
        output=outcome.output,
        success=outcome.success,
        tool_input=visible_tool_arguments,
        content_type=outcome.content_type,
        ui_payload=outcome.ui_payload,
        generated_artifacts=tuple(dict(item) for item in outcome.generated_artifacts),
        error_code=outcome.error_code,
        metadata=outcome_metadata,
        call_id=call.call_id,
    )


def tool_outcome_from_handler_result(
    tool_name: str,
    result: Any,
    *,
    call_id: str = "",
    tool_input: dict[str, object] | None = None,
) -> ToolExecutionOutcome:
    from sidecar.ai.routing import router as _router_mod

    ToolExecutionOutcome_ = _router_mod.ToolExecutionOutcome
    # WIDE-019: this is the synthetic-tool path (tool_search, monitor digests,
    # replayed handler results). It NEVER admits typed attachments — the field
    # is deliberately left empty and attachment-shaped metadata is stripped —
    # so spoofed/synthetic attachment payloads cannot ride a synthetic result.
    return ToolExecutionOutcome_(
        tool_name=tool_name,
        output=sanitize_tool_output(
            str(result.output or ""),
            max_chars=MAX_RESPONSE_CHARS,
            tool_name=tool_name,
        ),
        success=bool(result.success),
        tool_input=dict(tool_input or {}),
        error_code=result.error_code,
        metadata=strip_attachment_shaped_metadata(dict(result.metadata or {})),
        call_id=call_id,
    )


def execute_tool_search(
    kernel: Any,
    call: ToolCallRequest,
    *,
    resolution_context: Any | None,
    runtime: Any | None = None,
) -> ToolExecutionOutcome:
    from sidecar.ai.routing import router as _router_mod

    if runtime is not None:
        runtime.raise_if_interrupted()
    ToolExecutionOutcome_ = _router_mod.ToolExecutionOutcome

    if resolution_context is None or resolution_context.search_index is None:
        return ToolExecutionOutcome_(
            tool_name=call.tool_id,
            output="Tool search is unavailable for this request.",
            success=False,
            tool_input={str(key): value for key, value in call.arguments.items()},
            call_id=call.call_id,
        )

    result = handle_tool_search(
        dict(call.arguments),
        search_index=resolution_context.search_index,
        full_schema_map=kernel._build_full_tool_schema_map(),
        un_deferred_set=resolution_context.un_deferred_names,
    )
    return tool_outcome_from_handler_result(
        call.tool_id,
        result,
        call_id=call.call_id,
        tool_input={str(key): value for key, value in call.arguments.items()},
    )
