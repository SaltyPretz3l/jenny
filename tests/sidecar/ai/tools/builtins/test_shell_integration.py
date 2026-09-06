"""Integration tests for the command execution hardening pipeline.

Verifies the full flow: classification -> execution -> git tracking
-> response assembly, background job lifecycle, and large output
persistence.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

from sidecar.ai.tools.builtins import shell as shell_module
from sidecar.ai.tools.builtins.shell import (
    _parse_command,
    _shell_argv,
    configure_shell_security,
    run_command_tool,
)
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.workspace import WorkspaceGuard


def _guard(tmp_path: Path) -> WorkspaceGuard:
    return WorkspaceGuard(str(tmp_path))


@pytest.fixture(autouse=True)
def _reset_flags() -> None:
    """Ensure clean flag state between tests."""
    configure_shell_security({"shell_security": False, "git_tracking": False})
    yield  # type: ignore[misc]
    configure_shell_security({"shell_security": False, "git_tracking": False})


@pytest.fixture(autouse=True)
def _owned_process_adapter(monkeypatch: pytest.MonkeyPatch) -> None:
    """Route existing subprocess fakes through the owned-process seam."""

    def _run_owned(
        argv: list[str],
        *,
        cwd: Path,
        timeout_seconds: float,
    ) -> object:
        launch_args: list[str] | str = argv
        if (
            shell_module.os.name == "nt"
            and len(argv) == 5
            and Path(argv[0]).name.lower() in {"cmd", "cmd.exe"}
        ):
            launch_args = f'{subprocess.list2cmdline(argv[:4])} "{argv[4]}"'
        return subprocess.run(
            launch_args,
            cwd=str(cwd),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout_seconds,
            check=False,
        )

    monkeypatch.setattr(shell_module, "_run_owned_process", _run_owned)


# ── Full pipeline: classify + execute + track ─────────────────────────


def test_full_pipeline_safe_git_commit(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """Classifier labels git commit as needs_approval, execution runs,
    git tracking detects the commit in stdout."""
    configure_shell_security({"shell_security": True, "git_tracking": True})
    monkeypatch.setattr(
        "sidecar.ai.tools.builtins.shell.subprocess.run",
        lambda *a, **kw: SimpleNamespace(
            returncode=0,
            stdout="[feature abc1234] add tests\n 3 files changed",
            stderr="",
        ),
    )
    result = run_command_tool({"command": "git commit -m 'add tests'"}, _guard(tmp_path))
    body = json.loads(result.output)

    # Classification metadata present
    assert result.metadata["classification"]["verdict"] == "needs_approval"
    assert "git write" in result.metadata["classification"]["reason"]

    # Git tracking found the commit
    assert len(body["git_operations"]) == 1
    op = body["git_operations"][0]
    assert op["kind"] == "commit"
    assert op["sha"] == "abc1234"
    assert op["branch"] == "feature"


def test_full_pipeline_blocked_command(tmp_path: Path) -> None:
    """Classifier blocks destructive commands before execution."""
    configure_shell_security({"shell_security": True})
    with pytest.raises(ToolExecutionFailure, match="blocked"):
        run_command_tool({"command": "rm -rf /"}, _guard(tmp_path))


def test_full_pipeline_safe_read_command(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """Safe read-only command flows through without git tracking output."""
    configure_shell_security({"shell_security": True, "git_tracking": True})
    monkeypatch.setattr(
        "sidecar.ai.tools.builtins.shell.subprocess.run",
        lambda *a, **kw: SimpleNamespace(returncode=0, stdout="file.txt\n", stderr=""),
    )
    result = run_command_tool({"command": "ls"}, _guard(tmp_path))
    body = json.loads(result.output)
    assert body["ok"] is True
    assert result.metadata["classification"]["verdict"] == "allowed"
    assert "git_operations" not in body


# ── Semantic exit codes with classification ───────────────────────────


def test_semantic_exit_with_classifier(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    configure_shell_security({"shell_security": True})
    monkeypatch.setattr(
        "sidecar.ai.tools.builtins.shell.subprocess.run",
        lambda *a, **kw: SimpleNamespace(returncode=1, stdout="", stderr=""),
    )
    result = run_command_tool({"command": "grep pattern file"}, _guard(tmp_path))
    body = json.loads(result.output)
    assert body["ok"] is True
    assert body["semantic_note"] == "no matches found"


# ── Shell command preservation and quoting ────────────────────────────


def test_parse_command_preserves_quoted_executable_path_for_platform_shell() -> None:
    command = _parse_command(
        {"command": '"C:\\Program Files\\Python311\\python.exe" "script file.py" --flag'}
    )
    assert command == '"C:\\Program Files\\Python311\\python.exe" "script file.py" --flag'


def test_platform_shell_receives_the_whole_compound_command(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(shell_module.os, "name", "posix")
    monkeypatch.setattr(shell_module.shutil, "which", lambda _name: "/bin/sh")
    command = _parse_command({"command": "printf one && printf two"})

    assert _shell_argv(command) == ["/bin/sh", "-c", "printf one && printf two"]


def test_quoted_interpreter_and_spaced_script_path_executes(tmp_path: Path) -> None:
    """End-to-end regression: a quoted interpreter path plus a quoted script
    path containing spaces must launch and produce output."""
    spaced_dir = tmp_path / "dir with space"
    spaced_dir.mkdir()
    script = spaced_dir / "hello script.py"
    script.write_text("print('spaced-ok')", encoding="utf-8")

    command = f'"{sys.executable}" "{script}"'
    result = run_command_tool({"command": command}, _guard(tmp_path))
    body = json.loads(result.output)
    assert body["ok"] is True, body.get("stderr")
    assert body["exit_code"] == 0
    assert "spaced-ok" in body["stdout"]


# ── Registry integration ─────────────────────────────────────────────


def test_registry_includes_new_tools() -> None:
    from sidecar.ai.tools.registry import build_default_registry

    reg = build_default_registry(
        config={
            "tools_shell_enabled": True,
            "tools_todo_enabled": True,
            "feature_flags": {"shell_security": True},
        }
    )
    assert "run_command" in reg
    assert "check_background_job" in reg
    assert "stop_background_job" in reg
    assert "todo_write" in reg
    assert "todo_read" in reg
    assert reg["check_background_job"].side_effecting is False
    assert reg["stop_background_job"].side_effecting is True
    assert reg["todo_write"].side_effecting is True
    assert reg["todo_read"].side_effecting is False


def test_registry_omits_tools_when_disabled() -> None:
    from sidecar.ai.tools.registry import build_default_registry

    reg = build_default_registry(
        config={
            "tools_shell_enabled": False,
            "tools_todo_enabled": False,
        }
    )
    assert "run_command" not in reg
    assert "check_background_job" not in reg
    assert "stop_background_job" not in reg
    assert "todo_write" not in reg
    assert "todo_read" not in reg
