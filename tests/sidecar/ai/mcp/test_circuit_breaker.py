"""Red-first: the (tool_id, failed_phase) circuit breaker (W4).

python_execute failing three times in `bootstrap` opens the breaker for THAT
phase only — a session with a broken venv fails in milliseconds with an
honest `unavailable` instead of burning 242s per attempt. Process-global,
bounded, no persistence: a new server generation starts closed.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from sidecar.ai.mcp import builtin_server, circuit_breaker
from sidecar.ai.mcp.builtin_server import BuiltinTool
from sidecar.ai.mcp.circuit_breaker import (
    BREAKER_COOLDOWN_SECONDS,
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

    assert len(circuit_breaker._FAILURE_COUNTS) <= 1024


def _failing_tool(name: str = "flaky_tool", *, retryable: bool = True) -> BuiltinTool:
    def fail(_arguments, _workspace):
        raise ToolExecutionFailure(code="CMP-TEST-0002", message="boom", retryable=retryable)

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
        response = builtin_server._handle_tools_call(
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
    response = builtin_server._handle_tools_call(
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
        builtin_server._handle_tools_call(
            "flaky-call", {tool.name: tool}, workspace, {"name": tool.name, "arguments": {}}
        )
    assert breaker_open_reason("sometimes_tool", "execute") is None


# --- HB-015: only tool-side failures count, and an open breaker recovers ---


class _Clock:
    def __init__(self) -> None:
        self.now = 1_000.0

    def __call__(self) -> float:
        return self.now


@pytest.fixture
def clock(monkeypatch: pytest.MonkeyPatch) -> _Clock:
    fake = _Clock()
    monkeypatch.setattr(circuit_breaker, "_clock", fake)
    return fake


def _call(tool: BuiltinTool, workspace: WorkspaceGuard) -> dict:
    return builtin_server._handle_tools_call(
        "hb015", {tool.name: tool}, workspace, {"name": tool.name, "arguments": {}}
    )


def test_model_input_failures_never_open_the_breaker(tmp_path: Path) -> None:
    """A model repeating a bad path/stale edit must not lock the tool for the session."""
    tool = _failing_tool("edit_like", retryable=False)
    workspace = WorkspaceGuard(str(tmp_path))
    for _ in range(BREAKER_FAILURE_THRESHOLD * 3):
        response = _call(tool, workspace)
        assert response["error"]["data"]["code"] == "CMP-TEST-0002"
    assert breaker_open_reason("edit_like", "execute") is None


def test_unavailable_failures_count_even_when_not_retryable(tmp_path: Path) -> None:
    """python_execute bootstrap failures are `unavailable` without retryable=True."""
    def broken(_arguments, _workspace):
        raise ToolExecutionFailure(
            code="CMP-TEST-0003",
            message="venv broken",
            retryable=False,
            error_details={"failed_phase": "bootstrap", "failure_class": "unavailable"},
        )

    tool = BuiltinTool(
        name="py_like",
        description="",
        side_effecting=False,
        input_schema={"type": "object", "properties": {}},
        handler=broken,
    )
    workspace = WorkspaceGuard(str(tmp_path))
    for _ in range(BREAKER_FAILURE_THRESHOLD):
        _call(tool, workspace)
    assert breaker_open_reason("py_like", "bootstrap") is not None


def test_unexpected_exceptions_count(tmp_path: Path) -> None:
    def crash(_arguments, _workspace):
        raise RuntimeError("kaboom")

    tool = BuiltinTool(
        name="crashy",
        description="",
        side_effecting=False,
        input_schema={"type": "object", "properties": {}},
        handler=crash,
    )
    workspace = WorkspaceGuard(str(tmp_path))
    for _ in range(BREAKER_FAILURE_THRESHOLD):
        _call(tool, workspace)
    assert breaker_open_reason("crashy", "execute") is not None


def test_a_handled_model_error_resets_the_tool_side_streak(tmp_path: Path) -> None:
    workspace = WorkspaceGuard(str(tmp_path))
    transient = _failing_tool("mixed", retryable=True)
    input_error = _failing_tool("mixed", retryable=False)
    _call(transient, workspace)
    _call(transient, workspace)
    _call(input_error, workspace)  # the tool answered deterministically
    _call(transient, workspace)
    assert breaker_open_reason("mixed", "execute") is None


def test_open_breaker_half_opens_after_the_cooldown(clock: _Clock) -> None:
    for _ in range(BREAKER_FAILURE_THRESHOLD):
        record_failure("python_execute", "bootstrap")
    reason = breaker_open_reason("python_execute", "bootstrap")
    assert reason is not None and "60s" in reason

    clock.now += BREAKER_COOLDOWN_SECONDS - 1
    assert breaker_open_reason("python_execute", "bootstrap") is not None

    clock.now += 1
    # Half-open claims nothing: calls keep going through until a verdict.
    assert breaker_open_reason("python_execute", "bootstrap") is None
    assert breaker_open_reason("python_execute", "bootstrap") is None


def test_failed_trial_reopens_for_a_fresh_cooldown(clock: _Clock) -> None:
    for _ in range(BREAKER_FAILURE_THRESHOLD):
        record_failure("tool", "execute")
    clock.now += BREAKER_COOLDOWN_SECONDS
    assert breaker_open_reason("tool", "execute") is None  # half-open
    clock.now += 5
    record_failure("tool", "execute")  # the trial failed on the tool side
    assert breaker_open_reason("tool", "execute") is not None
    clock.now += BREAKER_COOLDOWN_SECONDS - 1
    assert breaker_open_reason("tool", "execute") is not None
    clock.now += 1
    assert breaker_open_reason("tool", "execute") is None


def test_successful_trial_closes_the_breaker(tmp_path: Path, clock: _Clock) -> None:
    workspace = WorkspaceGuard(str(tmp_path))
    state = {"healthy": False}

    def recovering(_arguments, _workspace):
        if not state["healthy"]:
            raise ToolExecutionFailure(code="CMP-TEST-0002", message="boom", retryable=True)
        return "ok"

    tool = BuiltinTool(
        name="recovering",
        description="",
        side_effecting=False,
        input_schema={"type": "object", "properties": {}},
        handler=recovering,
    )
    for _ in range(BREAKER_FAILURE_THRESHOLD):
        _call(tool, workspace)
    refused = _call(tool, workspace)
    assert refused["error"]["data"]["failure_class"] == "unavailable"

    # The breaker's own refusal is not a tool failure: it must not extend the cooldown.
    for _ in range(5):
        _call(tool, workspace)
    clock.now += BREAKER_COOLDOWN_SECONDS
    state["healthy"] = True
    assert "error" not in _call(tool, workspace)
    assert breaker_open_reason("recovering", "execute") is None
    assert "error" not in _call(tool, workspace)


def _open_with_transient_failures(workspace: WorkspaceGuard, name: str) -> None:
    for _ in range(BREAKER_FAILURE_THRESHOLD):
        _call(_failing_tool(name, retryable=True), workspace)
    assert breaker_open_reason(name, "execute") is not None


def test_a_failed_result_during_half_open_closes_the_breaker(
    tmp_path: Path, clock: _Clock
) -> None:
    """Fable B2 P2: a trial run_command whose tests fail (exit 1) proves the tool works."""
    from sidecar.ai.tools.contracts import ToolHandlerResult

    workspace = WorkspaceGuard(str(tmp_path))
    _open_with_transient_failures(workspace, "runner")
    clock.now += BREAKER_COOLDOWN_SECONDS

    failed_result = BuiltinTool(
        name="runner",
        description="",
        side_effecting=False,
        input_schema={"type": "object", "properties": {}},
        handler=lambda _a, _w: ToolHandlerResult(output="exit 1", success=False),
    )
    _call(failed_result, workspace)

    assert breaker_open_reason("runner", "execute") is None
    # Closed, not half-open: one more transient failure does not re-open it.
    _call(_failing_tool("runner", retryable=True), workspace)
    assert breaker_open_reason("runner", "execute") is None


def test_a_model_mistake_during_half_open_leaves_the_tool_usable(
    tmp_path: Path, clock: _Clock
) -> None:
    """Fable B2 P2: a trial ending in a handled input error must not re-lock the tool."""
    workspace = WorkspaceGuard(str(tmp_path))
    _open_with_transient_failures(workspace, "editor")
    clock.now += BREAKER_COOLDOWN_SECONDS

    _call(_failing_tool("editor", retryable=False), workspace)

    assert breaker_open_reason("editor", "execute") is None
    assert "error" not in _call(
        BuiltinTool(
            name="editor",
            description="",
            side_effecting=False,
            input_schema={"type": "object", "properties": {}},
            handler=lambda _a, _w: "ok",
        ),
        workspace,
    )
