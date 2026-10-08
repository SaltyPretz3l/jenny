from __future__ import annotations

import base64
import json
import os
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
const { ProjectNotesService } = require(path.join(repoRoot, 'services', 'project-notes-service'));
const { createDefaultRegistry, ToolExecutor } = require(path.join(repoRoot, 'services', 'tools'));
const { executeElectronToolRequest } = require(path.join(repoRoot, 'services', 'backend', 'electron-tool-bridge'));
const { SessionExecutionAuthority } = require(path.join(repoRoot, 'services', 'backend', 'session-execution-authority'));
const projectNotesService = new ProjectNotesService({ userDataPath, logger() {} });
const configService = { getState: () => ({}) };
const permissionStore = {
  getSnapshot() {
    return { version: 1, legacy_policies: { project_notes: 'auto' }, rules: [] };
  },
};
const toolExecutor = new ToolExecutor({
  registry: createDefaultRegistry({ toolsProjectNotesEnabled: true }),
  permissionStore,
  pathPolicy: {},
  logger() {},
  configService,
  projectNotesService: () => projectNotesService,
});
// Bridge calls execute only under a current session execution authority; mint the
// General-project binding the desktop runtime would capture for this request
// (PROJECT_NOTES_TEST_PROJECT_ID mints a different captured project for the scoping test).
const root = Object.freeze({ project_id: process.env.PROJECT_NOTES_TEST_PROJECT_ID || 'project_general',
  root_path: null, root_id: null,
  root_revision: 1, device_id: null, inode: null });
