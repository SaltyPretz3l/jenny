"""Post-dispatch outcome shaping and audit for ``tool_execution.execute_tool``.

Pairs every ``KIND_TOOL_EXECUTION_*`` audit event with its call, turns a dispatch
exception into the coded ``ToolExecutionFailure`` the loop records, and finishes
a dispatched result into its ``ToolExecutionOutcome`` (read_file snapshot
metadata, router truncation markers, fail-closed attachment admission).
"""

from __future__ import annotations

import logging
from typing import Any

from sidecar.ai.error_codes import CMP_TOOL_EXECUTION_FAILED
from sidecar.ai.routing import tool_execution_results as _results
from sidecar.ai.routing import tool_observation as _tool_observation
from sidecar.ai.tools import sanitization as _sanitization
from sidecar.ai.tools.catalog import BUILTIN_MCP_SERVER_NAME
from sidecar.ai.tools.trusted_attachments import (
    admit_trusted_attachments,
    strip_attachment_shaped_metadata,
)
from sidecar.runtime.diagnostics import log_event
from sidecar.runtime.tool_execution_support import (
    MCPError,
    ToolCallRequest,
    ToolExecutionFailure,
)

# The hub's logger: these records keep the ``sidecar.ai.routing.tool_execution`` name.
logger = logging.getLogger("sidecar.ai.routing.tool_execution")


def audit_tool_event(
    runtime: Any | None,
    kind: str,
    call: ToolCallRequest,
    *,
    tool_name: str | None = None,
    error_code: str | None = None,
) -> None:
    """Record one KIND_TOOL_EXECUTION_* audit event for *call* (no-op without a runtime)."""
    if runtime is None:
        return
    name = str(tool_name or call.tool_id or "")
    runtime.audit(
        kind, tool_call_id=str(call.call_id or ""), tool_name=name,
        error_code=error_code, summary=f"{kind} {name}",
    )


def mcp_tool_failure(
    error: MCPError,
    *,
    call: ToolCallRequest,
    descriptor: Any,
    runtime: Any | None,
    request_id: str,
) -> ToolExecutionFailure:
    """Log, audit and code an ``MCPError`` raised by dispatch; the caller raises it."""
    # Runtime MCP servers / the Electron bridge may surface a blank or
    # non-`CMP-` code; normalise to a `CMP-TOOL-*` subcode so the failure
    # never reaches the chat error path uncoded (which would classify as
    # `unknown` instead of a recoverable tool failure).
    failure_code = _results.coerce_tool_failure_code(error.code)
    log_event(
        logger,
        _sanitization.failure_log_level(failure_code, retryable=error.retryable),
        component="ai.router",
        event="ai.router.tool_call_failed",
        message=f"MCP tool call failed: {call.tool_id}",
        status="failure",
        data={
            "tool": call.tool_id,
            "code": failure_code,
            "mcp_code": str(error.code or ""),
            # HB-017: the model keeps real paths; the log never does.
            "error_message": _sanitization.redact_error_paths(error.message),
            "request_id": request_id,
            **error.to_metadata(),
        },
    )
    audit_tool_event(
        runtime, _tool_observation.KIND_TOOL_EXECUTION_FAILED, call, error_code=failure_code
    )
    failure = ToolExecutionFailure(
        code=failure_code, message=error.message, retryable=error.retryable,
        error_details=error.to_metadata(),
    )
    # Row 34: a failed scripted call's user-only change evidence, builtin server only.
    builtin = getattr(descriptor, "server_name", "") == BUILTIN_MCP_SERVER_NAME
    if error.observed_changes and builtin:
        failure.result_metadata = dict(error.observed_changes)
    return failure


def unexpected_tool_failure(
    error: Exception,
    *,
    call: ToolCallRequest,
    runtime: Any | None,
    request_id: str,
) -> ToolExecutionFailure:
    """Log, audit and wrap a non-MCP dispatch exception; the caller raises it."""
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
    audit_tool_event(
        runtime,
        _tool_observation.KIND_TOOL_EXECUTION_FAILED,
        call,
        error_code=CMP_TOOL_EXECUTION_FAILED,
    )
    return ToolExecutionFailure(
        code=CMP_TOOL_EXECUTION_FAILED,
        message=f"tool '{call.tool_id}' execution failed: {error}",
        retryable=True,
    )


def finalize_tool_outcome(  # noqa: PLR0913 - keyword-only
    *,
    call: ToolCallRequest,
    result: Any,
    descriptor: Any,
    runtime: Any | None,
    metadata: dict[str, Any],
    sanitized_output: str,
    router_output_truncated: bool,
    max_response_chars: int,
    visible_tool_arguments: dict[str, object],
    outcome_type: Any,
) -> Any:
    """Finish a dispatched result's metadata, admit its attachments, audit, build the outcome."""
    result_tool_name = str(result.tool_name or call.tool_id or "")
    if call.tool_id == "read_file":
        snapshot = metadata.get("read_snapshot")
        scope = snapshot.get("scope") if isinstance(snapshot, dict) else None
        metadata.setdefault("snapshot_scope", scope)
        metadata.setdefault("write_eligible", bool(scope == "full"))
        metadata.setdefault("content_display_truncated", False)
    if router_output_truncated:
        metadata["router_output_truncated"] = True
        metadata["router_output_limit_chars"] = max_response_chars
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
    audit_tool_event(
        runtime,
        (
            _tool_observation.KIND_TOOL_EXECUTION_OBSERVED
            if result.success
            else _tool_observation.KIND_TOOL_EXECUTION_FAILED
        ),
        call,
        tool_name=result_tool_name,
        error_code=None if result.success else (str(result.error_code or "") or None),
    )
    return outcome_type(
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
