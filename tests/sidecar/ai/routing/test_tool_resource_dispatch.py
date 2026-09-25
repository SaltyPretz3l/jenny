from __future__ import annotations

import logging
import shutil
import subprocess
from types import SimpleNamespace
from typing import Any

import pytest

from sidecar.ai.config import MCPServerConfig
from sidecar.ai.error_codes import CMP_RESOURCE_EXCEEDED, CMP_TOOL_EXECUTION_FAILED
from sidecar.ai.mcp import builtin_server
from sidecar.ai.mcp.client_support import extract_tool_output
from sidecar.ai.mcp.exceptions import MCPError
from sidecar.ai.mcp.models import MCPToolResult
from sidecar.ai.mcp.transport_stdio import StdioMCPTransport
from sidecar.ai.routing.tool_dispatch import dispatch_tool_call
from sidecar.ai.routing.tool_resource_deferral import ToolResourceDeferred, ToolResourceWait
from sidecar.ai.tools.builtins import temp_script
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.workspace import WorkspaceGuard

_BUILTIN = "jenny_builtin"
_ELECTRON = "electron_tool_bridge"


class _Lease:
    def __init__(self, events: list[Any]) -> None:
        self.events = events

    def settle(self, status: str, cleanup: str) -> None:
        self.events.append(("settle", status, cleanup))


class _Admission:
    def __init__(self, events: list[Any], *, waiting: bool = False) -> None:
        self.events = events
        self.waiting = waiting

    def __call__(self, **kwargs: Any) -> dict[str, Any]:
        self.events.append(("policy", kwargs))
        return {"schema_version": 1, "authority_revision": "authority_1"}

    def acquire_resource(self, **kwargs: Any) -> _Lease:
        self.events.append(("acquire", kwargs))
        if self.waiting:
            raise ToolExecutionFailure(
                code=CMP_RESOURCE_EXCEEDED,
                message="Tool resource capacity is busy: lane_capacity",
                retryable=True,
            )
        return _Lease(self.events)


class _Client:
    def __init__(self, events: list[Any], result: Any) -> None:
        self.events = events
        self.result = result

    def execute_tool(self, tool_name: str, arguments: dict[str, Any], **_kwargs: Any) -> Any:
        self.events.append(("execute", tool_name, dict(arguments)))
        if isinstance(self.result, BaseException):
            raise self.result
        return self.result


def _runtime(admission: Any, *, scoped: bool = True) -> SimpleNamespace:
    return SimpleNamespace(
        request_context=SimpleNamespace(
            execution_context=object() if scoped else None,
            plan_mode=False,
            read_only=False,
        ),
        operation_admission=admission,
        trace_id="trace_1",
    )


def _dispatch(  # noqa: PLR0913
    *, events: list[Any], admission: Any, result: Any,
    tool_name: str = "read_file", arguments: dict[str, Any] | None = None,
    scoped: bool = True, server_name: str = _BUILTIN, cancelled: bool = False,
    on_dispatch_ready: Any = None,
) -> Any:
    visible = arguments if arguments is not None else {"path": "a.txt"}
    return dispatch_tool_call(
        kernel=SimpleNamespace(
            _config=SimpleNamespace(host_mode="desktop", host_execution_policy_version=0),
            _mcp_client=_Client(events, result),
        ),
        call=SimpleNamespace(call_id="call_1", tool_id=tool_name),
        tool_arguments=dict(visible),
        descriptor=SimpleNamespace(server_name=server_name),
        request_id="request_1",
        session_id="session_1",
        runtime=_runtime(admission, scoped=scoped),
        timeout_seconds=12.0,
        cancel_handle=SimpleNamespace(cancelled=cancelled),
        on_output_chunk=None,
        admission_arguments=dict(visible),
        builtin_server_name=_BUILTIN,
        electron_server_name=_ELECTRON,
        electron_request_type=SimpleNamespace,
        electron_executor=lambda _request: None,
        logger=logging.getLogger(__name__),
        on_dispatch_ready=on_dispatch_ready,
    )


