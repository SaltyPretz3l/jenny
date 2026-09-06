"""Pure deadline, descriptor, and result-shaping helpers for the MCP client."""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any

from sidecar.ai.mcp import transport_base
from sidecar.ai.mcp.exceptions import CMP_MCP_SERVER_FAILED, MCPError
from sidecar.ai.mcp.models import MCPToolDescriptor
from sidecar.ai.mcp.tool_namespace import namespace_mcp_tool_name
from sidecar.ai.tools.catalog import (
    coerce_scalar_side_effecting,
    infer_tool_family,
    infer_tool_source_kind,
    parse_tool_actions,
)
from sidecar.ai.tools.trusted_attachments import parse_wire_attachments

# Canonical implementation lives in transport_base (a shared leaf) so the
# transports can use it without exceeding the leaf import fan-out cap.
raise_if_cancelled = transport_base.raise_if_cancelled


@dataclass(frozen=True)
class ToolCallBudget:
    deadline: float | None
    fallback_timeout_seconds: float | None
    cancel_handle: Any = None

    def remaining_timeout(self) -> float | None:
        return remaining_tool_timeout(
            self.deadline,
            self.fallback_timeout_seconds,
            cancel_handle=self.cancel_handle,
        )


def remaining_tool_timeout(
    deadline: float | None,
    fallback: float | None,
    *,
    cancel_handle: Any = None,
) -> float | None:
    raise_if_cancelled(cancel_handle)
    if deadline is None:
        return fallback
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise MCPError(
            code=CMP_MCP_SERVER_FAILED,
            message="MCP tool call timed out",
            retryable=True,
        )
    return remaining


def tool_deadline(timeout_seconds: float | None) -> float | None:
    if timeout_seconds is None:
        return None
    return time.monotonic() + max(0.0, float(timeout_seconds))


def call_transport_tool(  # noqa: PLR0913 - transport compatibility seam.
    transport: transport_base.MCPTransport,
    tool_name: str,
    arguments: dict[str, Any],
    *,
    timeout_seconds: float | None,
    cancel_handle: Any,
    on_output_chunk: Any = None,
) -> dict[str, Any]:
    kwargs: dict[str, Any] = {"timeout_seconds": timeout_seconds}
    if cancel_handle is not None:
        kwargs["cancel_handle"] = cancel_handle
    if on_output_chunk is not None:
        kwargs["on_output_chunk"] = on_output_chunk
    return transport.call_tool(tool_name, arguments, **kwargs)


def call_transport_resource(
    operation: Any,
    *args: Any,
    timeout_seconds: float | None,
    cancel_handle: Any,
    **kwargs: Any,
) -> dict[str, Any]:
    call_kwargs = {**kwargs, "timeout_seconds": timeout_seconds}
    if cancel_handle is not None:
        call_kwargs["cancel_handle"] = cancel_handle
    return operation(*args, **call_kwargs)


def descriptor_from_payload(
    server_name: str,
    payload: dict[str, Any],
) -> MCPToolDescriptor | None:
    raw_name = payload.get("name")
    if not isinstance(raw_name, str) or not raw_name.strip():
        return None
    raw_description = payload.get("description")
    description = raw_description.strip() if isinstance(raw_description, str) else ""
    input_schema = payload.get("inputSchema")
    if not isinstance(input_schema, dict):
        input_schema = payload.get("input_schema")
    if not isinstance(input_schema, dict):
        input_schema = {"type": "object", "properties": {}}
    actions = parse_tool_actions(payload.get("actions"))
    side_effecting = coerce_scalar_side_effecting(
        payload.get("side_effecting") is not False,
        actions,
    )
    server_tool_name = raw_name.strip()
    tool_name = namespace_mcp_tool_name(server_name, server_tool_name)
    return MCPToolDescriptor(
        name=tool_name,
        description=description,
        input_schema=input_schema,
        side_effecting=side_effecting,
        server_name=server_name,
        source_kind=infer_tool_source_kind(tool_name, server_name=server_name),
        tool_family=infer_tool_family(tool_name),
        server_tool_name=server_tool_name,
        actions=actions,
    )


def attach_recovery_metadata(  # noqa: PLR0913 - additive recovery evidence fields.
    metadata: dict[str, Any],
    *,
    retry_count: int,
    reconnected_server: str | None,
    prior_generation_id: str | None,
    current_generation_id: str | None,
    operation_id: str | None,
) -> None:
    metadata.update(
        {
            "mcp_recovered": True,
            "mcp_retry_count": retry_count,
            "mcp_reconnected_server": reconnected_server,
            "mcp_prior_generation_id": prior_generation_id,
            "mcp_current_generation_id": current_generation_id,
            "mcp_operation_id": operation_id,
        }
    )


def extract_tool_output(
    result_payload: dict[str, Any],
) -> dict[str, Any]:
    content = result_payload.get("content")
    if not isinstance(content, list):
        content = []

    text_parts: list[str] = []
    for block in content:
        if not isinstance(block, dict):
            continue
        block_type = block.get("type")
        if block_type != "text":
            continue
        block_text = block.get("text")
        if isinstance(block_text, str) and block_text:
            text_parts.append(block_text)

    ui_payload = result_payload.get("ui_payload")
    if not isinstance(ui_payload, dict):
        ui_payload = None
    raw_content_type = result_payload.get("content_type")
    if raw_content_type in {"text", "mcp_ui"}:
        content_type = str(raw_content_type)
    else:
        content_type = "mcp_ui" if ui_payload is not None else "text"
    success = not bool(result_payload.get("isError", False))
    success_extension = result_payload.get("success")
    if isinstance(success_extension, bool):
        success = success_extension
    raw_generated_artifacts = result_payload.get("generated_artifacts")
    generated_artifacts = (
        tuple(item for item in raw_generated_artifacts if isinstance(item, dict))
        if isinstance(raw_generated_artifacts, list)
        else ()
    )
    raw_error_code = result_payload.get("error_code")
    error_code = (
        str(raw_error_code).strip()
        if isinstance(raw_error_code, str) and str(raw_error_code).strip()
        else None
    )
    raw_metadata = result_payload.get("metadata")
    metadata: dict[str, Any] = dict(raw_metadata) if isinstance(raw_metadata, dict) else {}
    # WIDE-019: transport-level shape check only; the fail-closed admission
    # gate (builtin read_file/python_execute only) runs in tool_execution.
    trusted_attachments = parse_wire_attachments(result_payload.get("trusted_attachments"))
    output = "\n".join(text_parts).strip()
    if not output:
        output = "(no tool output)"
    return {
        "output": output,
        "content_type": content_type,
        "ui_payload": ui_payload,
        "success": success,
        "generated_artifacts": generated_artifacts,
        "error_code": error_code,
        "metadata": metadata,
        "trusted_attachments": trusted_attachments,
    }
