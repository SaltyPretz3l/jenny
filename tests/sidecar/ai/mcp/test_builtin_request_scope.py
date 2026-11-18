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

    response = builtin_server._handle_tools_call(
        "call-scoped-read",
        builtin_server._default_tools(),
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
    response = builtin_server._handle_tools_call(
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
    response = builtin_server._handle_tools_call(
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
    response = builtin_server._handle_tools_call(
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
    tools = builtin_server._default_tools()
    tools["read_file"] = replace(
        tools["read_file"],
        handler=lambda _arguments, _workspace: invoked.append(True),
    )

    response = builtin_server._handle_tools_call(
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


# --- A root boundary (team host file tools, I2 and I3) ---


def _scope_envelope(root_path: str, pair: tuple[str | None, str | None]) -> dict[str, object]:
    identity = root_path.lower() if os.name == "nt" else root_path
    return {"_jenny_execution_context": {
        "schema_version": 1, "authority_revision": "rev", "project_id": "project_alpha",
        "root_path": root_path,
        "root_id": "root_" + hashlib.sha256(identity.encode()).hexdigest()[:24],
        "root_revision": 1, "device_id": pair[0], "inode": pair[1],
        "tool_policy_snapshot": {"version": 1}, "knowledge_roots": [],
    }}


def _null_root_envelope() -> dict[str, object]:
    return {"_jenny_execution_context": {
        "schema_version": 1, "authority_revision": "rev", "project_id": "project_general",
        "root_path": None, "root_id": None, "root_revision": 0, "device_id": None,
        "inode": None, "tool_policy_snapshot": {"version": 1}, "knowledge_roots": [],
    }}


def _pair_of(path: Path) -> tuple[str, str]:
    status = path.stat()
    return str(status.st_dev), str(status.st_ino)


def _team_host(boundary: Path, resolved: Path | None | str = "same") -> dict[str, object]:
    return {
        "host_mode": "server", "host_execution_policy_version": 1,
        "hosted_root_boundary": str(boundary),
        "hosted_root_boundary_resolved": str(boundary) if resolved == "same"
        else (None if resolved is None else str(resolved)),
        "pre_change_snapshot_root": "", "workspace_recovery_root": "",
    }


def _bound(arguments: dict[str, object], host: dict[str, object]):
    return builtin_request_scope(arguments, legacy_workspace=WorkspaceGuard(None),
                                 host_config=host)


def _link(link: Path, target: Path) -> None:
    if os.name == "nt":
        import _winapi

        _winapi.CreateJunction(str(target), str(link))
    else:
        link.symlink_to(target, target_is_directory=True)


@pytest.fixture
def projects(tmp_path: Path) -> Path:
    boundary = (tmp_path / "projects").resolve()
    for name in ("alpha", "beta", "alpha/inner"):
        (boundary / name).mkdir(parents=True)
    (tmp_path / "other").mkdir()
    return boundary


def test_a_direct_child_of_the_boundary_is_bound(projects: Path) -> None:
    child = projects / "alpha"
    scope = _bound(_scope_envelope(str(child), _pair_of(child)), _team_host(projects))
    assert scope is not None and scope.workspace.root == child
    assert (scope.workspace_device_id, scope.workspace_inode) == _pair_of(child)


def _refused_spellings(projects: Path) -> dict[str, tuple[str, Path]]:
    """name -> (the root_path a request carries, the folder whose pair it carries)."""
    outside = projects.parent / "other"
    _link(projects / "link", projects / "alpha")
    spellings = {
        "the boundary itself": (str(projects), projects),
        "a grandchild": (str(projects / "alpha" / "inner"), projects / "alpha" / "inner"),
        "a sibling of the boundary": (str(outside), outside),
        "a link to a child": (str(projects / "link"), projects / "alpha"),
        "a case-only variant of another child": (str(projects / "ALPHA"), projects / "beta"),
        "a case-only variant of a folder outside": (
            str(projects.parent / "OTHER"), outside),
        "a trailing dot": (str(projects / "alpha") + ".", projects / "alpha"),
        "a trailing space": (str(projects / "alpha") + " ", projects / "alpha"),
        "a dot-dot through the boundary": (
            str(projects) + os.sep + ".." + os.sep + "other", outside),
    }
    return spellings


def test_every_other_spelling_is_the_malformed_context_failure(projects: Path) -> None:
    accepted = []
    for name, (root_path, owner) in _refused_spellings(projects).items():
        try:
            _bound(_scope_envelope(root_path, _pair_of(owner)), _team_host(projects))
        except ToolExecutionFailure as error:
            assert error.message == "trusted tool execution context is malformed", name
            continue
        accepted.append(name)
    assert accepted == []


def test_a_child_without_its_identity_pair_is_refused_on_every_platform(projects: Path) -> None:
    child = projects / "alpha"
    with pytest.raises(ToolExecutionFailure, match="malformed"):
        _bound(_scope_envelope(str(child), (None, None)), _team_host(projects))


def test_a_boundary_that_did_not_resolve_at_start_binds_no_root(projects: Path) -> None:
    child = projects / "alpha"
    with pytest.raises(ToolExecutionFailure, match="malformed"):
        _bound(_scope_envelope(str(child), _pair_of(child)), _team_host(projects, None))


def test_a_null_root_is_bound_and_touches_no_file(projects: Path) -> None:
    from sidecar.ai.tools import hosted_file_io

    (projects / "alpha" / "a.txt").write_bytes(b"alpha")
    scope = _bound(_null_root_envelope(), _team_host(projects))
    assert scope is not None and scope.workspace.root is None
    with scope, pytest.raises(ToolExecutionFailure):
        with hosted_file_io.open_regular_file(projects / "alpha" / "a.txt") as handle:
            handle.read()


def test_without_a_boundary_a_single_owner_host_keeps_todays_binding(projects: Path) -> None:
    """The boundary check and the pair rule apply only with a boundary set."""
    root = projects / "alpha" / "inner"
    scope = _bound(_scope_envelope(str(root), (None, None)),
                   {"host_mode": "server", "host_execution_policy_version": 1})
    assert scope is not None and scope.workspace.root == root
