"""``execute_tool`` must credit an ``ask_user`` wait back onto the runtime's
wall-clock deadline once the tool settles, mirroring
``request_dispatch_chat._credit_approval_wait`` for approvals. The credit has
to land whether the human answers, declines, or the bridge errors, and each
sequential ``ask_user`` call in a turn must credit its own wait independently.
Trusted Electron message sends use the same human-wait accounting. Other tools,
message reads and external lookalikes retain their working-time budget.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from sidecar.ai.config import RuntimeConfig
from sidecar.ai.routing import tool_execution
from sidecar.ai.routing.loop_runtime import LoopRuntime
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.models import ToolCallRequest

REQUEST_ID = "req-ask-user-credit"


def _descriptor(tool_id: str, *, server_name: str = "electron_tool_bridge") -> SimpleNamespace:
    return SimpleNamespace(
        name=tool_id,
        side_effecting=False,
        input_schema={"type": "object"},
        source_kind="mcp",
        tool_family="interaction",
        server_name=server_name,
    )


def _contract(descriptor: SimpleNamespace) -> SimpleNamespace:
    return SimpleNamespace(
        entry=lambda _name: SimpleNamespace(available=True, descriptor=descriptor, reason="")
    )


def _kernel(descriptor: SimpleNamespace) -> SimpleNamespace:
    return SimpleNamespace(
        _config=RuntimeConfig(tools_execution_timeout_seconds=120.0),
        _mcp_client=SimpleNamespace(tool_descriptor=lambda _name: descriptor),
    )


def _ok_result(tool_name: str) -> SimpleNamespace:
    return SimpleNamespace(
        tool_name=tool_name,
        output="answered",
        success=True,
        content_type="text",
        ui_payload=None,
        generated_artifacts=(),
        error_code=None,
        metadata={},
        trusted_attachments=(),
    )


@pytest.mark.parametrize("dispatch_error", [None, RuntimeError("bridge failed")])
@pytest.mark.parametrize("tool_id", ["ask_user", "session_message"])
def test_ask_user_wait_is_credited_back_to_the_deadline_on_every_outcome(
    monkeypatch: pytest.MonkeyPatch,
    dispatch_error: RuntimeError | None,
    tool_id: str,
) -> None:
    descriptor = _descriptor(tool_id)
    kernel = _kernel(descriptor)
    now = [100.0]
    runtime = LoopRuntime(
        request_id=REQUEST_ID,
        wall_clock_deadline=105.0,
        clock=lambda: now[0],
    )
    call = ToolCallRequest(tool_id=tool_id, arguments={"action": "send"}, call_id="c-ask-user")

    def fake_dispatch(**_kwargs: object) -> SimpleNamespace:
        now[0] += 20.0  # the human takes 20s to answer -- longer than the 5s left
        if dispatch_error is not None:
            raise dispatch_error
        return _ok_result(tool_id)

    monkeypatch.setattr(tool_execution, "_dispatch_tool_call", fake_dispatch)
    monkeypatch.setattr(tool_execution, "apply_tool_pressure_backoff", lambda **_kwargs: None)

    if dispatch_error is None:
        tool_execution.execute_tool(
            kernel,
            call,
            request_id=REQUEST_ID,
            read_snapshot_cache={},
            tool_contract=_contract(descriptor),
            runtime=runtime,
        )
    else:
        with pytest.raises(ToolExecutionFailure):
            tool_execution.execute_tool(
                kernel,
                call,
                request_id=REQUEST_ID,
                read_snapshot_cache={},
                tool_contract=_contract(descriptor),
                runtime=runtime,
            )

    # 105.0 + 20.0 -- the wait is credited back regardless of outcome.
    assert runtime.wall_clock_deadline == 125.0


@pytest.mark.parametrize(("tool_id", "action", "server"), [
    ("session_message", "read", "electron_tool_bridge"),
    ("session_message", "list_targets", "electron_tool_bridge"),
    ("session_message", "send", "external_mcp"),
    ("session_message", "send", "jenny_builtin"),
    ("mcp__external__session_message", "send", "external_mcp"),
])
def test_non_consent_calls_keep_their_working_time_budget(
    monkeypatch: pytest.MonkeyPatch, tool_id: str, action: str, server: str,
) -> None:
    descriptor = _descriptor(tool_id, server_name=server)
    now = [0.0]
    runtime = LoopRuntime(request_id=REQUEST_ID, wall_clock_deadline=10.0, clock=lambda: now[0])

    def dispatch(**_kwargs: object) -> SimpleNamespace:
        now[0] += 3.0
        return _ok_result(tool_id)

    monkeypatch.setattr(tool_execution, "_dispatch_tool_call", dispatch)
    monkeypatch.setattr(tool_execution, "apply_tool_pressure_backoff", lambda **_kwargs: None)
    tool_execution.execute_tool(
        _kernel(descriptor), ToolCallRequest(tool_id=tool_id, arguments={"action": action}, call_id="c-control"),
        request_id=REQUEST_ID, read_snapshot_cache={}, tool_contract=_contract(descriptor), runtime=runtime,
    )
    assert runtime.wall_clock_deadline == 10.0


def test_two_sequential_ask_user_calls_each_credit_their_own_wait(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    descriptor = _descriptor("ask_user")
    kernel = _kernel(descriptor)
    now = [0.0]
    runtime = LoopRuntime(
        request_id=REQUEST_ID,
        wall_clock_deadline=10.0,
        clock=lambda: now[0],
    )
    contract = _contract(descriptor)
    monkeypatch.setattr(tool_execution, "apply_tool_pressure_backoff", lambda **_kwargs: None)

    def _run(call_id: str, wait_seconds: float) -> None:
        def fake_dispatch(**_kwargs: object) -> SimpleNamespace:
            now[0] += wait_seconds
            return _ok_result("ask_user")

        monkeypatch.setattr(tool_execution, "_dispatch_tool_call", fake_dispatch)
        tool_execution.execute_tool(
            kernel,
            ToolCallRequest(tool_id="ask_user", arguments={}, call_id=call_id),
            request_id=REQUEST_ID,
            read_snapshot_cache={},
            tool_contract=contract,
            runtime=runtime,
        )

    _run("c1", 8.0)  # 0 -> 8, deadline 10 -> 18
    _run("c2", 9.0)  # 8 -> 17, deadline 18 -> 27

    assert runtime.wall_clock_deadline == 27.0


def test_ordinary_tool_wait_is_never_credited(monkeypatch: pytest.MonkeyPatch) -> None:
    """Non-ask_user tools must be byte-identical: no deadline mutation."""
    descriptor = _descriptor("read_file", server_name="tools")
    kernel = _kernel(descriptor)
    now = [0.0]
    runtime = LoopRuntime(
        request_id=REQUEST_ID,
        wall_clock_deadline=10.0,
        clock=lambda: now[0],
    )

    def fake_dispatch(**_kwargs: object) -> SimpleNamespace:
        now[0] += 9.0  # real wall time spent -- but this tool's wait is charged
        return _ok_result("read_file")

    monkeypatch.setattr(tool_execution, "_dispatch_tool_call", fake_dispatch)
    monkeypatch.setattr(tool_execution, "apply_tool_pressure_backoff", lambda **_kwargs: None)

    tool_execution.execute_tool(
        kernel,
        ToolCallRequest(tool_id="read_file", arguments={"path": "a.txt"}, call_id="c-read"),
        request_id=REQUEST_ID,
        read_snapshot_cache={},
        tool_contract=_contract(descriptor),
        runtime=runtime,
    )

    assert runtime.wall_clock_deadline == 10.0
