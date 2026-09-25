from __future__ import annotations

import hashlib
import os
from dataclasses import replace
from pathlib import Path

import pytest

from sidecar.ai.mcp import builtin_server
from sidecar.ai.mcp.builtin_request_scope import builtin_request_scope
from sidecar.ai.tools.builtins import todo
from sidecar.ai.tools.builtins.knowledge.roots import available_roots
from sidecar.ai.tools.builtins.owned_process import get_owned_process_service
from sidecar.ai.tools.builtins.skills import _candidate_scopes, configure_skill_tool
from sidecar.ai.tools.builtins.todo import todo_read_tool, todo_write_tool
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.workspace import WorkspaceGuard


def _envelope(root: Path, knowledge: Path, project_skills: Path) -> dict[str, object]:
    identity = str(root).lower() if os.name == "nt" else str(root)
    status = root.stat()
    return {"_jenny_execution_context": {
        "schema_version": 1, "authority_revision": "rev", "project_id": "project_alpha",
        "root_path": str(root),
        "root_id": "root_" + hashlib.sha256(identity.encode()).hexdigest()[:24],
        "root_revision": 1,
        "device_id": str(status.st_dev), "inode": str(status.st_ino),
        "tool_policy_snapshot": {"version": 1},
        "knowledge_roots": [str(knowledge)],
        "skills_config": {
            "skills_bundled_root": None, "skills_user_root": None,
            "skills_project_root": str(project_skills),
            "skills_bundled_enabled": False, "skills_user_enabled": False,
            "skills_project_enabled": True, "skills_disabled_ids": [],
            "skills_auto_index": "auto",
        },
    }}


def test_interleaved_builtin_scopes_do_not_reconfigure_globals(tmp_path: Path) -> None:
    root_a, root_b = tmp_path / "a", tmp_path / "b"
    knowledge_a, knowledge_b = root_a / "knowledge", root_b / "knowledge"
    skills_a, skills_b = root_a / ".jenny" / "skills", root_b / ".jenny" / "skills"
    for path in (knowledge_a, knowledge_b, skills_a, skills_b):
        path.mkdir(parents=True)
    legacy = WorkspaceGuard(str(root_a.resolve()))
    scope_a = builtin_request_scope(
        _envelope(root_a.resolve(), knowledge_a.resolve(), skills_a.resolve()),
        legacy_workspace=legacy, host_config={"host_mode": "desktop"},
    )
    scope_b = builtin_request_scope(
        _envelope(root_b.resolve(), knowledge_b.resolve(), skills_b.resolve()),
        legacy_workspace=legacy, host_config={"host_mode": "desktop"},
    )
    assert scope_a is not None and scope_b is not None
    process_service = get_owned_process_service()
    with scope_a:
        assert get_owned_process_service() is process_service
        assert scope_a.workspace.root == root_a.resolve()
        assert available_roots()[0].path == knowledge_a.resolve()
        assert _candidate_scopes("project")[0].root == skills_a.resolve()
    with scope_b:
        assert get_owned_process_service() is process_service
        assert scope_b.workspace.root == root_b.resolve()
        assert available_roots()[0].path == knowledge_b.resolve()
        assert _candidate_scopes("project")[0].root == skills_b.resolve()


def test_missing_scoped_skills_never_falls_back_to_legacy_project(tmp_path: Path) -> None:
    project = tmp_path / "legacy-project"
    project.mkdir()
    configure_skill_tool({"skills_project_root": str(project), "skills_project_enabled": True})
    carrier = _envelope(tmp_path.resolve(), tmp_path.resolve(), tmp_path.resolve())
    carrier["_jenny_execution_context"].pop("skills_config")
    scope = builtin_request_scope(
        carrier, legacy_workspace=WorkspaceGuard(str(tmp_path.resolve())),
        host_config={"host_mode": "desktop"},
    )
    assert scope is not None
    with scope:
        assert _candidate_scopes("project") == ()


def test_builtin_scope_rejects_forged_extra_context_field(tmp_path: Path) -> None:
    carrier = _envelope(tmp_path.resolve(), tmp_path.resolve(), tmp_path.resolve())
    carrier["_jenny_execution_context"]["forged"] = True
    with pytest.raises(Exception, match="malformed"):
        builtin_request_scope(
            carrier, legacy_workspace=WorkspaceGuard(str(tmp_path.resolve())),
            host_config={"host_mode": "desktop"},
        )


def test_builtin_dispatch_reads_from_per_call_workspace(tmp_path: Path) -> None:
    legacy_root = tmp_path / "legacy"
    scoped_root = tmp_path / "scoped"
    legacy_root.mkdir()
    scoped_root.mkdir()
    (legacy_root / "note.txt").write_text("legacy", encoding="utf-8")
    (scoped_root / "note.txt").write_text("scoped", encoding="utf-8")
    carrier = _envelope(
        scoped_root.resolve(), scoped_root.resolve(), scoped_root.resolve()
    )
    arguments = {
        "path": "note.txt",
        "_jenny_operation_id": "call-scoped-read",
        **carrier,
    }

    response = builtin_server._handle_tools_call(  # noqa: SLF001
        "call-scoped-read",
        builtin_server._default_tools(),  # noqa: SLF001
        WorkspaceGuard(str(legacy_root.resolve())),
        {"name": "read_file", "arguments": arguments},
        {"host_mode": "desktop"},
    )

    assert "error" not in response
    assert "scoped" in response["result"]["content"][0]["text"]
    assert "legacy" not in response["result"]["content"][0]["text"]


