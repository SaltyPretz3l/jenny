from __future__ import annotations

import base64
import json
import subprocess
from pathlib import Path
from types import SimpleNamespace
from typing import Any

from sidecar.ai.config import RuntimeConfig
from sidecar.ai.routing import tool_resolution
from sidecar.ai.routing.loop_runtime import LoopRuntime
from sidecar.ai.routing.tool_execution import execute_tool
from sidecar.ai.tools.models import ToolCallRequest
from sidecar.runtime.chat_models import ChatRequestContext

REPO_ROOT = Path(__file__).resolve().parents[4]
NODE_BRIDGE_SCRIPT = r"""
const path = require('node:path');
const repoRoot = process.argv[1];
const userDataPath = process.argv[2];
const params = JSON.parse(Buffer.from(process.argv[3], 'base64').toString('utf8'));
const { ShellConfigService } = require(path.join(repoRoot, 'services', 'shell-config-service'));
const { createDefaultRegistry, ToolExecutor } = require(path.join(repoRoot, 'services', 'tools'));
const { executeElectronToolRequest } = require(path.join(repoRoot, 'services', 'backend', 'electron-tool-bridge'));
const configService = new ShellConfigService({ userDataPath, logger() {} });
const toolExecutor = new ToolExecutor({
  registry: createDefaultRegistry({ toolsTaskBoardEnabled: true }),
  permissionStore: {
    getSnapshot() {
      return { version: 1, legacy_policies: { task_board: 'auto' }, rules: [] };
    },
  },
  pathPolicy: {},
  logger() {},
  configService,
});
executeElectronToolRequest({ toolExecutor, configService }, {
  params,
  sessionId: params.session_id,
  streamId: params.request_id,
}).then(
  (result) => process.stdout.write(JSON.stringify(result)),
  (error) => {
    process.stderr.write(String(error && error.stack || error));
    process.exitCode = 1;
  }
);
"""
LIST_FAILURE_SCRIPT = r"""
const path = require('node:path');
const repoRoot = process.argv[1];
const tool = require(path.join(repoRoot, 'services', 'tools', 'builtin', 'task-board-tool'));
tool.execute({ action: 'list' }, {
  configService: {
    getState() { throw new Error('store read failed'); },
    upsertFollowUp() {},
  },
  logger() {},
}).then(
  (result) => process.stdout.write(JSON.stringify(result)),
  (error) => {
    process.stderr.write(String(error && error.stack || error));
    process.exitCode = 1;
  }
);
"""


class _MCPClient:
    available_tools: list[object] = []

    def execute_tool(self, *_args: object, **_kwargs: object) -> object:
        raise AssertionError("task_board must execute through the Electron bridge")

    def tool_descriptor(self, _tool_name: str) -> None:
        return None


def _request_context() -> ChatRequestContext:
    return ChatRequestContext(
        request_id="req_task_board",
        trace_id="trace_task_board",
        session_id="session_task_board",
        mode="assist",
        approvals_pre_granted=True,
        workspace_root_present=False,
    )


def _kernel(*, flag: bool, bridge: bool = True) -> SimpleNamespace:
    return SimpleNamespace(
        _config=RuntimeConfig(
            electron_tool_bridge_enabled=bridge,
            tools_task_board_enabled=flag,
            tools_workspace_root="",
            mode="assist",
        ),
        _mcp_client=_MCPClient(),
        _engine=SimpleNamespace(supports_tool_calling=True),
        _active_cancel_handle=None,
    )


def _electron_result(user_data_path: Path, params: dict[str, Any]) -> dict[str, Any]:
    encoded = base64.b64encode(json.dumps(params).encode("utf-8")).decode("ascii")
    completed = subprocess.run(
        ["node", "-e", NODE_BRIDGE_SCRIPT, str(REPO_ROOT), str(user_data_path), encoded],
        cwd=REPO_ROOT,
        check=True,
        capture_output=True,
        text=True,
        timeout=30,
    )
    return json.loads(completed.stdout)


def _model_call(
    user_data_path: Path,
    arguments: dict[str, Any],
    call_id: str,
    *,
    expect_bridge: bool = True,
):
    # Build every call from a fresh kernel/runtime. This tears down all
    # sidecar-side registry and module state between calls, matching a sidecar
    # process restart while the Electron-owned shell-config file remains.
    kernel = _kernel(flag=True)
    contract = tool_resolution.assemble_tool_contract(
        kernel,
        request_context=_request_context(),
    )
    sent: list[dict[str, Any]] = []

    def response_reader_factory(expected_id: int, **_kwargs: object):
        def read_response(_timeout_seconds: float) -> dict[str, Any]:
            result = _electron_result(user_data_path, sent[-1]["params"])
            return {"jsonrpc": "2.0", "id": expected_id, "result": result}

        return read_response

    outcome = execute_tool(
        kernel,
        ToolCallRequest(tool_id="task_board", arguments=arguments, call_id=call_id),
        request_id="req_task_board",
        session_id="session_task_board",
        read_snapshot_cache={},
        tool_contract=contract,
        runtime=LoopRuntime(
            request_id="req_task_board",
            trace_id="trace_task_board",
            session_id="session_task_board",
            electron_tool_writer=sent.append,
            electron_tool_reader=lambda _timeout: {},
            electron_tool_reader_factory=response_reader_factory,
        ),
    )
    if expect_bridge:
        assert sent[0]["method"] == "tool.execute_electron"
        assert sent[0]["params"]["tool_name"] == "task_board"
        assert sent[0]["params"]["arguments"] == arguments
    else:
        assert sent == []
    return outcome


