"""Dogfood HB-014: a process-backed builtin that fails before it starts a process.

2026-09-28 (G1 close-out): a run_command whose cwd was a ``[redacted:path]``
placeholder failed CMP-TOOL-0004 inside the handler, after its durable
operation was registered but before any process started. The error reply
carried no cleanup verdict, so the router settled the workspace lease
``uncertain``; every later workspace tool in the turn was refused CMP-TOOL-0008
``tool_resource_own_cleanup_unconfirmed`` and, in the next turn, CMP-RUNTIME-0001
``resource_capacity``. These tests drive the real builtin server call path and
the real router settlement, with a gateway double that keeps the Electron
gateway's quarantine rule (services/session-runtime/resource-operations.js).
"""

from __future__ import annotations

import logging
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from sidecar.ai.config import MCPServerConfig
from sidecar.ai.error_codes import CMP_TOOL_EXECUTION_FAILED
from sidecar.ai.mcp import builtin_server, circuit_breaker
from sidecar.ai.mcp.client_support import extract_tool_output
from sidecar.ai.mcp.exceptions import MCPError
from sidecar.ai.mcp.models import MCPToolResult
from sidecar.ai.mcp.transport_stdio import StdioMCPTransport
from sidecar.ai.routing.tool_dispatch import dispatch_tool_call
from sidecar.ai.tools.builtins import shell
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.workspace import WorkspaceGuard

_BUILTIN = "jenny_builtin"
_PLACEHOLDER_CWD = "[redacted:path]\\bank_recon"
_NO_PROCESS = {
    "cleanup": "confirmed",
    "process_tree_terminated": True,
    "output_readers_terminated": True,
    "reason": "no_native_process_started",
}


class _Gateway:
    """The Electron gateway's rule: an uncertain settle quarantines the lease,
    and this request's next admission is refused while anything is quarantined."""

    def __init__(self) -> None:
        self.quarantined = 0
        self.settled: list[tuple[str, str, str]] = []
        self.admitted: list[str] = []

    def __call__(self, **_kwargs: Any) -> dict[str, Any]:
        return {"schema_version": 1, "authority_revision": "authority_1"}

    def acquire_resource(self, *, operation_id: str, tool_name: str, **_kwargs: Any) -> Any:
        if self.quarantined:
            raise ToolExecutionFailure(
                code=CMP_TOOL_EXECUTION_FAILED,
                message="tool_resource_own_cleanup_unconfirmed",
                retryable=False,
            )
        self.admitted.append(tool_name)
        gateway = self

        class _Lease:
            def settle(self, status: str, cleanup: str) -> None:
                gateway.settled.append((tool_name, status, cleanup))
                if cleanup != "confirmed":
                    gateway.quarantined += 1

        return _Lease()


class _Server:
    """Routes execute_tool through the real builtin server and stdio error mapping."""

    def __init__(self, workspace: Path) -> None:
        self.tools = builtin_server._default_tools({"tools_shell_enabled": True})
        self.guard = WorkspaceGuard(str(workspace))
        self.transport = object.__new__(StdioMCPTransport)
        self.transport._config = MCPServerConfig(
            name=_BUILTIN,
            transport="stdio",
            command="unused",
        )
        self.calls = 0

    def execute_tool(self, tool_name: str, arguments: dict[str, Any], **_kwargs: Any) -> Any:
        self.calls += 1
        # The double's admission grants a stub execution context; the server is
        # bound to the test workspace directly instead.
        visible = {
            key: value for key, value in arguments.items() if key != "_jenny_execution_context"
        }
        response = builtin_server._handle_tools_call(
            f"call_{self.calls}",
            self.tools,
            self.guard,
            {"name": tool_name, "arguments": visible},
        )
        if "error" in response:
            self.transport._raise_for_error(response)
        return MCPToolResult(tool_name=tool_name, **extract_tool_output(response["result"]))


def _dispatch(server: _Server, gateway: _Gateway, tool_name: str, arguments: dict[str, Any]) -> Any:
    return dispatch_tool_call(
        kernel=SimpleNamespace(
            _config=SimpleNamespace(host_mode="desktop", host_execution_policy_version=0),
            _mcp_client=server,
        ),
        call=SimpleNamespace(call_id=f"op_{len(gateway.settled) + 1}", tool_id=tool_name),
        tool_arguments=dict(arguments),
        descriptor=SimpleNamespace(server_name=_BUILTIN),
        request_id="request_1",
        session_id="session_1",
        runtime=SimpleNamespace(
            request_context=SimpleNamespace(
                execution_context=object(), plan_mode=False, read_only=False,
            ),
            operation_admission=gateway,
            trace_id="trace_1",
        ),
        timeout_seconds=12.0,
        cancel_handle=SimpleNamespace(cancelled=False),
        on_output_chunk=None,
        admission_arguments=dict(arguments),
        builtin_server_name=_BUILTIN,
        electron_server_name="electron_tool_bridge",
        electron_request_type=SimpleNamespace,
        electron_executor=lambda _request: None,
        logger=logging.getLogger(__name__),
    )


@pytest.fixture(autouse=True)
def _fresh_breakers() -> Any:
    # Each failed call counts toward the process-local builtin circuit breaker;
    # keep these failures from opening it for later tests in the session.
    circuit_breaker.reset_all_for_tests()
    yield
    circuit_breaker.reset_all_for_tests()


@pytest.fixture
def no_process(monkeypatch: pytest.MonkeyPatch) -> None:
    def unexpected_launch(*_args: Any, **_kwargs: Any) -> Any:
        pytest.fail("a call that failed validation must not launch a process")

    monkeypatch.setattr(shell, "_run_owned_process", unexpected_launch)
    monkeypatch.setattr(shell, "start_background_job", unexpected_launch)