def test_rootless_todo_dispatch_never_uses_the_legacy_workspace(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(todo, "_todos_by_session", {})
    todo_write_tool({"todos": [{"content": "Other session"}]}, WorkspaceGuard(None))
    carrier = _envelope(tmp_path.resolve(), tmp_path.resolve(), tmp_path.resolve())
    carrier["_jenny_session_id"] = "rootless-session"
    carrier["_jenny_execution_context"].update({
        "root_path": None, "root_id": None, "root_revision": 0,
        "device_id": None, "inode": None, "knowledge_roots": [],
    })
    tool = builtin_server.BuiltinTool(
        name="todo_read", description="Read todos", side_effecting=False,
        input_schema={"type": "object", "properties": {}}, handler=todo_read_tool,
    )
    response = builtin_server._handle_tools_call(  # noqa: SLF001
        "rootless-todo", {"todo_read": tool}, WorkspaceGuard(str(tmp_path)),
        {"name": "todo_read", "arguments": carrier}, {"host_mode": "desktop"},
    )
    assert "error" not in response
    assert '"count": 0' in response["result"]["content"][0]["text"]
    assert "Other session" in todo_read_tool({}, WorkspaceGuard(None))
    assert list(tmp_path.iterdir()) == []


def test_builtin_validation_failure_proves_no_handler_started(tmp_path: Path) -> None:
    def unexpected_handler(*_args: object) -> str:
        pytest.fail("invalid input must not reach the handler")

    tool = builtin_server.BuiltinTool(
        name="read_file", description="Read", side_effecting=False,
        input_schema={"type": "object", "required": ["path"]}, handler=unexpected_handler,
    )
    response = builtin_server._handle_tools_call(  # noqa: SLF001
        "invalid-read", {"read_file": tool}, WorkspaceGuard(str(tmp_path)),
        {"name": "read_file", "arguments": {}}, {"host_mode": "desktop"},
    )
    assert response["error"]["data"]["completion_status"] == "not_started"


def test_handler_failure_does_not_claim_execution_never_started(tmp_path: Path) -> None:
    invoked: list[bool] = []

    def failed_handler(*_args: object) -> str:
        invoked.append(True)
        raise ToolExecutionFailure(code="CMP-TOOL-0002", message="handler failure", retryable=False)

    tool = builtin_server.BuiltinTool(
        name="read_file", description="Read", side_effecting=False,
        input_schema={"type": "object"}, handler=failed_handler,
    )
    response = builtin_server._handle_tools_call(  # noqa: SLF001
        "failed-read", {"read_file": tool}, WorkspaceGuard(str(tmp_path)),
        {"name": "read_file", "arguments": {}}, {"host_mode": "desktop"},
    )
    assert invoked == [True]
    assert response["error"]["data"]["completion_status"] == "unknown"


def test_replaced_captured_root_is_rejected_before_handler_io(tmp_path: Path) -> None:
    captured_root = tmp_path / "workspace"
    captured_root.mkdir()
    carrier = _envelope(captured_root.resolve(), captured_root.resolve(), captured_root.resolve())
    captured_root.rename(tmp_path / "moved-workspace")
    captured_root.mkdir()
    (captured_root / "note.txt").write_text("replacement", encoding="utf-8")
    invoked: list[bool] = []
    tools = builtin_server._default_tools()  # noqa: SLF001
    tools["read_file"] = replace(
        tools["read_file"],
        handler=lambda _arguments, _workspace: invoked.append(True),
    )

    response = builtin_server._handle_tools_call(  # noqa: SLF001
        "call-replaced-root",
        tools,
        WorkspaceGuard(str(captured_root.resolve())),
        {"name": "read_file", "arguments": {"path": "note.txt", **carrier}},
        {"host_mode": "desktop"},
    )

    assert "error" in response
    assert invoked == []


def test_scoped_recovery_uses_trusted_profile_and_current_project(tmp_path: Path) -> None:
    roots = [tmp_path / "a", tmp_path / "b"]
    for root in roots:
        root.mkdir()
    recovery = tmp_path / "profile" / "workspace-recovery" / "v1"
    snapshots = tmp_path / "profile" / "snapshots"
    host = {"workspace_recovery_root": str(recovery),
            "pre_change_snapshot_root": str(snapshots)}
    # Rootless legacy guards are normal when projects own workspace authority.
    legacy = WorkspaceGuard(None)
    for root in roots:
        scope = builtin_request_scope(_envelope(root, root, root),
                                      legacy_workspace=legacy, host_config=host)
        assert scope is not None
        assert scope.workspace.root == root.resolve()
        assert scope.workspace.pre_change_snapshot_root == str(snapshots)
        assert scope.workspace.mutation_journal is not None
        assert scope.workspace.mutation_journal.workspace_root == root.resolve()
    assert legacy.root is None
    assert legacy.mutation_journal is None