def test_task_board_requires_its_flag_and_the_electron_bridge() -> None:
    disabled = tool_resolution.assemble_tool_contract(
        _kernel(flag=False), request_context=_request_context()
    )
    unavailable = tool_resolution.assemble_tool_contract(
        _kernel(flag=True, bridge=False), request_context=_request_context()
    )
    available = tool_resolution.assemble_tool_contract(
        _kernel(flag=True), request_context=_request_context()
    )

    assert disabled.entry("task_board").available is False
    assert unavailable.entry("task_board").available is False
    assert "task_board" in set(available.available_names)
    descriptor = available.entry("task_board").descriptor
    assert descriptor.server_name == "electron_tool_bridge"
    assert descriptor.availability.workspace_required is False
    assert descriptor.actions["list"].side_effecting is False
    assert descriptor.actions["add"].side_effecting is True


def test_model_bridge_writes_survive_restart_and_mutate_by_identity(tmp_path: Path) -> None:
    first = _model_call(tmp_path, {"action": "add", "title": "First task"}, "call_add_1")
    second = _model_call(
        tmp_path,
        {"action": "add", "title": "Second task", "notes": "Keep this intact."},
        "call_add_2",
    )
    first_id = first.metadata["task_id"]
    second_id = second.metadata["task_id"]

    assert first.success is True
    assert second.success is True
    assert first_id != second_id

    updated = _model_call(
        tmp_path,
        {"action": "update", "id": first_id, "title": "First task updated"},
        "call_update",
    )
    completed = _model_call(
        tmp_path, {"action": "complete", "id": first_id}, "call_complete"
    )
    missing = _model_call(
        tmp_path, {"action": "complete", "id": "missing-task"}, "call_missing"
    )
    listed = _model_call(tmp_path, {"action": "list"}, "call_list")

    assert updated.success is True
    assert completed.success is True
    assert missing.success is False
    assert missing.metadata["reason"] == "not_found"
    assert "No agent task with id \"missing-task\" exists." == missing.output
    assert listed.success is True
    assert listed.metadata["count"] == 2
    assert (
        f"id={first_id} | title=First task updated | status=resolved"
        " | sourceKind=agent_task"
    ) in listed.output
    assert (
        f"id={second_id} | title=Second task | status=active"
        " | sourceKind=agent_task"
    ) in listed.output


def test_model_bridge_enforces_follow_up_text_bounds(tmp_path: Path) -> None:
    title_too_long = _model_call(
        tmp_path,
        {"action": "add", "title": "t" * 201},
        "call_title_too_long",
        expect_bridge=False,
    )
    notes_too_long = _model_call(
        tmp_path,
        {"action": "add", "title": "Bounded", "notes": "n" * 4001},
        "call_notes_too_long",
        expect_bridge=False,
    )

    assert title_too_long.success is False
    assert title_too_long.error_code == "CMP-LOOP-0016"
    assert "title' must be at most 200 characters" in title_too_long.metadata[
        "validation_error"
    ]
    assert notes_too_long.success is False
    assert notes_too_long.error_code == "CMP-LOOP-0016"
    assert "notes' must be at most 4000 characters" in notes_too_long.metadata[
        "validation_error"
    ]
    assert _model_call(tmp_path, {"action": "list"}, "call_list_empty").metadata["count"] == 0

    accepted = _model_call(
        tmp_path,
        {"action": "add", "title": "t" * 200, "notes": "n" * 4000},
        "call_at_bounds",
    )
    persisted = json.loads((tmp_path / "shell-config.json").read_text(encoding="utf-8"))
    task = next(
        item for item in persisted["followUps"] if item["id"] == accepted.metadata["task_id"]
    )
    assert len(task["label"]) == 200
    assert len(task["body"]) == 4000
    assert task["sourceKind"] == "agent_task"


def test_list_store_failure_returns_a_clean_tool_error() -> None:
    completed = subprocess.run(
        ["node", "-e", LIST_FAILURE_SCRIPT, str(REPO_ROOT)],
        cwd=REPO_ROOT,
        check=True,
        capture_output=True,
        text=True,
        timeout=30,
    )
    result = json.loads(completed.stdout)

    assert result["isError"] is True
    assert result["metadata"]["reason"] == "action_failed"
    assert result["content"] == "The task board action could not be completed."
