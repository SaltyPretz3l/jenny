"""Retry policy for MCP tool execution failures."""

from __future__ import annotations

from dataclasses import dataclass

from sidecar.ai.mcp.exceptions import MCPError

DEFAULT_MCP_TOOL_CALL_MAX_ATTEMPTS = 2


@dataclass(frozen=True)
class MCPRetryDecision:
    retry: bool
    reconnect: bool


def should_retry_tool_call(
    error: MCPError,
    *,
    side_effecting: bool | None,
    attempts_completed: int,
    max_attempts: int = DEFAULT_MCP_TOOL_CALL_MAX_ATTEMPTS,
) -> MCPRetryDecision:
    """Decide whether a failed MCP tool call may be replayed.

    Retryable transport failures can trigger a bounded reconnect. The actual
    call is replayed only for read-only tools, where repeating the request does
    not create duplicate side effects.
    """
    if not error.retryable:
        return MCPRetryDecision(retry=False, reconnect=False)
    if attempts_completed >= max(1, max_attempts):
        return MCPRetryDecision(retry=False, reconnect=False)
    if side_effecting is not False:
        return MCPRetryDecision(retry=False, reconnect=True)
    return MCPRetryDecision(retry=True, reconnect=True)
