"""Every audited tool_execution_started is paired with exactly one terminal event."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from sidecar.ai.config import RuntimeConfig
from sidecar.ai.error_codes import CMP_LOOP_TOOL_INTERRUPTED, CMP_TOOL_IO_FAILED
from sidecar.ai.routing import tool_execution as tool_execution_module
from sidecar.ai.routing.loop_runtime import LoopRuntime
from sidecar.ai.routing.resource_pressure import PressureBackoffDecision
from sidecar.ai.routing.tool_execution import execute_tool
from sidecar.ai.routing.tool_observation import (
    KIND_TOOL_EXECUTION_FAILED,
    KIND_TOOL_EXECUTION_STARTED,
    ToolObservationStore,
)
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.models import ToolCallRequest
from sidecar.runtime.chat_models import TerminalChatStateError
from sidecar.runtime.multiplexer import TurnCancellationHandle

REQUEST_ID = "req-audit-pairing"


@pytest.fixture(autouse=True)
def _no_resource_pressure(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        tool_execution_module,
        "build_tool_pressure_backoff_decision",
        lambda **_kwargs: PressureBackoffDecision(
            should_backoff=False, delay_seconds=0.0, severity="none", warnings=(), snapshot={},
        ),
    )


_DESCRIPTOR = SimpleNamespace(
    name="read_file",
    side_effecting=False,
    input_schema={"type": "object", "properties": {"path": {"type": "string"}}},
    source_kind="mcp",
    tool_family="filesystem",
    server_name="tools",
)


class _Contract:
    def entry(self, tool_name: str) -> Any:
        if tool_name != _DESCRIPTOR.name:
            return None
        return SimpleNamespace(available=True, descriptor=_DESCRIPTOR, reason="")


class _Client:
    def __init__(self, raises: BaseException | None = None) -> None:
        self.raises = raises
        self.calls = 0

    def tool_descriptor(self, tool_name: str) -> Any:
        return _DESCRIPTOR if tool_name == _DESCRIPTOR.name else None

    def execute_tool(self, tool_id: str, tool_arguments: dict[str, Any], **_kwargs: Any) -> Any:
        self.calls += 1
        if self.raises is not None:
            raise self.raises
        raise AssertionError("dispatch must not succeed in these tests")


def _run(client: _Client, runtime: LoopRuntime, **kwargs: Any) -> None:
    execute_tool(
        SimpleNamespace(_config=RuntimeConfig(), _mcp_client=client, _monitor_manager=None),
        ToolCallRequest(tool_id="read_file", arguments={"path": "x"}, call_id="c1"),
        request_id=REQUEST_ID,
        read_snapshot_cache={},
        tool_contract=_Contract(),
        runtime=runtime,
        **kwargs,
    )


def _runtime() -> tuple[LoopRuntime, ToolObservationStore]:
    store = ToolObservationStore()
    store.ensure_turn(request_id=REQUEST_ID)
    return LoopRuntime(request_id=REQUEST_ID, observation_store=store), store


def _events(store: ToolObservationStore) -> list[tuple[str, str | None]]:
    return [
        (event.kind, event.error_code)
        for event in store.recent_events(request_id=REQUEST_ID, limit=50)
    ]


def test_cancel_at_dispatch_ready_audits_failed_once_after_started() -> None:
    runtime, store = _runtime()
    handle = TurnCancellationHandle(request_id=REQUEST_ID)
    runtime.cancel_handle = handle
    client = _Client()

    with pytest.raises(TerminalChatStateError):
        _run(client, runtime, on_dispatch_ready=handle.cancel)

    assert client.calls == 0
    assert _events(store) == [
        (KIND_TOOL_EXECUTION_STARTED, None),
        (KIND_TOOL_EXECUTION_FAILED, CMP_LOOP_TOOL_INTERRUPTED),
    ]


def test_dispatch_side_tool_failure_after_started_audits_failed_once() -> None:
    runtime, store = _runtime()
    client = _Client(
        raises=ToolExecutionFailure(code=CMP_TOOL_IO_FAILED, message="disk", retryable=False)
    )

    with pytest.raises(ToolExecutionFailure):
        _run(client, runtime)

    assert client.calls == 1
    assert _events(store) == [
        (KIND_TOOL_EXECUTION_STARTED, None),
        (KIND_TOOL_EXECUTION_FAILED, CMP_TOOL_IO_FAILED),
    ]


def test_pre_dispatch_interrupt_emits_no_unpaired_events() -> None:
    runtime, store = _runtime()
    handle = TurnCancellationHandle(request_id=REQUEST_ID)
    handle.cancel()
    runtime.cancel_handle = handle

    with pytest.raises(TerminalChatStateError):
        _run(_Client(), runtime)

    assert _events(store) == []