def test_builtin_resource_is_acquired_after_policy_and_settled_after_producer() -> None:
    events: list[Any] = []
    admission = _Admission(events)
    result = MCPToolResult(tool_name="read_file", output="ok", success=True)

    assert _dispatch(events=events, admission=admission, result=result) is result

    assert [event[0] for event in events] == ["policy", "acquire", "execute", "settle"]
    assert events[1][1] == {
        "operation_id": "call_1",
        "tool_name": "read_file",
        "arguments": {"path": "a.txt"},
        "timeout_seconds": 12.0,
    }
    assert events[-1] == ("settle", "succeeded", "confirmed")


def test_ready_event_fires_after_resource_grant_and_before_producer() -> None:
    events: list[Any] = []
    result = MCPToolResult(tool_name="read_file", output="ok", success=True)

    _dispatch(
        events=events,
        admission=_Admission(events),
        result=result,
        on_dispatch_ready=lambda: events.append(("ready",)),
    )

    assert [event[0] for event in events] == [
        "policy", "acquire", "ready", "execute", "settle",
    ]


def test_typed_wait_emits_no_ready_event_or_producer_call() -> None:
    events: list[Any] = []

    class _DeferredAdmission(_Admission):
        def acquire_resource(self, **kwargs: Any) -> _Lease:
            self.events.append(("acquire", kwargs))
            raise ToolResourceDeferred(ToolResourceWait(
                operation_id="call_1",
                resource_class="native_processes",
                reason="capacity",
            ))

    with pytest.raises(ToolResourceDeferred):
        _dispatch(
            events=events,
            admission=_DeferredAdmission(events),
            result=MCPToolResult(tool_name="read_file", output="ok", success=True),
            on_dispatch_ready=lambda: events.append(("ready",)),
        )

    assert [event[0] for event in events] == ["policy", "acquire"]


def test_ready_callback_failure_settles_without_starting_producer() -> None:
    events: list[Any] = []

    def fail_ready() -> None:
        events.append(("ready",))
        raise RuntimeError("event sink unavailable")

    with pytest.raises(RuntimeError, match="event sink unavailable"):
        _dispatch(
            events=events,
            admission=_Admission(events),
            result=MCPToolResult(tool_name="read_file", output="ok", success=True),
            on_dispatch_ready=fail_ready,
        )

    assert [event[0] for event in events] == ["policy", "acquire", "ready", "settle"]
    assert events[-1] == ("settle", "failed", "confirmed")


def test_context_builtin_missing_resource_callback_fails_closed_before_dispatch() -> None:
    events: list[Any] = []

    def policy(**_kwargs: Any) -> dict[str, Any]:
        events.append(("policy",))
        return {"schema_version": 1}

    with pytest.raises(ToolExecutionFailure, match="resource authority bridge") as caught:
        _dispatch(
            events=events,
            admission=policy,
            result=MCPToolResult(tool_name="read_file", output="ok", success=True),
        )
    assert caught.value.code == CMP_TOOL_EXECUTION_FAILED
    assert events == [("policy",)]


def test_waiting_resource_returns_typed_busy_without_polling_or_dispatch() -> None:
    events: list[Any] = []
    with pytest.raises(ToolExecutionFailure, match="lane_capacity") as caught:
        _dispatch(
            events=events,
            admission=_Admission(events, waiting=True),
            result=MCPToolResult(tool_name="read_file", output="ok", success=True),
        )
    assert caught.value.code == CMP_RESOURCE_EXCEEDED
    assert caught.value.retryable is True
    assert [event[0] for event in events] == ["policy", "acquire"]


@pytest.mark.parametrize(
    ("cancelled", "status"),
    [(False, "failed"), (True, "cancelled")],
)
def test_dispatch_exception_quarantines_resource_as_uncertain(
    cancelled: bool, status: str,
) -> None:
    events: list[Any] = []
    with pytest.raises(TimeoutError, match="producer timed out"):
        _dispatch(
            events=events,
            admission=_Admission(events),
            result=TimeoutError("producer timed out"),
            cancelled=cancelled,
        )
    assert events[-1] == ("settle", status, "uncertain")


