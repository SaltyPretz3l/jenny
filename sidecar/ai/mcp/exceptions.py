"""Typed exceptions for MCP transport and protocol failures."""

from __future__ import annotations

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
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.retryable = retryable
        self.operation_id = str(operation_id or "").strip() or None
        self.generation_id = str(generation_id or "").strip() or None
        self.completion_status = completion_status if completion_status in {
            "not_started",
            "started_response_lost",
            "unknown",
        } else "unknown"

    def to_metadata(self) -> dict[str, object]:
        return {
            "operation_id": self.operation_id,
            "generation_id": self.generation_id,
            "completion_status": self.completion_status,
        }

    def __str__(self) -> str:
        return f"[{self.code}] {self.message}"
