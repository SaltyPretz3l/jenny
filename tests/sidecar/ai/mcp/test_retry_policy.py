from __future__ import annotations

from sidecar.ai.mcp.exceptions import CMP_MCP_SERVER_FAILED, CMP_MCP_TOOL_NOT_FOUND, MCPError
from sidecar.ai.mcp.retry_policy import should_retry_tool_call


def test_retry_policy_allows_retryable_read_only_tool_failure() -> None:
    error = MCPError(
        code=CMP_MCP_SERVER_FAILED,
        message="mcp server closed its pipe unexpectedly",
        retryable=True,
    )

    decision = should_retry_tool_call(
        error,
        side_effecting=False,
        attempts_completed=1,
        max_attempts=2,
    )

    assert decision.retry is True
    assert decision.reconnect is True


def test_retry_policy_reconnects_but_does_not_replay_side_effecting_tool() -> None:
    error = MCPError(
        code=CMP_MCP_SERVER_FAILED,
        message="mcp server response timed out",
        retryable=True,
    )

    decision = should_retry_tool_call(
        error,
        side_effecting=True,
        attempts_completed=1,
        max_attempts=2,
    )

    assert decision.retry is False
    assert decision.reconnect is True


def test_retry_policy_rejects_non_retryable_or_exhausted_failures() -> None:
    non_retryable = MCPError(
        code=CMP_MCP_TOOL_NOT_FOUND,
        message="tool is not registered",
        retryable=False,
    )
    exhausted = MCPError(
        code=CMP_MCP_SERVER_FAILED,
        message="mcp server closed its pipe unexpectedly",
        retryable=True,
    )

    assert should_retry_tool_call(
        non_retryable,
        side_effecting=False,
        attempts_completed=1,
        max_attempts=2,
    ).retry is False
    assert should_retry_tool_call(
        exhausted,
        side_effecting=False,
        attempts_completed=2,
        max_attempts=2,
    ).retry is False


def test_retry_policy_treats_unknown_side_effecting_as_non_replayable() -> None:
    error = MCPError(
        code=CMP_MCP_SERVER_FAILED,
        message="mcp server response timed out",
        retryable=True,
    )

    decision = should_retry_tool_call(
        error,
        side_effecting=None,
        attempts_completed=1,
        max_attempts=2,
    )

    assert decision.retry is False
    assert decision.reconnect is True