def test_process_builtin_requires_explicit_cleanup_evidence() -> None:
    events: list[Any] = []
    result = MCPToolResult(tool_name="run_command", output="ok", success=True)
    _dispatch(
        events=events,
        admission=_Admission(events),
        result=result,
        tool_name="run_command",
        arguments={"command": "git status"},
    )
    assert events[-1] == ("settle", "succeeded", "uncertain")

    events = []
    result = MCPToolResult(
        tool_name="run_command",
        output="ok",
        success=True,
        metadata={"resource_cleanup": {
            "cleanup": "confirmed",
            "process_tree_terminated": True,
            "output_readers_terminated": True,
            "reason": None,
        }},
    )
    _dispatch(
        events=events,
        admission=_Admission(events),
        result=result,
        tool_name="run_command",
        arguments={"command": "git status"},
    )
    assert events[-1] == ("settle", "succeeded", "confirmed")


@pytest.mark.parametrize("completion_status", ["not_started", "unknown", "started_response_lost"])
def test_builtin_rejection_releases_only_with_explicit_pre_dispatch_proof(
    completion_status: str,
) -> None:
    events: list[Any] = []
    error = MCPError(
        code="CMP-TOOL-0002", message="tools workspace root is not configured",
        completion_status=completion_status,
    )
    with pytest.raises(MCPError):
        _dispatch(events=events, admission=_Admission(events), result=error,
                  tool_name="todo_read", arguments={})
    # A processless builtin whose reply died with the transport has nothing
    # left running; only an "unknown" outcome (e.g. a timeout) stays quarantined.
    expected = "uncertain" if completion_status == "unknown" else "confirmed"
    assert events[-1] == ("settle", "failed", expected)


def test_oversized_builtin_read_error_releases_resource_after_server_reply(tmp_path) -> None:
    (tmp_path / "large.md").write_text("x" * 200_001, encoding="utf-8")
    response = builtin_server._handle_tools_call(  # noqa: SLF001
        "call_1", builtin_server._default_tools(), WorkspaceGuard(str(tmp_path)),
        {"name": "read_file", "arguments": {"path": "large.md"}},
    )
    assert "200000 byte limit" in response["error"]["message"]
    transport = object.__new__(StdioMCPTransport)
    transport._config = MCPServerConfig(name=_BUILTIN, transport="stdio", command="unused")  # noqa: SLF001
    with pytest.raises(MCPError) as caught:
        transport._raise_for_error(response)  # noqa: SLF001
    events: list[Any] = []
    with pytest.raises(MCPError):
        _dispatch(events=events, admission=_Admission(events), result=caught.value)
    assert events[-1] == ("settle", "failed", "confirmed")


@pytest.mark.skipif(shutil.which("git") is None, reason="git is not installed")
def test_failed_git_process_releases_resource_with_its_cleanup_verdict(tmp_path) -> None:
    # 2026-09-18: git_log on a repository with no commits exits non-zero. The
    # process is gone, but the error reply carried no cleanup verdict, so the
    # git resource stayed quarantined and the turn's next call waited on it.
    subprocess.run(["git", "init", "-q"], cwd=tmp_path, check=True)  # noqa: S603, S607
    response = builtin_server._handle_tools_call(  # noqa: SLF001
        "call_1", builtin_server._default_tools(), WorkspaceGuard(str(tmp_path)),
        {"name": "git_log", "arguments": {"max_count": 5}},
    )
    assert response["error"]["data"]["resource_cleanup"]["cleanup"] == "confirmed"
    transport = object.__new__(StdioMCPTransport)
    transport._config = MCPServerConfig(name=_BUILTIN, transport="stdio", command="unused")  # noqa: SLF001
    with pytest.raises(MCPError) as caught:
        transport._raise_for_error(response)  # noqa: SLF001
    events: list[Any] = []
    with pytest.raises(MCPError):
        _dispatch(events=events, admission=_Admission(events), result=caught.value,
                  tool_name="git_log", arguments={"max_count": 5})
    assert events[-1] == ("settle", "failed", "confirmed")


