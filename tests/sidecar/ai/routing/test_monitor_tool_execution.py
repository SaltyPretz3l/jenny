from __future__ import annotations

from types import SimpleNamespace

from sidecar.ai.config import RuntimeConfig
from sidecar.ai.routing.loop_runtime import LoopRuntime
from sidecar.ai.routing.tool_execution import execute_tool
from sidecar.ai.tools.models import ToolCallRequest


class _Contract:
    def __init__(self, descriptor: object) -> None:
        self._descriptor = descriptor

    def entry(self, tool_name: str) -> object | None:
        if tool_name != getattr(self._descriptor, "name", ""):
            return None
        return SimpleNamespace(available=True, descriptor=self._descriptor)


class _MonitorManager:
    def __init__(self) -> None:
        self.kwargs: dict[str, object] | None = None
        self.poll_kwargs: dict[str, object] | None = None

    def start_monitor(self, **kwargs: object) -> object:
        self.kwargs = dict(kwargs)
        return SimpleNamespace(
            monitor_id="mon_test",
            output="Monitor started (monitor_id mon_test, timeout 180000ms).",
            metadata={
                "monitor": {
                    "version": 1,
                    "monitor_id": "mon_test",
                    "state": "running",
                    "events": [],
                    "event_count": 0,
                    "dropped_event_count": 0,
                }
            },
        )

    def poll_monitor(self, monitor_id: str, **kwargs: object) -> dict:
        self.poll_kwargs = {"monitor_id": monitor_id, **kwargs}
        return {
            "monitor_id": monitor_id,
            "state": "running",
            "terminal": False,
            "since_sequence": kwargs.get("since_sequence"),
            "cursor": 7,
            "new_events": [{"sequence": 7, "stream": "stderr", "text": "ERROR boom"}],
            "new_event_count": 1,
            "event_count": 12,
            "suppressed_event_count": 4,
            "dropped_event_count": 0,
            "exit_code": None,
            "success": None,
            "terminal_reason": None,
        }


def test_monitor_tool_execution_uses_runtime_manager_and_metadata(tmp_path) -> None:
    descriptor = SimpleNamespace(
        name="monitor",
        side_effecting=True,
        input_schema={
            "type": "object",
            "properties": {
                "command": {"type": "string"},
                "description": {"type": "string"},
                "timeout_ms": {"type": "integer"},
                "persistent": {"type": "boolean"},
            },
            "required": ["command", "description"],
        },
        source_kind="synthetic",
        tool_family="shell",
    )
    manager = _MonitorManager()
    kernel = SimpleNamespace(
        _config=RuntimeConfig(
            tools_workspace_root=str(tmp_path),
            agent_workspace_root=str(tmp_path),
        ),
        _monitor_manager=manager,
        _active_cancel_handle=None,
        _mcp_client=SimpleNamespace(tool_descriptor=lambda _name: descriptor),
    )
    runtime = LoopRuntime(
        request_id="stream_1",
        trace_id="trace_1",
        session_id="session_1",
        notification_writer=lambda _message: None,
    )

    outcome = execute_tool(
        kernel,
        ToolCallRequest(
            tool_id="monitor",
            call_id="call_1",
            arguments={
                "command": "echo hello",
                "description": "Watch progress",
                "timeout_ms": 180_000,
                "persistent": False,
            },
        ),
        request_id="stream_1",
        session_id="session_1",
        read_snapshot_cache={},
        tool_contract=_Contract(descriptor),
        runtime=runtime,
    )

    assert outcome.success is True
    assert outcome.tool_name == "monitor"
    assert outcome.metadata["monitor"]["monitor_id"] == "mon_test"
    assert manager.kwargs is not None
    assert manager.kwargs["request_id"] == "stream_1"
    assert manager.kwargs["trace_id"] == "trace_1"
    assert manager.kwargs["session_id"] == "session_1"
    assert manager.kwargs["tool_call_id"] == "call_1"
    assert manager.kwargs["workspace_root"] == str(tmp_path)


def test_monitor_tool_threads_gating_params(tmp_path) -> None:
    descriptor = SimpleNamespace(
        name="monitor",
        side_effecting=True,
        input_schema={
            "type": "object",
            "properties": {
                "command": {"type": "string"},
                "description": {"type": "string"},
                "match_patterns": {"type": "array", "items": {"type": "string"}},
                "ignore_patterns": {"type": "array", "items": {"type": "string"}},
                "dedupe": {"type": "boolean"},
            },
            "required": ["command", "description"],
        },
        source_kind="synthetic",
        tool_family="shell",
    )
    manager = _MonitorManager()
    kernel = SimpleNamespace(
        _config=RuntimeConfig(
            tools_workspace_root=str(tmp_path),
            agent_workspace_root=str(tmp_path),
        ),
        _monitor_manager=manager,
        _active_cancel_handle=None,
        _mcp_client=SimpleNamespace(tool_descriptor=lambda _name: descriptor),
    )
    runtime = LoopRuntime(
        request_id="stream_1",
        trace_id="trace_1",
        session_id="session_1",
        notification_writer=lambda _message: None,
    )

    outcome = execute_tool(
        kernel,
        ToolCallRequest(
            tool_id="monitor",
            call_id="call_g",
            arguments={
                "command": "echo hello",
                "description": "Watch",
                "match_patterns": ["ERROR"],
                "ignore_patterns": ["debug"],
                "dedupe": True,
            },
        ),
        request_id="stream_1",
        session_id="session_1",
        read_snapshot_cache={},
        tool_contract=_Contract(descriptor),
        runtime=runtime,
    )

    assert outcome.success is True
    assert manager.kwargs is not None
    assert manager.kwargs["match_patterns"] == ["ERROR"]
    assert manager.kwargs["ignore_patterns"] == ["debug"]
    assert manager.kwargs["dedupe"] is True


def test_check_monitor_tool_formats_digest(tmp_path) -> None:
    descriptor = SimpleNamespace(
        name="check_monitor",
        side_effecting=False,
        input_schema={
            "type": "object",
            "properties": {
                "monitor_id": {"type": "string"},
                "since_sequence": {"type": "integer", "minimum": 0},
                "wait_ms": {"type": "integer", "minimum": 0, "maximum": 30000},
            },
            "required": ["monitor_id"],
        },
        source_kind="synthetic",
        tool_family="shell",
    )
    manager = _MonitorManager()
    kernel = SimpleNamespace(
        _config=RuntimeConfig(
            tools_workspace_root=str(tmp_path),
            agent_workspace_root=str(tmp_path),
        ),
        _monitor_manager=manager,
        _active_cancel_handle=None,
        _mcp_client=SimpleNamespace(tool_descriptor=lambda _name: descriptor),
    )
    runtime = LoopRuntime(
        request_id="stream_1",
        trace_id="trace_1",
        session_id="session_1",
        notification_writer=lambda _message: None,
    )

    outcome = execute_tool(
        kernel,
        ToolCallRequest(
            tool_id="check_monitor",
            call_id="call_c",
            arguments={"monitor_id": "mon_test", "since_sequence": 5, "wait_ms": 100},
        ),
        request_id="stream_1",
        session_id="session_1",
        read_snapshot_cache={},
        tool_contract=_Contract(descriptor),
        runtime=runtime,
    )

    assert outcome.success is True
    assert outcome.tool_name == "check_monitor"
    assert outcome.metadata["monitor"]["monitor_id"] == "mon_test"
    assert manager.poll_kwargs == {
        "monitor_id": "mon_test",
        "since_sequence": 5,
        "wait_ms": 100,
    }
    assert "ERROR boom" in outcome.output
    assert "4 suppressed" in outcome.output
