"""Row 184 W3: delegate tasks in write mode work in their own worktree."""

from __future__ import annotations

import hashlib
import os
import shutil
import subprocess
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

import pytest

from sidecar.ai.error_codes import CMP_TOOL_POLICY_DENIED
from sidecar.ai.execution_policy import BUILTIN_MCP_SERVER_NAME, ELECTRON_TOOL_BRIDGE_SERVER_NAME
from sidecar.ai.mcp.builtin_request_scope import builtin_request_scope
from sidecar.ai.mcp.exceptions import MCPError
from sidecar.ai.routing import delegate_write
from sidecar.ai.routing.delegate_contracts import validate_delegate_arguments
from sidecar.ai.routing.route_policy_runtime import require_helper_write_dispatch
from sidecar.ai.routing.sub_agent_invocation import (
    SubAgentInvocationResult,
    _child_request_context,
    build_sub_agent_identity,
    helper_write_admission,
)
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.workspace import WorkspaceGuard
from sidecar.runtime.chat_models import ChatRequestContext, TerminalChatStateError
from sidecar.runtime.execution_context import execution_context_from_params
from sidecar.runtime.helper_worktree_admission import (
    HelperWorktree,
    worktree_changes,
    worktree_head,
)
from sidecar.runtime.turn_state import TURN_STATE_CANCELLED


def _root_id(path: Path) -> str:
    identity = str(path).lower() if os.name == "nt" else str(path)
    return "root_" + hashlib.sha256(identity.encode()).hexdigest()[:24]


def _context_for(root: Path) -> object:
    status = root.stat()
    return execution_context_from_params({"execution_context": {
        "schema_version": 1, "authority_revision": "rev", "project_id": "project_alpha",
        "root_path": str(root), "root_id": _root_id(root), "root_revision": 1,
        "device_id": str(status.st_dev), "inode": str(status.st_ino),
        "tool_policy_snapshot": {"version": 1}, "knowledge_roots": [],
    }})


def _worktree_for(root: Path) -> HelperWorktree:
    status = root.stat()
    return HelperWorktree(
        id="wt_1", branch="jenny-helper/fix-61626364", base_ref="HEAD",
        root_path=str(root), root_id=_root_id(root),
        device_id=str(status.st_dev), inode=str(status.st_ino),
    )


class _Admission:
    def __init__(self, worktree: HelperWorktree | None = None, *, refuse: bool = False) -> None:
        self.worktree = worktree
        self.refuse = refuse
        self.calls: list[dict[str, object]] = []

    def __call__(self, **fields: object) -> dict[str, object]:
        self.calls.append({"admit": fields})
        return {"schema_version": 1, "root_path": "parent"}

    def helper_worktree(self, **fields: object) -> object:
        self.calls.append(fields)
        if fields["action"] == "create":
            if self.refuse:
                raise MCPError(code=CMP_TOOL_POLICY_DENIED, message="Writing helpers run only on Auto.")
            return self.worktree
        return bool(fields["keep"])


def _parent_context(root: Path, **overrides: object) -> ChatRequestContext:
    return replace(ChatRequestContext(
        request_id="req_parent", trace_id=None, session_id="sess_1", mode="assist",
        approvals_pre_granted=False, execution_context=_context_for(root),
        approval_mode="auto_run",
    ), **overrides)


def _allowed(root: Path, **overrides: object) -> dict[str, object]:
    values: dict[str, object] = {
        "router": SimpleNamespace(_config=SimpleNamespace(engine_type="chatgpt")),
        "parent_context": _parent_context(root),
        "runtime": SimpleNamespace(operation_admission=_Admission()),
        "route": SimpleNamespace(local=False),
    }
    values.update(overrides)
    return values


def test_write_task_is_allowed_on_auto_with_a_cloud_model_and_a_project(tmp_path: Path) -> None:
    assert delegate_write.write_task_refusal(**_allowed(tmp_path)) == ""


@pytest.mark.parametrize(("field", "value", "reason"), [
    ("router", SimpleNamespace(_config=SimpleNamespace(engine_type="local")), "cloud model"),
    ("route", SimpleNamespace(local=True), "local helper model"),
    ("runtime", SimpleNamespace(operation_admission=lambda **_: {}), "unavailable here"),
])
def test_write_task_refusals_from_engine_route_and_runtime(
    tmp_path: Path, field: str, value: object, reason: str,
) -> None:
    assert reason in delegate_write.write_task_refusal(**_allowed(tmp_path, **{field: value}))