@pytest.mark.parametrize("evidence", [
    None,
    {"cleanup": "uncertain", "process_tree_terminated": True,
     "output_readers_terminated": False, "reason": "child_cleanup_pending"},
    {"cleanup": "confirmed", "process_tree_terminated": True,
     "output_readers_terminated": False, "reason": None},
    {"cleanup": "confirmed"},
])
def test_failed_process_reply_without_confirmed_verdict_stays_quarantined(evidence: Any) -> None:
    error = MCPError(code="CMP-TOOL-0006", message="failed", response_received=True,
                     resource_cleanup=evidence)
    events: list[Any] = []
    with pytest.raises(MCPError):
        _dispatch(events=events, admission=_Admission(events), result=error, tool_name="git_log")
    assert events[-1] == ("settle", "failed", "uncertain")


def test_process_verdict_without_a_server_reply_is_not_evidence() -> None:
    error = MCPError(code="CMP-TOOL-0006", message="failed", response_received=False,
                     resource_cleanup={"cleanup": "confirmed", "process_tree_terminated": True,
                                       "output_readers_terminated": True, "reason": None})
    assert error.resource_cleanup is None
    events: list[Any] = []
    with pytest.raises(MCPError):
        _dispatch(events=events, admission=_Admission(events), result=error, tool_name="git_log")
    assert events[-1] == ("settle", "failed", "uncertain")


@pytest.mark.parametrize("language", ["powershell", "javascript"])
@pytest.mark.parametrize("cleanup_fails", [False, True])
def test_missing_script_interpreter_cleanup_survives_mcp_and_router(
    tmp_path, monkeypatch, language: str, cleanup_fails: bool,
) -> None:
    temp_root = tmp_path / "owned-temp"
    temp_root.mkdir()
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / "marker.txt").write_text("still-readable", encoding="utf-8")
    monkeypatch.setattr(temp_script, "_create_temp_root", lambda: temp_root)
    monkeypatch.setattr(temp_script.shutil, "which", lambda _name: None)
    def unexpected_launch(*_args, **_kwargs):
        pytest.fail("missing interpreter must not launch a process")
    monkeypatch.setattr(temp_script, "run_command_tool", unexpected_launch)
    if cleanup_fails:
        monkeypatch.setattr(temp_script, "_cleanup_temp_root", lambda _root: "PermissionError")
    tools = builtin_server._default_tools(shell_enabled=True)  # noqa: SLF001
    guard = WorkspaceGuard(str(workspace))
    arguments = {"script": "echo audit", "language": language}
    response = builtin_server._handle_tools_call(  # noqa: SLF001
        "call_1", tools, guard, {"name": "run_temp_script", "arguments": arguments},
    )
    assert "error" not in response
    result = MCPToolResult(tool_name="run_temp_script", **extract_tool_output(response["result"]))
    assert not result.success
    assert result.error_code == "CMP-TOOL-0006"
    assert result.metadata["failure_class"] == "unavailable"
    assert temp_root.exists() is cleanup_fails
    events: list[Any] = []
    admission = _Admission(events)
    _dispatch(events=events, admission=admission, result=result,
              tool_name="run_temp_script", arguments=arguments)
    assert events[-1] == ("settle", "failed", "uncertain" if cleanup_fails else "confirmed")
    if not cleanup_fails:
        read_response = builtin_server._handle_tools_call(  # noqa: SLF001
            "call_2", tools, guard, {"name": "read_file", "arguments": {"path": "marker.txt"}},
        )
        read = MCPToolResult(tool_name="read_file", **extract_tool_output(read_response["result"]))
        assert _dispatch(events=events, admission=admission, result=read).output == "still-readable"
        assert events[-1] == ("settle", "succeeded", "confirmed")


@pytest.mark.parametrize("tool_name", ["read_file", "run_command", "git_status"])
@pytest.mark.parametrize("response_received", [False, True])
def test_error_reply_cleanup_does_not_prove_process_or_transport_cleanup(
    tool_name: str, response_received: bool,
) -> None:
    error = MCPError(code="CMP-TOOL-0006", message="failed", response_received=response_received)
    events: list[Any] = []
    with pytest.raises(MCPError):
        _dispatch(events=events, admission=_Admission(events), result=error, tool_name=tool_name)
    expected = "confirmed" if response_received and tool_name == "read_file" else "uncertain"
    assert events[-1] == ("settle", "failed", expected)


