from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

from sidecar.ai.mcp import builtin_server
from sidecar.ai.tools.builtins import worktree_change_tracking as tracking
from sidecar.ai.tools.workspace import WorkspaceGuard


def _call(tools, workspace, name: str, arguments: dict[str, object]) -> dict[str, object]:
    response = builtin_server._handle_tools_call(  # noqa: SLF001
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
    tools = builtin_server._default_tools(shell_enabled=True)  # noqa: SLF001
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
    response = builtin_server._handle_tools_call(  # noqa: SLF001
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
    response = builtin_server._handle_tools_call(  # noqa: SLF001
        "request-2",
        {"mutation": tool},
        WorkspaceGuard(str(tmp_path)),
        {"name": "mutation", "arguments": {}},
    )
    assert response["result"]["content"][0]["text"] == "primary success"
