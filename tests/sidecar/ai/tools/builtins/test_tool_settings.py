"""Regression coverage for shared mutable builtin-tool settings."""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from sidecar.ai.tools.builtins import git_ops as git_ops_module
from sidecar.ai.tools.builtins.filesystem import write_file_tool
from sidecar.ai.tools.builtins.filesystem_settings import configure_filesystem_tools
from sidecar.ai.tools.builtins.git_ops import git_status_tool
from sidecar.ai.tools.builtins.git_ops_settings import configure_git_tools
from sidecar.ai.tools.builtins.grep_search import grep_search_tool
from sidecar.ai.tools.builtins.grep_search_settings import configure_grep_search
from sidecar.ai.tools.builtins.lsp.tools import lsp_tool
from sidecar.ai.tools.builtins.lsp_settings import configure_lsp_tools
from sidecar.ai.tools.builtins.shell import run_command_tool
from sidecar.ai.tools.builtins.shell_settings import configure_shell_security
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.workspace import WorkspaceGuard


def _guard(path: Path) -> WorkspaceGuard:
    return WorkspaceGuard(str(path))


def test_filesystem_handler_reads_settings_container_after_configure(tmp_path: Path) -> None:
    configure_filesystem_tools({"tools_max_edit_file_bytes": 4})
    try:
        result = write_file_tool(
            {"path": "bounded.txt", "content": "12345"},
            _guard(tmp_path),
        )
        assert result.success is False
        assert "exceeds 4 byte limit" in result.output
    finally:
        configure_filesystem_tools(None)


def test_git_handler_reads_settings_container_after_configure(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    (tmp_path / ".git").mkdir()
    observed_timeouts: list[float] = []

    def _run_owned(
        arguments: list[str],
        *,
        cwd: Path,
        timeout_seconds: float,
        env: dict[str, str],
    ) -> object:
        del arguments, cwd, env
        observed_timeouts.append(timeout_seconds)
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    monkeypatch.setattr(git_ops_module, "_run_owned_process", _run_owned)
    configure_git_tools({"tools_git_timeout_seconds": 7})
    try:
        assert git_status_tool({}, _guard(tmp_path)) == "(clean working tree)"
        assert observed_timeouts == [7.0]
    finally:
        configure_git_tools(None)


def test_grep_handler_reads_settings_container_after_configure(tmp_path: Path) -> None:
    configure_grep_search({"tools_max_search_file_bytes": 1024})
    try:
        (tmp_path / "large.txt").write_text("needle\n" * 300, encoding="utf-8")
        result = grep_search_tool({"pattern": "needle"}, _guard(tmp_path))
        assert result.success is False
        assert result.metadata["skipped_large_files"] == 1
    finally:
        configure_grep_search(None)


def test_shell_handler_reads_settings_container_after_configure(tmp_path: Path) -> None:
    configure_shell_security({"shell_security": True})
    try:
        with pytest.raises(ToolExecutionFailure, match="blocked"):
            run_command_tool({"command": ":(){:|:&};:"}, _guard(tmp_path))
    finally:
        configure_shell_security({"shell_security": False})


def test_lsp_handler_reads_settings_container_after_configure(tmp_path: Path) -> None:
    target = tmp_path / "module.py"
    target.write_text("print('ready')\n", encoding="utf-8")
    configure_lsp_tools({"tools_lsp_enabled": True}, detected_servers={})
    try:
        result = lsp_tool(
            {"action": "diagnostics", "path": "module.py"},
            _guard(tmp_path),
        )
        payload = json.loads(result.output)
        assert payload["reason"] == "No language server is available for this language"
    finally:
        configure_lsp_tools({"tools_lsp_enabled": False}, detected_servers={})