@pytest.mark.parametrize(("overrides", "reason"), [
    ({"approval_mode": "prompt"}, "Auto"),
    ({"plan_mode": True}, "Plan"),
    ({"propose_mode": True}, "Plan, Propose"),
    ({"read_only": True}, "read-only"),
    ({"execution_context": None}, "project folder"),
])
def test_write_task_refusals_from_the_turn(
    tmp_path: Path, overrides: dict[str, object], reason: str,
) -> None:
    parent = _parent_context(tmp_path, **overrides)
    refusal = delegate_write.write_task_refusal(**_allowed(tmp_path, parent_context=parent))
    assert reason in refusal


def test_read_tasks_keep_the_plain_invoker_and_write_refusals_raise(tmp_path: Path) -> None:
    def invoke(**_kwargs: object) -> None:
        return None

    kwargs = _allowed(tmp_path)
    read = SimpleNamespace(mode="read")
    assert delegate_write.task_invoker(task=read, invoke=invoke, **kwargs) is invoke
    refused = _allowed(tmp_path, parent_context=_parent_context(tmp_path, approval_mode="prompt"))
    with pytest.raises(ToolExecutionFailure) as error:
        delegate_write.task_invoker(task=SimpleNamespace(mode="write"), invoke=invoke, **refused)
    assert error.value.code == CMP_TOOL_POLICY_DENIED


def test_delegate_accepts_a_write_mode_task_and_rejects_an_unknown_mode() -> None:
    request = validate_delegate_arguments(
        {"tasks": [{"prompt": "Fix the typo in README.md", "mode": "write"}]},
        parent_agent_depth=0,
    )
    assert request.tasks[0].mode == "write"
    unknown = validate_delegate_arguments(
        {"tasks": [{"prompt": "x", "mode": "admin"}]}, parent_agent_depth=0,
    )
    assert unknown.tasks[0].error is not None  # isolated per item, not a whole-call failure
    assert "mode" in unknown.tasks[0].error["message"]


def _identity() -> object:
    return build_sub_agent_identity(
        parent_request_id="req_parent", canonical_call_id="call_1", parent_agent_id="agent_p",
    )


def test_a_write_task_runs_in_the_worktree_and_an_unchanged_one_is_removed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    parent_root, helper_root = tmp_path / "parent", tmp_path / "helper"
    parent_root.mkdir()
    helper_root.mkdir()
    admission = _Admission(_worktree_for(helper_root))
    monkeypatch.setattr(delegate_write, "worktree_head", lambda _root: "abc")
    monkeypatch.setattr(delegate_write, "worktree_changes", lambda _root, _start: {
        "files_changed": 0, "insertions": 0, "deletions": 0, "commits": 0})
    seen: dict[str, object] = {}

    def invoke(**kwargs: object) -> SubAgentInvocationResult:
        seen.update(kwargs)
        return SubAgentInvocationResult(status="completed", response_text="nothing to change")

    result = delegate_write.run_write_task(
        admission=admission, task=SimpleNamespace(prompt="Fix tests!"), invoke=invoke,
        kwargs={"identity": _identity(), "parent_context": _parent_context(parent_root)},
    )
    assert admission.calls[0]["name"] == "fix-tests"
    assert seen["write_context"].root_path == str(helper_root)
    assert seen["write_context"].root_id == _root_id(helper_root)
    assert seen["write_context"].authority_revision == "rev"
    settle = admission.calls[-1]
    assert settle["action"] == "settle" and settle["keep"] is False
    assert result.worktree == {
        "branch": "jenny-helper/fix-61626364", "path": str(helper_root), "kept": False,
        "files_changed": 0, "insertions": 0, "deletions": 0, "commits": 0,
    }


