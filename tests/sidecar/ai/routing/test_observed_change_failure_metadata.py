"""Row 34 S2: a scripted call that raises still reports the files it changed.

The builtin server computes the review in its failure branch and sends it as
the internal error-data key ``observed_changes``. The stdio transport maps it
onto ``MCPError.observed_changes``; routing turns it into
``ToolExecutionFailure.result_metadata`` and merges only ``diffs`` and
``scripted_change_review`` into the failed outcome. File contents never reach
model text or logs.
"""

from __future__ import annotations

import json
import logging
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_tool_loop import (
    _build_router,
    _StubMCPClient,
    _ToolLoopEngine,
    _ToolPlan,
)

from sidecar.ai.error_codes import CMP_TOOL_PYTHON_EXECUTION_FAILED
from sidecar.ai.execution_policy import BUILTIN_MCP_SERVER_NAME
from sidecar.ai.mcp import builtin_server
from sidecar.ai.mcp.exceptions import MCPError
from sidecar.ai.mcp.models import MCPToolDescriptor
from sidecar.ai.routing.loop_runtime import LoopRuntime
from sidecar.ai.routing.router import ToolExecutionOutcome
from sidecar.ai.routing.tool_call_execution import execute_tool_calls_sequentially
from sidecar.ai.tools.builtins import worktree_change_tracking as tracking
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.models import GenerationResult, ToolCallRequest
from sidecar.ai.tools.workspace import WorkspaceGuard

_MARKER = "SECRET_BODY_MARKER"


@pytest.fixture(autouse=True)
def _reset() -> None:
    tracking._reset_worktree_tracking_for_tests()


def _git_workspace(root: Path) -> Path:
    for command in (
        ["git", "init", "-q"],
        ["git", "config", "user.email", "test@example.com"],
        ["git", "config", "user.name", "Test"],
    ):
        subprocess.run(command, cwd=root, check=True)
    (root / "base.py").write_text("value = 1\n", encoding="utf-8")
    subprocess.run(["git", "add", "."], cwd=root, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "base"], cwd=root, check=True)
    return root


def _failing_script_response(
    root: Path, arguments: dict[str, object] | None = None
) -> dict[str, Any]:
    def _write_then_raise(arguments: dict[str, object], workspace: WorkspaceGuard) -> str:
        (root / "base.py").write_text(f"value = 2  # {_MARKER}\n", encoding="utf-8")
        raise ToolExecutionFailure(
            code=CMP_TOOL_PYTHON_EXECUTION_FAILED, message="python execution failed"
        )

    tool = builtin_server.BuiltinTool(
        name="python_execute",
        description="test",
        side_effecting=True,
        input_schema={"type": "object", "properties": {}},
        handler=_write_then_raise,
    )
    return builtin_server._handle_tools_call(
        "request-s2",
        {"python_execute": tool},
        WorkspaceGuard(str(root)),
        {"name": "python_execute", "arguments": dict(arguments or {})},
    )


def _mcp_error(response: dict[str, Any]) -> MCPError:
    from tests.sidecar.ai.mcp.test_transport_stdio import _stub_transport

    with pytest.raises(MCPError) as caught:
        _stub_transport()._raise_for_error(response)  # type: ignore[attr-defined]
    return caught.value


class _RaisingClient(_StubMCPClient):
    def __init__(self, error: MCPError, server_name: str) -> None:
        super().__init__((
            MCPToolDescriptor(
                name="probe_script",
                description="Run a script",
                input_schema={"type": "object"},
                side_effecting=False,
                server_name=server_name,
            ),
        ))
        self._error = error

    def execute_tool(self, tool_name: str, arguments: dict[str, object], **_kwargs: Any) -> Any:
        self.executions.append((tool_name, dict(arguments)))
        raise self._error


def _route_failure(error: MCPError, *, server_name: str) -> tuple[Any, _ToolLoopEngine]:
    events: list[Any] = []
    engine = _ToolLoopEngine(
        plans=[
            _ToolPlan(result=GenerationResult(
                content="",
                finish_reason="tool_calls",
                tool_calls=(ToolCallRequest(
                    tool_id="probe_script", arguments={}, call_id="call_probe_script"
                ),),
            )),
            _ToolPlan(result=GenerationResult(content="It failed.", finish_reason="stop")),
        ]
    )
    _build_router(
        engine=engine,
        mcp_client=_RaisingClient(error, server_name),
        extra_snapshot_tools=("probe_script",),
    ).build_chat_decision(
        request_id="req_s2",
        messages=[{"role": "user", "content": "Run it."}],
        latest_user_content="Run it.",
        mode="assist",
        approvals_pre_granted=True,
        runtime=LoopRuntime(emit=events.append, request_id="req_s2"),
    )
    results = [event for event in events if type(event).__name__ == "ToolResultEvent"]
    assert len(results) == 1
    return results[0], engine


