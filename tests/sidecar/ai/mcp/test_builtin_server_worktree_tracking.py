from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

from sidecar.ai.mcp import builtin_server
from sidecar.ai.tools.builtins import worktree_change_tracking as tracking
from sidecar.ai.tools.workspace import WorkspaceGuard


def _call(tools, workspace, name: str, arguments: dict[str, object]) -> dict[str, object]:
    response = builtin_server._handle_tools_call(
        name, tools, workspace, {"name": name, "arguments": arguments}
    )
    text = response["result"]["content"][0]["text"]
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return {"text": text}


def test_dispatch_attributes_file_and_foreground_command_mutations(tmp_path: Path) -> None:
    subprocess.run(["git", "init", "-q"], cwd=tmp_path, check=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=tmp_path, check=True)
    subprocess.run(["git", "config", "user.name", "Test"], cwd=tmp_path, check=True)
    (tmp_path / "base.txt").write_text("base\n", encoding="utf-8")
    subprocess.run(["git", "add", "."], cwd=tmp_path, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "base"], cwd=tmp_path, check=True)
    workspace = WorkspaceGuard(str(tmp_path))
    tools = builtin_server._default_tools({"tools_shell_enabled": True})
    session = {"_jenny_session_id": "session-test"}
    baseline = _call(tools, workspace, "workspace_change_baseline", session)
    _call(
        tools,
        workspace,
        "write_file",
        {**session, "path": "written.txt", "content": "written\n"},
    )
    command = "type nul > commanded.txt" if os.name == "nt" else "touch commanded.txt"
    _call(tools, workspace, "run_command", {**session, "command": command})
    delta = _call(
        tools,
        workspace,
        "workspace_change_delta",
        {**session, "baseline_id": baseline["baseline_id"]},
    )
    assert delta["created_by_session"] == ["commanded.txt", "written.txt"]


def test_observation_failure_does_not_change_primary_tool_outcome(
    monkeypatch, tmp_path: Path
) -> None:
    tool = builtin_server.BuiltinTool(
        name="mutation",
        description="test",
        side_effecting=True,
        input_schema={"type": "object", "properties": {}},
        handler=lambda arguments, workspace: "primary success",
    )
    monkeypatch.setattr(
        tracking,
        "begin_mutation_observation",
        lambda **kwargs: (_ for _ in ()).throw(RuntimeError("observation unavailable")),
    )
    response = builtin_server._handle_tools_call(
        "request-1",
        {"mutation": tool},
        WorkspaceGuard(str(tmp_path)),
        {"name": "mutation", "arguments": {}},
    )
    assert response["result"]["content"][0]["text"] == "primary success"


def test_post_observation_failure_does_not_change_primary_tool_outcome(
    monkeypatch, tmp_path: Path
) -> None:
    tool = builtin_server.BuiltinTool(
        name="mutation",
        description="test",
        side_effecting=True,
        input_schema={"type": "object", "properties": {}},
        handler=lambda arguments, workspace: "primary success",
    )
    monkeypatch.setattr(tracking, "begin_mutation_observation", lambda **kwargs: object())
    monkeypatch.setattr(
        tracking,
        "finish_mutation_observation",
        lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("observation unavailable")),
    )
    response = builtin_server._handle_tools_call(
        "request-2",
        {"mutation": tool},
        WorkspaceGuard(str(tmp_path)),
        {"name": "mutation", "arguments": {}},
    )
    assert response["result"]["content"][0]["text"] == "primary success"


class _ResultRecorder:
    """Duck-typed mutation journal that records post-call scripted observations."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, object]] = []

    def observe_tool_call(
        self, tool_name: str, arguments: dict[str, object], changed: object = "pre-call"
    ) -> None:
        self.calls.append((tool_name, changed))


def _git_workspace(tmp_path: Path) -> Path:
    for command in (
        ["git", "init", "-q"],
        ["git", "config", "user.email", "test@example.com"],
        ["git", "config", "user.name", "Test"],
    ):
        subprocess.run(command, cwd=tmp_path, check=True)
    (tmp_path / "base.txt").write_text("base\n", encoding="utf-8")
    subprocess.run(["git", "add", "."], cwd=tmp_path, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "base"], cwd=tmp_path, check=True)
    return tmp_path


def test_read_only_command_reports_no_change_after_the_call(tmp_path: Path) -> None:
    recorder = _ResultRecorder()
    workspace = WorkspaceGuard(str(_git_workspace(tmp_path)), mutation_journal=recorder)
    tools = builtin_server._default_tools({"tools_shell_enabled": True})

    _call(tools, workspace, "run_command", {"command": "git status"})

    assert recorder.calls == [("run_command", False)]


def test_changing_command_reports_a_change_after_the_call(tmp_path: Path) -> None:
    recorder = _ResultRecorder()
    workspace = WorkspaceGuard(str(_git_workspace(tmp_path)), mutation_journal=recorder)
    tools = builtin_server._default_tools({"tools_shell_enabled": True})
    command = "type nul > commanded.txt" if os.name == "nt" else "touch commanded.txt"

    _call(tools, workspace, "run_command", {"command": command})

    assert recorder.calls == [("run_command", True)]


def test_raised_script_failure_reports_unknown_change(tmp_path: Path) -> None:
    from sidecar.ai.error_codes import CMP_TOOL_IO_FAILED
    from sidecar.ai.tools.contracts import ToolExecutionFailure

    def _fail(arguments, workspace):
        raise ToolExecutionFailure(code=CMP_TOOL_IO_FAILED, message="script failed")

    tool = builtin_server.BuiltinTool(
        name="run_temp_script",
        description="test",
        side_effecting=True,
        input_schema={"type": "object", "properties": {}},
        handler=_fail,
    )
    recorder = _ResultRecorder()
    response = builtin_server._handle_tools_call(
        "request-3",
        {"run_temp_script": tool},
        WorkspaceGuard(str(tmp_path), mutation_journal=recorder),
        {"name": "run_temp_script", "arguments": {}},
    )

    assert "error" in response
    assert recorder.calls == [("run_temp_script", None)]


def test_result_without_change_evidence_reports_unknown(tmp_path: Path) -> None:
    tool = builtin_server.BuiltinTool(
        name="python_execute",
        description="test",
        side_effecting=True,
        input_schema={"type": "object", "properties": {}},
        handler=lambda arguments, workspace: "printed",
    )
    recorder = _ResultRecorder()
    builtin_server._handle_tools_call(
        "request-4",
        {"python_execute": tool},
        WorkspaceGuard(str(tmp_path), mutation_journal=recorder),
        {"name": "python_execute", "arguments": {}},
    )

    assert recorder.calls == [("python_execute", None)]


def test_rejected_arguments_are_not_observed_as_a_call(tmp_path: Path) -> None:
    recorder = _ResultRecorder()
    workspace = WorkspaceGuard(str(tmp_path), mutation_journal=recorder)
    tools = builtin_server._default_tools({"tools_shell_enabled": True})

    response = builtin_server._handle_tools_call(
        "request-5", tools, workspace, {"name": "run_command", "arguments": {}}
    )

    assert "error" in response
    assert recorder.calls == []