def test_background_start_and_failed_process_result_preserve_cleanup_uncertainty() -> None:
    events: list[Any] = []
    result = MCPToolResult(
        tool_name="run_command",
        output="started",
        success=True,
        metadata={"resource_cleanup": {
            "cleanup": "confirmed",
            "process_tree_terminated": True,
            "output_readers_terminated": True,
            "reason": None,
        }},
    )
    _dispatch(
        events=events,
        admission=_Admission(events),
        result=result,
        tool_name="run_command",
        arguments={"command": "server", "run_in_background": True},
    )
    assert events[-1] == ("settle", "succeeded", "uncertain")

    events = []
    _dispatch(
        events=events,
        admission=_Admission(events),
        result=MCPToolResult(tool_name="git_status", output="failed", success=False),
        tool_name="git_status",
        arguments={},
    )
    assert events[-1] == ("settle", "failed", "uncertain")


@pytest.mark.parametrize("tool_name", ["workspace_change_baseline", "workspace_change_delta"])
def test_workspace_git_observation_requires_native_cleanup_proof(tool_name: str) -> None:
    events: list[Any] = []
    _dispatch(
        events=events, admission=_Admission(events),
        result=MCPToolResult(tool_name=tool_name, output="ok", success=True),
        tool_name=tool_name, arguments={},
    )
    assert events[-1] == ("settle", "succeeded", "uncertain")


def test_monitor_start_cannot_release_the_still_running_native_producer() -> None:
    events: list[Any] = []
    _dispatch(
        events=events, admission=_Admission(events),
        result=MCPToolResult(tool_name="monitor", output="started", success=True,
            metadata={"resource_cleanup": {
                "cleanup": "confirmed", "process_tree_terminated": True,
                "output_readers_terminated": True, "reason": None,
            }}),
        tool_name="monitor", arguments={"command": "watch"},
    )
    assert events[-1] == ("settle", "succeeded", "uncertain")


def test_legacy_and_external_dispatch_do_not_claim_builtin_resources() -> None:
    events: list[Any] = []
    result = MCPToolResult(tool_name="read_file", output="ok", success=True)
    assert _dispatch(
        events=events, admission=None, result=result, scoped=False,
    ) is result
    assert [event[0] for event in events] == ["execute"]

    events = []
    admission = _Admission(events)
    assert _dispatch(
        events=events, admission=admission, result=result, server_name="external",
    ) is result
    assert [event[0] for event in events] == ["policy", "execute"]


@pytest.mark.parametrize("tool_name", ["read_file", "list_dir", "grep_search"])
@pytest.mark.parametrize("error_code", ["CMP-MCP-0004", "CMP-MCP-0005"])
def test_lost_transport_reply_on_processless_builtin_releases_resource(
    tool_name: str, error_code: str,
) -> None:
    """2026-09-20: an oversized PDF read ended the MCP transport mid-call
    (started_response_lost). A builtin that owns no process has nothing to
    clean up, so the lease must settle confirmed instead of quarantining every
    later call in the turn behind "resource capacity busy"."""
    error = MCPError(
        code=error_code,
        message="mcp server closed its pipe unexpectedly",
        response_received=False,
        completion_status="started_response_lost",
    )
    events: list[Any] = []
    with pytest.raises(MCPError):
        _dispatch(events=events, admission=_Admission(events), result=error, tool_name=tool_name)
    assert events[-1] == ("settle", "failed", "confirmed")

    # A reply lost for an unknown reason (timeout, no transport verdict) is not
    # proof the server stopped working on it: still quarantined.
    unknown = MCPError(code="CMP-MCP-0004", message="lost", response_received=False)
    events.clear()
    with pytest.raises(MCPError):
        _dispatch(events=events, admission=_Admission(events), result=unknown, tool_name=tool_name)
    assert events[-1] == ("settle", "failed", "uncertain")


def test_lost_transport_reply_on_process_builtin_stays_quarantined() -> None:
    error = MCPError(
        code="CMP-MCP-0004", message="pipe closed", response_received=False,
        completion_status="started_response_lost",
    )
    events: list[Any] = []
    with pytest.raises(MCPError):
        _dispatch(
            events=events, admission=_Admission(events), result=error,
            tool_name="run_command", arguments={"command": "echo hi"},
        )
    assert events[-1] == ("settle", "failed", "uncertain")