const executionAuthority = new SessionExecutionAuthority({
  projectAuthority: { captureSession: () => root, requireCurrent: () => root },
  permissionStore,
  knowledgeService: { getSidecarConfig: () => ({ knowledge_roots: [] }) },
  resolveProjectWorkspaceServices: () => ({ configService }),
}).captureSession(params.session_id, { requestId: params.request_id });
executeElectronToolRequest({ toolExecutor, configService }, {
  params,
  sessionId: params.session_id,
  streamId: params.request_id,
  executionAuthority,
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
        raise AssertionError("project_notes must execute through the Electron bridge")

    def tool_descriptor(self, _tool_name: str) -> None:
        return None


def _request_context() -> ChatRequestContext:
    return ChatRequestContext(
        request_id="req_project_notes",
        trace_id="trace_project_notes",
        session_id="session_project_notes",
        mode="assist",
        approvals_pre_granted=True,
        workspace_root_present=False,
    )


def _kernel(*, flag: bool, bridge: bool = True) -> SimpleNamespace:
    return SimpleNamespace(
        _config=RuntimeConfig(
            electron_tool_bridge_enabled=bridge,
            tools_project_notes_enabled=flag,
            tools_workspace_root="",
            mode="assist",
        ),
        _mcp_client=_MCPClient(),
        _engine=SimpleNamespace(supports_tool_calling=True),
        _active_cancel_handle=None,
    )


def _electron_result(
    user_data_path: Path, params: dict[str, Any], project_id: str | None = None
) -> dict[str, Any]:
    encoded = base64.b64encode(json.dumps(params).encode("utf-8")).decode("ascii")
    env = {**os.environ, "PROJECT_NOTES_TEST_PROJECT_ID": project_id} if project_id else None
    completed = subprocess.run(
        ["node", "-e", NODE_BRIDGE_SCRIPT, str(REPO_ROOT), str(user_data_path), encoded],
        cwd=REPO_ROOT,
        env=env,
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
    project_id: str | None = None,
):
    # Fresh kernel/runtime per call: sidecar state is torn down between calls,
    # matching a restart while the Electron-owned note files remain.
    kernel = _kernel(flag=True)
    contract = tool_resolution.assemble_tool_contract(
        kernel,
        request_context=_request_context(),
    )
    sent: list[dict[str, Any]] = []

    def response_reader_factory(expected_id: int, **_kwargs: object):
        def read_response(_timeout_seconds: float) -> dict[str, Any]:
            result = _electron_result(user_data_path, sent[-1]["params"], project_id)
            return {"jsonrpc": "2.0", "id": expected_id, "result": result}

        return read_response

    outcome = execute_tool(
        kernel,
        ToolCallRequest(tool_id="project_notes", arguments=arguments, call_id=call_id),
        request_id="req_project_notes",
        session_id="session_project_notes",
        read_snapshot_cache={},
        tool_contract=contract,
        runtime=LoopRuntime(
            request_id="req_project_notes",
            trace_id="trace_project_notes",
            session_id="session_project_notes",
            electron_tool_writer=sent.append,
            electron_tool_reader=lambda _timeout: {},
            electron_tool_reader_factory=response_reader_factory,
        ),
    )
    if expect_bridge:
        assert sent[0]["method"] == "tool.execute_electron"
        assert sent[0]["params"]["tool_name"] == "project_notes"
        assert sent[0]["params"]["arguments"] == arguments
    else:
        assert sent == []
    return outcome


def test_project_notes_requires_its_flag_and_the_electron_bridge() -> None:
    disabled = tool_resolution.assemble_tool_contract(
        _kernel(flag=False), request_context=_request_context()
    )
    unavailable = tool_resolution.assemble_tool_contract(
        _kernel(flag=True, bridge=False), request_context=_request_context()
    )
    available = tool_resolution.assemble_tool_contract(
        _kernel(flag=True), request_context=_request_context()
    )

    assert disabled.entry("project_notes").available is False
    assert unavailable.entry("project_notes").available is False
    assert "project_notes" in set(available.available_names)
    descriptor = available.entry("project_notes").descriptor
    assert descriptor.server_name == "electron_tool_bridge"
    assert descriptor.availability.workspace_required is False
    assert descriptor.actions["read"].side_effecting is False
    assert descriptor.actions["append"].side_effecting is True
    assert descriptor.actions["replace"].side_effecting is True


def test_model_bridge_append_read_and_replace_round_trip(tmp_path: Path) -> None:
    empty = _model_call(tmp_path, {"action": "read"}, "call_read_empty")
    first = _model_call(
        tmp_path,
        {"action": "append", "text": "Use pnpm, not npm.", "summary": "Package manager"},
        "call_append_1",
    )
    second = _model_call(
        tmp_path,
        {"action": "append", "text": "Ask before touching CI.", "heading": "Conventions"},
        "call_append_2",
    )
    read_back = _model_call(tmp_path, {"action": "read"}, "call_read_back")
    replaced = _model_call(
        tmp_path,
        {"action": "replace", "old_text": "pnpm, not npm", "new_text": "pnpm"},
        "call_replace",
    )
    missing = _model_call(
        tmp_path,
        {"action": "replace", "old_text": "not in the note", "new_text": "x"},
        "call_replace_missing",
    )

    assert empty.success is True
    assert empty.output == "Project notes are empty."
    assert first.success is True
    assert first.metadata["project_id"] == "project_general"
    assert first.metadata["summary"] == "Package manager"
    assert first.metadata["journal_entry_id"]
    assert second.success is True
    assert second.metadata["revision"] == 2
    assert read_back.success is True
    assert "Use pnpm, not npm." in read_back.output
    assert "## Conventions\nAsk before touching CI." in read_back.output
    assert replaced.success is True
    assert "Undo: available in the chat and the Notes rail." in replaced.output
    assert missing.success is False
    assert missing.metadata["reason"] == "no_match"
    stored = json.loads(
        (tmp_path / "project-notes" / "project_general.json").read_text(encoding="utf-8")
    )
    assert stored["updatedBy"] == "assistant"
    assert "Use pnpm." in stored["text"]


def test_model_bridge_scopes_notes_to_the_captured_project(tmp_path: Path) -> None:
    _model_call(tmp_path, {"action": "append", "text": "General only."}, "call_scope_append")

    other = _model_call(
        tmp_path, {"action": "read"}, "call_scope_other", project_id="project_other"
    )
    own = _model_call(tmp_path, {"action": "read"}, "call_scope_own")

    assert other.success is True
    assert other.output == "Project notes are empty."
    assert other.metadata["project_id"] == "project_other"
    assert own.output == "General only."


def test_model_bridge_enforces_the_declared_field_bounds(tmp_path: Path) -> None:
    too_long = _model_call(
        tmp_path,
        {"action": "append", "text": "t" * 4001},
        "call_text_too_long",
        expect_bridge=False,
    )
    assert too_long.success is False
    assert "text' must be at most 4000 characters" in too_long.metadata["validation_error"]
