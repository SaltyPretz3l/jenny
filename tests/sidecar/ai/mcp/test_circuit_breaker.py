"""Red-first: the (tool_id, failed_phase) circuit breaker (W4).

python_execute failing three times in `bootstrap` opens the breaker for THAT
phase only — a session with a broken venv fails in milliseconds with an
honest `unavailable` instead of burning 242s per attempt. Process-global,
bounded, no persistence: a new server generation starts closed.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from sidecar.ai.mcp import builtin_server
from sidecar.ai.mcp.builtin_server import BuiltinTool
from sidecar.ai.mcp.circuit_breaker import (
    BREAKER_FAILURE_THRESHOLD,
    breaker_open_reason,
    record_failure,
    record_success,
    reset_all_for_tests,
)
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.workspace import WorkspaceGuard


@pytest.fixture(autouse=True)
def _clean_breaker():
    reset_all_for_tests()
    yield
    reset_all_for_tests()


def test_threshold_is_three_and_keyed_by_tool_and_phase() -> None:
    assert BREAKER_FAILURE_THRESHOLD == 3
    for _ in range(BREAKER_FAILURE_THRESHOLD - 1):
        record_failure("python_execute", "bootstrap")
    assert breaker_open_reason("python_execute", "bootstrap") is None
    record_failure("python_execute", "bootstrap")
    reason = breaker_open_reason("python_execute", "bootstrap")
    assert reason is not None
    assert "bootstrap" in reason
    # The SAME tool's other phases stay closed, and other tools stay closed.
    assert breaker_open_reason("python_execute", "execute") is None
    assert breaker_open_reason("read_file", "bootstrap") is None


def test_success_resets_the_failure_count() -> None:
    record_failure("python_execute", "bootstrap")
    record_failure("python_execute", "bootstrap")
    record_success("python_execute", "bootstrap")
    record_failure("python_execute", "bootstrap")
    assert breaker_open_reason("python_execute", "bootstrap") is None


def test_state_is_bounded() -> None:
    for index in range(10_000):
        record_failure(f"tool_{index}", "execute")
    # A bounded store must not retain every key ever seen.
    from sidecar.ai.mcp import circuit_breaker

    assert len(circuit_breaker._FAILURE_COUNTS) <= 1024  # noqa: SLF001


def _failing_tool(name: str = "flaky_tool") -> BuiltinTool:
    def fail(_arguments, _workspace):
        raise ToolExecutionFailure(code="CMP-TEST-0002", message="boom", retryable=False)

    return BuiltinTool(
        name=name,
        description="always fails",
        side_effecting=False,
        input_schema={"type": "object", "properties": {}},
        handler=fail,
    )


def test_bracket_opens_after_three_failures_and_fast_fails(tmp_path: Path) -> None:
    tool = _failing_tool()
    workspace = WorkspaceGuard(str(tmp_path))

    for _ in range(BREAKER_FAILURE_THRESHOLD):
        response = builtin_server._handle_tools_call(  # noqa: SLF001
            "breaker-call", {tool.name: tool}, workspace, {"name": tool.name, "arguments": {}}
        )
        assert response["error"]["data"]["code"] == "CMP-TEST-0002"

    calls = {"count": 0}

    def counting(_arguments, _workspace):
        calls["count"] += 1
        raise ToolExecutionFailure(code="CMP-TEST-0002", message="boom", retryable=False)

    open_tool = BuiltinTool(
        name=tool.name,
        description="",
        side_effecting=False,
        input_schema={"type": "object", "properties": {}},
        handler=counting,
    )
    response = builtin_server._handle_tools_call(  # noqa: SLF001
        "breaker-open", {tool.name: open_tool}, workspace, {"name": tool.name, "arguments": {}}
    )
    # The handler never ran; the synthetic failure is honest about class and effects.
    assert calls["count"] == 0
    error_data = response["error"]["data"]
    assert error_data["failure_class"] == "unavailable"
    assert error_data["effects"] == "none"
    assert "breaker" in str(response["error"]["message"]).lower() or "unavailable" in str(
        response["error"]["message"]
    ).lower()


def test_bracket_success_resets_the_key(tmp_path: Path) -> None:
    workspace = WorkspaceGuard(str(tmp_path))
    flaky = {"remaining_failures": 2}

    def sometimes(_arguments, _workspace):
        if flaky["remaining_failures"] > 0:
            flaky["remaining_failures"] -= 1
            raise ToolExecutionFailure(code="CMP-TEST-0002", message="boom", retryable=True)
        return "recovered"

    tool = BuiltinTool(
        name="sometimes_tool",
        description="",
        side_effecting=False,
        input_schema={"type": "object", "properties": {}},
        handler=sometimes,
    )
    for _ in range(3):
        builtin_server._handle_tools_call(  # noqa: SLF001
            "flaky-call", {tool.name: tool}, workspace, {"name": tool.name, "arguments": {}}
        )
    assert breaker_open_reason("sometimes_tool", "execute") is None
