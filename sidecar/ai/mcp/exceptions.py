"""Typed exceptions for MCP transport and protocol failures."""

from __future__ import annotations

import json

from sidecar.ai.error_codes import (  # noqa: F401
    CMP_MCP_CONFIG_INVALID,
    CMP_MCP_PROTOCOL_FAILED,
    CMP_MCP_RESOURCE_INVALID,
    CMP_MCP_RESOURCE_NOT_FOUND,
    CMP_MCP_RESOURCE_UNSUPPORTED,
    CMP_MCP_SERVER_FAILED,
    CMP_MCP_SSE_DISABLED,
    CMP_MCP_TOOL_NOT_FOUND,
)


class MCPError(Exception):
    def __init__(  # noqa: PLR0913 - structured transport certainty fields.
        self,
        *,
        code: str,
        message: str,
        retryable: bool = False,
        operation_id: str | None = None,
        generation_id: str | None = None,
        completion_status: str = "unknown",
        response_received: bool = False,
        resource_cleanup: object = None,
        transport_terminated: bool | None = None,
        detail: str | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        # Server-supplied ``error.data`` beyond the structured fields, already
        # sanitized by the transport. Diagnostic only; never an assertion.
        self.detail = str(detail or "").strip() or None
        self.retryable = retryable
        # Local transport evidence, never an assertion supplied by tool metadata.
        self.response_received = response_received is True
        self.operation_id = str(operation_id or "").strip() or None
        self.generation_id = str(generation_id or "").strip() or None
        self.completion_status = completion_status if completion_status in {
            "not_started",
            "started_response_lost",
            "unknown",
        } else "unknown"
        # The builtin server's owned-process cleanup verdict for a failed call.
        # Dispatch validates its shape exactly as it does a successful result's.
        # Local transport evidence for a response timeout: True when the
        # transport terminated the server process (nothing it ran survives),
        # False when the server stayed up for other callers, None otherwise.
        self.transport_terminated = (
            transport_terminated if isinstance(transport_terminated, bool) else None
        )
        self.resource_cleanup = (
            dict(resource_cleanup) if response_received and isinstance(resource_cleanup, dict)
            else None
        )

    def to_metadata(self) -> dict[str, object]:
        metadata: dict[str, object] = {
            "operation_id": self.operation_id,
            "generation_id": self.generation_id,
            "completion_status": self.completion_status,
        }
        if self.detail:
            metadata["detail"] = self.detail
        return metadata

    def __str__(self) -> str:
        return f"[{self.code}] {self.message}"


# ``error.data`` keys the transport already maps onto MCPError fields.
_STRUCTURED_ERROR_DATA_KEYS = frozenset({
    "code",
    "retryable",
    "operation_id",
    "generation_id",
    "completion_status",
    "resource_cleanup",
})


def mcp_error_data_detail(data: object) -> str:
    """Return the unsanitized remainder of a JSON-RPC ``error.data`` payload.

    Third-party servers put their useful explanation here (validation errors,
    upstream causes). Structured keys are dropped because they already travel
    as typed MCPError fields; the caller must sanitize the returned text.
    """
    if data is None:
        return ""
    if isinstance(data, dict):
        data = {k: v for k, v in data.items() if str(k) not in _STRUCTURED_ERROR_DATA_KEYS}
        if not data:
            return ""
    if isinstance(data, str):
        return data
    try:
        return json.dumps(data, sort_keys=True, default=str, ensure_ascii=False)
    except (TypeError, ValueError):
        return str(data)


def as_setup_error(caught: Exception) -> MCPError:
    """Map any per-server setup failure to a typed error so one server cannot abort the rest."""
    if isinstance(caught, MCPError):
        return caught
    return MCPError(code=CMP_MCP_SERVER_FAILED, message=f"setup failed: {type(caught).__name__}")
