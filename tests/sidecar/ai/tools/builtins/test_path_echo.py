"""Red-first contract for W2b path echoes (tool-contract program §2.4).

The Session Environment overlay states the root at prompt level; these tools
must echo where they actually operated at result level, in `output` (the only
surface the model sees — metadata is dropped by `engine_messages`).
"""

from __future__ import annotations

import json
from pathlib import Path

from sidecar.ai.tools.builtins.filesystem_listing import list_dir_tool
from sidecar.ai.tools.builtins.glob_files import glob_files_tool
from sidecar.ai.tools.builtins.grep_search import grep_search_tool
from sidecar.ai.tools.builtins.shell import run_command_tool
from sidecar.ai.tools.workspace import WorkspaceGuard


def _guard(tmp_path: Path) -> WorkspaceGuard:
    return WorkspaceGuard(str(tmp_path))


def _fixture(tmp_path: Path) -> None:
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "app.py").write_text("def main():\n    pass\n", encoding="utf-8")
    (tmp_path / "notes.txt").write_text("aurora\n", encoding="utf-8")


def test_list_dir_echoes_relative_path_and_entry_count(tmp_path: Path) -> None:
    _fixture(tmp_path)
    result = list_dir_tool({"path": "src"}, _guard(tmp_path))
    lines = result.output.splitlines()
    assert lines[0] == "path: src (workspace-relative) entries: 1"
    assert lines[1] == ""
    assert any(line.startswith("[F] app.py") for line in lines[2:])


def test_list_dir_root_echoes_dot(tmp_path: Path) -> None:
    _fixture(tmp_path)
    result = list_dir_tool({"path": "."}, _guard(tmp_path))
    first = result.output.splitlines()[0]
    assert first.startswith("path: . (workspace-relative) entries: ")


def test_list_dir_empty_directory_keeps_echo(tmp_path: Path) -> None:
    (tmp_path / "empty").mkdir()
    result = list_dir_tool({"path": "empty"}, _guard(tmp_path))
    lines = result.output.splitlines()
    assert lines[0] == "path: empty (workspace-relative) entries: 0"
    assert "(empty directory)" in result.output


def test_glob_files_echoes_search_root(tmp_path: Path) -> None:
    _fixture(tmp_path)
    result = glob_files_tool({"pattern": "**/*.py"}, _guard(tmp_path))
    first = result.output.splitlines()[0]
    assert first.startswith("path: . (workspace-relative)")
    assert "src/app.py" in result.output


def test_grep_search_echoes_search_root(tmp_path: Path) -> None:
    _fixture(tmp_path)
    result = grep_search_tool({"pattern": "main"}, _guard(tmp_path))
    first = result.output.splitlines()[0]
    assert first.startswith("path: . (workspace-relative)")


def test_run_command_cwd_is_workspace_relative(tmp_path: Path) -> None:
    _fixture(tmp_path)
    result = run_command_tool(
        {"command": "echo aurora-echo", "timeout_seconds": 30}, _guard(tmp_path)
    )
    payload = json.loads(result.output)
    assert payload["cwd"] == "."
    assert str(tmp_path) not in result.output

    sub = run_command_tool(
        {"command": "echo aurora-echo", "timeout_seconds": 30, "cwd": "src"},
        _guard(tmp_path),
    )
    sub_payload = json.loads(sub.output)
    assert sub_payload["cwd"] == "src"