@pytest.mark.parametrize(("raised", "status"), [
    (RuntimeError("provider fell over"), "failed"),
    (TerminalChatStateError(TURN_STATE_CANCELLED, "cancelled"), "cancelled"),
])
def test_a_failed_or_cancelled_helper_still_reports_its_kept_worktree(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, raised: Exception, status: str,
) -> None:
    admission = _Admission(_worktree_for(tmp_path))
    monkeypatch.setattr(delegate_write, "worktree_head", lambda _root: None)
    monkeypatch.setattr(delegate_write, "worktree_changes", lambda _root, _start: None)

    def invoke(**_kwargs: object) -> SubAgentInvocationResult:
        raise raised

    result = delegate_write.run_write_task(
        admission=admission, task=SimpleNamespace(prompt=""), invoke=invoke,
        kwargs={"identity": _identity(), "parent_context": _parent_context(tmp_path)},
    )
    assert admission.calls[0]["name"] == "helper"
    assert admission.calls[-1]["action"] == "settle" and admission.calls[-1]["keep"] is True
    assert result.status == status
    assert result.worktree["kept"] is True and result.worktree["files_changed"] is None


def test_a_settle_that_fails_reports_the_worktree_kept(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    admission = _Admission(_worktree_for(tmp_path))
    real = admission.helper_worktree

    def failing_settle(**fields: object) -> object:
        if fields["action"] == "settle":
            raise TimeoutError("no reply")
        return real(**fields)

    admission.helper_worktree = failing_settle
    monkeypatch.setattr(delegate_write, "worktree_head", lambda _root: "abc")
    monkeypatch.setattr(delegate_write, "worktree_changes", lambda _root, _start: {
        "files_changed": 0, "insertions": 0, "deletions": 0, "commits": 0})
    result = delegate_write.run_write_task(
        admission=admission, task=SimpleNamespace(prompt="x"),
        invoke=lambda **_: SubAgentInvocationResult(status="completed", response_text="ok"),
        kwargs={"identity": _identity(), "parent_context": _parent_context(tmp_path)},
    )
    assert result.status == "completed" and result.worktree["kept"] is True


def test_a_refused_worktree_fails_the_task_before_the_child_starts(tmp_path: Path) -> None:
    def invoke(**_kwargs: object) -> None:
        raise AssertionError("the child must not start")

    result = delegate_write.run_write_task(
        admission=_Admission(refuse=True), task=SimpleNamespace(prompt="x"), invoke=invoke,
        kwargs={"identity": _identity(), "parent_context": _parent_context(tmp_path)},
    )
    assert result.status == "failed"
    assert result.error_code == CMP_TOOL_POLICY_DENIED
    assert "Auto" in result.error_message


def test_a_write_child_context_names_the_worktree_and_keeps_the_auto_grant(tmp_path: Path) -> None:
    helper_root = tmp_path / "helper"
    helper_root.mkdir()
    parent = _parent_context(tmp_path)
    write_context = replace(
        parent.execution_context, root_path=str(helper_root), root_id=_root_id(helper_root),
    )
    common = {"parent_context": parent, "identity": _identity(), "tool_preferences_override": None,
              "iteration_budget_override": 5, "report_mode": "plain_text"}
    child = _child_request_context(write_context=write_context, **common)
    assert child.execution_context is write_context
    assert child.read_only is False and child.sub_agent_write_mode is True
    assert child.approval_mode == "auto_run"
    research = _child_request_context(**common)
    assert research.read_only is True and research.sub_agent_write_mode is False
    assert research.approval_mode == "prompt"
    assert research.execution_context is parent.execution_context


def test_the_admission_answers_with_the_worktree_and_builtins_bind_to_it(tmp_path: Path) -> None:
    parent_root, helper_root = (tmp_path / "parent").resolve(), (tmp_path / "helper").resolve()
    parent_root.mkdir()
    helper_root.mkdir()
    parent_admission = _Admission()
    parent_admission.acquire_resource = lambda **_: "lease"
    write_context = replace(
        _context_for(parent_root), root_path=str(helper_root), root_id=_root_id(helper_root),
        device_id=str(helper_root.stat().st_dev), inode=str(helper_root.stat().st_ino),
    )
    admit = helper_write_admission(parent_admission, write_context)
    envelope = admit(operation_id="op", tool_name="write_file", arguments={"path": "a.txt"})
    assert parent_admission.calls == [{"admit": {
        "operation_id": "op", "tool_name": "write_file", "arguments": {"path": "a.txt"}}}]
    assert envelope["root_path"] == str(helper_root)
    assert admit.acquire_resource() == "lease"
    assert not hasattr(admit, "helper_worktree")
    scope = builtin_request_scope(
        {"_jenny_execution_context": envelope},
        legacy_workspace=WorkspaceGuard(str(parent_root)), host_config={"host_mode": "desktop"},
    )
    assert scope is not None
    with scope:
        assert scope.workspace.root == helper_root


@pytest.mark.parametrize(("tool_id", "server", "synthetic", "allowed"), [
    ("write_file", BUILTIN_MCP_SERVER_NAME, False, True),
    ("recall_tool_output", BUILTIN_MCP_SERVER_NAME, True, True),
    ("run_command", ELECTRON_TOOL_BRIDGE_SERVER_NAME, False, False),
    ("memory", BUILTIN_MCP_SERVER_NAME, True, False),
    ("external_tool", "some_mcp_server", False, False),
])
def test_a_writing_helper_dispatches_builtin_tools_only(
    tool_id: str, server: str, synthetic: bool, allowed: bool,
) -> None:
    context = SimpleNamespace(sub_agent_write_mode=True)
    descriptor = SimpleNamespace(server_name=server)
    if allowed:
        require_helper_write_dispatch(context, descriptor, tool_id, {}, synthetic=synthetic)
    else:
        with pytest.raises(ToolExecutionFailure):
            require_helper_write_dispatch(context, descriptor, tool_id, {}, synthetic=synthetic)
    research = SimpleNamespace(sub_agent_write_mode=False)
    require_helper_write_dispatch(research, descriptor, tool_id, {}, synthetic=synthetic)


@pytest.mark.parametrize(("arguments", "refused"), [
    ({"path": ".git"}, True),
    ({"file_path": "sub/.GIT/config"}, True),
    ({"path": "a\\.git.\\HEAD"}, True),
    ({"path": "GIT~1/config"}, True),
    ({"moves": [{"source": "a.txt", "destination": ".git"}]}, True),
    ({"path": ".gitignore"}, False),
    ({"path": "docs/git/notes.md"}, False),
    ({"file_path": "a.txt", "new_string": "see .git/config"}, False),
])
def test_a_writing_helper_never_writes_under_git_metadata(
    arguments: dict[str, object], refused: bool,
) -> None:
    context = SimpleNamespace(sub_agent_write_mode=True)
    descriptor = SimpleNamespace(server_name=BUILTIN_MCP_SERVER_NAME)
    if refused:
        with pytest.raises(ToolExecutionFailure, match=".git"):
            require_helper_write_dispatch(context, descriptor, "write_file", arguments, synthetic=False)
    else:
        require_helper_write_dispatch(context, descriptor, "write_file", arguments, synthetic=False)


@pytest.mark.skipif(shutil.which("git") is None, reason="git is not installed")
def test_worktree_changes_counts_edits_new_files_and_commits(tmp_path: Path) -> None:
    def git(*args: str) -> None:
        subprocess.run(["git", "-C", str(tmp_path), *args], check=True, capture_output=True)

    git("init", "-q")
    git("config", "user.email", "t@example.invalid")
    git("config", "user.name", "t")
    (tmp_path / "a.txt").write_text("one\n", encoding="utf-8")
    git("add", "a.txt")
    git("commit", "-qm", "base")
    start = worktree_head(str(tmp_path))
    assert worktree_changes(str(tmp_path), start) == {
        "files_changed": 0, "insertions": 0, "deletions": 0, "commits": 0}
    (tmp_path / "a.txt").write_text("two\nthree\n", encoding="utf-8")
    (tmp_path / "b.txt").write_text("new\n", encoding="utf-8")
    changes = worktree_changes(str(tmp_path), start)
    assert changes == {"files_changed": 2, "insertions": 2, "deletions": 1, "commits": 0}
    git("add", "-A")
    git("commit", "-qm", "helper")
    committed = worktree_changes(str(tmp_path), start)
    assert committed["commits"] == 1 and committed["insertions"] == 3
    helper = (tmp_path.parent / f"{tmp_path.name}-helper").resolve()
    git("worktree", "add", "-q", "-b", "jenny-helper/t", str(helper))
    head = worktree_head(str(helper))
    assert head is not None, "a linked worktree passes the git tools' root validation"
    (helper / "c.txt").write_text("c\n", encoding="utf-8")
    assert worktree_changes(str(helper), head)["files_changed"] == 1
