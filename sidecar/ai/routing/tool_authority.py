"""AI-side invocation of the runtime-injected per-operation authority callback."""

from __future__ import annotations

from typing import Any

from sidecar.ai.error_codes import CMP_TOOL_EXECUTION_FAILED
from sidecar.ai.tools.contracts import ToolExecutionFailure


def admit_scoped_tool_call(  # noqa: PLR0913
    *, runtime: Any, call: Any, descriptor: Any, tool_arguments: dict[str, Any],
    visible_arguments: dict[str, Any], builtin_server_name: str,
    timeout_seconds: float | None,
    inject_trusted_envelope: bool = True,
) -> None:
    request_context = getattr(runtime, "request_context", None)
    if getattr(request_context, "execution_context", None) is None:
        return
    admission = getattr(runtime, "operation_admission", None)
    if not callable(admission):
        raise ToolExecutionFailure(
            code=CMP_TOOL_EXECUTION_FAILED,
            message="runtime operation authority bridge is unavailable",
            retryable=False,
        )
    operation_id = str(call.call_id or "").strip()
    trusted_envelope = admission(
        operation_id=operation_id,
        tool_name=call.tool_id,
        arguments=dict(visible_arguments),
        timeout_seconds=timeout_seconds,
    )
    if not isinstance(trusted_envelope, dict) or trusted_envelope.get("schema_version") != 1:
        raise ToolExecutionFailure(
            code=CMP_TOOL_EXECUTION_FAILED,
            message="runtime operation authority response is malformed",
            retryable=False,
        )
    if inject_trusted_envelope and getattr(descriptor, "server_name", "") == builtin_server_name:
        tool_arguments["_jenny_execution_context"] = trusted_envelope
        tool_arguments["_jenny_operation_id"] = operation_id


__all__ = ["admit_scoped_tool_call"]