def _tool_messages(engine: _ToolLoopEngine) -> str:
    return "\n".join(
        str(message.get("content", ""))
        for message in engine.requests[-1]["messages"]
        if message.get("role") == "tool"
    )


def test_a_raised_python_execute_failure_carries_its_review_to_the_failed_outcome(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.DEBUG)
    response = _failing_script_response(_git_workspace(tmp_path))

    data = response["error"]["data"]
    assert data["observed_changes"]["scripted_change_review"]["call_outcome"] == "failed"
    error = _mcp_error(response)
    assert error.observed_changes is not None
    assert "observed_changes" not in error.to_metadata()
    event, engine = _route_failure(error, server_name=BUILTIN_MCP_SERVER_NAME)

    assert event.success is False
    metadata = event.metadata
    review = metadata["scripted_change_review"]
    assert review["call_outcome"] == "failed"
    assert review["state"] == "observed"
    assert review["changed_paths"] == ["base.py"]
    assert [diff["path"] for diff in metadata["diffs"]] == ["base.py"]
    assert "observed_changes" not in metadata
    model_text = _tool_messages(engine)
    assert "python execution failed" in model_text
    assert "changed workspace files outside edit_file/write_file: base.py" in model_text
    assert _MARKER not in model_text
    assert _MARKER not in caplog.text
    for record in caplog.records:
        assert _MARKER not in json.dumps(record.__dict__.get("data"), default=str)
        assert "observed_changes" not in json.dumps(record.__dict__.get("data"), default=str)


def test_a_third_party_server_cannot_inject_review_metadata(tmp_path: Path) -> None:
    error = _mcp_error(_failing_script_response(_git_workspace(tmp_path)))

    event, _engine = _route_failure(error, server_name="third_party")

    assert "diffs" not in event.metadata
    assert "scripted_change_review" not in event.metadata


class _Contract:
    def entry(self, _name: str) -> Any | None:
        return None


class _Kernel:
    def __init__(self, failure: ToolExecutionFailure) -> None:
        self._failure = failure

    def _assert_valid_tool_call(self, _call: ToolCallRequest) -> None:
        return

    def _assistant_tool_call_message(self, _result: Any, call: ToolCallRequest) -> dict[str, object]:
        return {"role": "assistant", "tool": call.tool_id}

    def _tool_result_message(
        self, call: ToolCallRequest, _outcome: ToolExecutionOutcome
    ) -> dict[str, object]:
        return {"role": "tool", "tool": call.tool_id}

    def _execute_tool(self, call: ToolCallRequest, **_kwargs: Any) -> ToolExecutionOutcome:
        raise self._failure

    def _update_read_snapshot_cache(self, _cache: dict[str, Any], **_kwargs: Any) -> None:
        return


def test_the_failed_outcome_merges_only_diffs_and_the_review() -> None:
    failure = ToolExecutionFailure(code=CMP_TOOL_PYTHON_EXECUTION_FAILED, message="boom")
    failure.result_metadata = {
        "diffs": [{"diff_id": "scripted:x:0", "path": "a.py"}],
        "scripted_change_review": {"schema_version": 1, "call_outcome": "failed"},
        "workspace_changed": True,
        "resource_cleanup": {"cleanup": "confirmed"},
    }
    outcomes: list[ToolExecutionOutcome] = []
    execute_tool_calls_sequentially(
        indexed_calls=[(ToolCallRequest(tool_id="python_execute", arguments={}, call_id="c1"), 1)],
        runtime=LoopRuntime(emit=lambda _event: None, request_id="req-1"),
        kernel=_Kernel(failure),
        result=SimpleNamespace(),
        request_id="req-1",
        session_id="session-1",
        tool_resolution_context=None,
        read_snapshot_cache={},
        outcomes=outcomes,
        working_messages=[],
        iteration_calls=[],
        streamed_event_types=set(),
        tool_payload_ref=[],
        tool_contract=_Contract(),
    )

    metadata = outcomes[0].metadata
    assert metadata["diffs"] == [{"diff_id": "scripted:x:0", "path": "a.py"}]
    assert metadata["scripted_change_review"]["call_outcome"] == "failed"
    assert "workspace_changed" not in metadata
    assert "resource_cleanup" not in metadata
    assert outcomes[0].output.startswith("Tool 'python_execute' failed: boom.")


def test_a_raised_failure_keeps_its_restore_point_through_routing(tmp_path: Path) -> None:
    point = {
        "kind": "git_checkpoint",
        "ref": "refs/jenny/checkpoints/sess-1/9",
        "created_at": "2026-10-05T12:00:00.000Z",
    }
    response = _failing_script_response(
        _git_workspace(tmp_path), {"_jenny_restore_point": point}
    )

    event, engine = _route_failure(_mcp_error(response), server_name=BUILTIN_MCP_SERVER_NAME)

    assert event.metadata["scripted_change_review"]["restore_point"] == point
    assert point["ref"] not in _tool_messages(engine)
    assert point["ref"] not in event.content
    assert point["ref"] not in str(event.tool_input)