@pytest.mark.parametrize("tool_name", ["run_command", "run_temp_script"])
@pytest.mark.parametrize("background", [False, True])
def test_failed_validation_releases_the_lease_and_the_next_tool_is_admitted(
    tmp_path: Path, no_process: None, tool_name: str, background: bool,
) -> None:
    if tool_name == "run_temp_script" and background:
        pytest.skip("run_temp_script has no background mode")
    (tmp_path / "marker.txt").write_text("still-readable", encoding="utf-8")
    server, gateway = _Server(tmp_path), _Gateway()
    arguments: dict[str, Any] = (
        {"command": "git status", "cwd": _PLACEHOLDER_CWD}
        if tool_name == "run_command"
        else {"script": "echo audit", "cwd": _PLACEHOLDER_CWD}
    )
    if background:
        arguments["run_in_background"] = True

    with pytest.raises(MCPError) as caught:
        _dispatch(server, gateway, tool_name, arguments)

    assert caught.value.code == "CMP-TOOL-0004"
    assert "redaction placeholder" in caught.value.message
    assert caught.value.resource_cleanup == _NO_PROCESS
    assert gateway.settled == [(tool_name, "failed", "confirmed")]
    # The same turn keeps working: a workspace read and another command are admitted.
    read = _dispatch(server, gateway, "read_file", {"path": "marker.txt"})
    assert read.output == "still-readable"
    assert gateway.admitted == [tool_name, "read_file"]
    assert gateway.quarantined == 0


def test_pre_launch_rejection_before_temp_script_setup_releases_the_lease(
    tmp_path: Path, no_process: None,
) -> None:
    server, gateway = _Server(tmp_path), _Gateway()
    with pytest.raises(MCPError) as caught:
        _dispatch(server, gateway, "run_temp_script", {"script": "   "})
    assert caught.value.resource_cleanup == _NO_PROCESS
    assert gateway.settled == [("run_temp_script", "failed", "confirmed")]


def test_a_launched_command_still_reports_its_own_cleanup_verdict(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Zero-child proof is only the no-launch case: once the owned-process
    service registered a child, the child's own verdict decides."""
    from sidecar.ai.tools.builtins.owned_process_observation import (
        create_process_cleanup_observer,
    )

    def launched_then_failed(*_args: Any, **_kwargs: Any) -> Any:
        assert create_process_cleanup_observer() is not None  # registered, never settles
        raise OSError("pipe broke after spawn")

    monkeypatch.setattr(shell, "_run_owned_process", launched_then_failed)
    server, gateway = _Server(tmp_path), _Gateway()
    with pytest.raises(MCPError) as caught:
        _dispatch(server, gateway, "run_command", {"command": "git status"})
    evidence = caught.value.resource_cleanup
    assert evidence is not None and evidence["cleanup"] == "uncertain"
    assert gateway.settled == [("run_command", "failed", "uncertain")]
    with pytest.raises(ToolExecutionFailure, match="own_cleanup_unconfirmed"):
        _dispatch(server, gateway, "read_file", {"path": "marker.txt"})


def test_background_start_that_registered_a_child_stays_uncertain_on_error() -> None:
    """A background start that failed after its spawn registered keeps quarantine."""
    gateway = _Gateway()
    error = MCPError(
        code="CMP-TOOL-0005", message="failed", response_received=True,
        resource_cleanup={"cleanup": "uncertain", "process_tree_terminated": False,
                          "output_readers_terminated": False,
                          "reason": "child_cleanup_pending"},
    )

    class _Failing:
        def execute_tool(self, *_args: Any, **_kwargs: Any) -> Any:
            raise error

    with pytest.raises(MCPError):
        _dispatch(_Failing(), gateway, "run_command",  # type: ignore[arg-type]
                  {"command": "server", "run_in_background": True})
    assert gateway.settled == [("run_command", "failed", "uncertain")]


def test_zero_child_proof_on_a_background_result_does_not_release_the_lease() -> None:
    """Only an error reply can prove a background start never launched; a
    result without a registration receipt stays quarantined (HB-008 contract)."""
    gateway = _Gateway()

    class _Result:
        def execute_tool(self, *_args: Any, **_kwargs: Any) -> Any:
            return MCPToolResult(tool_name="run_command", output="started", success=True,
                                 metadata={"resource_cleanup": dict(_NO_PROCESS)})

    _dispatch(_Result(), gateway, "run_command",  # type: ignore[arg-type]
              {"command": "server", "run_in_background": True})
    assert gateway.settled == [("run_command", "succeeded", "uncertain")]


@pytest.mark.parametrize(
    "evidence",
    [
        {**_NO_PROCESS, "reason": None},
        {**_NO_PROCESS, "reason": "child_cleanup_pending"},
        {**_NO_PROCESS, "output_readers_terminated": False},
        {**_NO_PROCESS, "extra": True},
    ],
)
def test_background_error_needs_the_exact_zero_child_proof(evidence: dict[str, Any]) -> None:
    gateway = _Gateway()
    error = MCPError(code="CMP-TOOL-0004", message="failed", response_received=True,
                     resource_cleanup=evidence)

    class _Failing:
        def execute_tool(self, *_args: Any, **_kwargs: Any) -> Any:
            raise error

    with pytest.raises(MCPError):
        _dispatch(_Failing(), gateway, "run_command",  # type: ignore[arg-type]
                  {"command": "server", "run_in_background": True})
    assert gateway.settled == [("run_command", "failed", "uncertain")]
