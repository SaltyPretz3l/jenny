"""Platform-shell selection tests for the run_command tool."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest

from sidecar.ai.error_codes import CMP_TOOL_COMMAND_BLOCKED
from sidecar.ai.tools.builtins import shell as shell_module
from sidecar.ai.tools.builtins import shell_command_split as shell_command_split_module
from sidecar.ai.tools.builtins.shell import _shell_argv, run_command_tool
from sidecar.ai.tools.builtins.shell_command_split import cmd_exe_multiline_refusal
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.workspace import WorkspaceGuard


def test_windows_uses_resolved_cmd_with_hardening_flags(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("sidecar.ai.tools.builtins.shell.os.name", "nt")
    monkeypatch.setattr(
        "sidecar.ai.tools.builtins.shell.shutil.which",
        lambda name: "C:\\Windows\\System32\\cmd.exe" if name == "cmd.exe" else None,
    )

    assert _shell_argv('echo "hello" && cd .') == [
        "C:\\Windows\\System32\\cmd.exe",
        "/d",
        "/s",
        "/c",
        'echo "hello" && cd .',
    ]


def test_windows_fails_before_bootstrap_when_cmd_is_unavailable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("sidecar.ai.tools.builtins.shell.os.name", "nt")
    monkeypatch.setattr("sidecar.ai.tools.builtins.shell.shutil.which", lambda _name: None)

    with pytest.raises(
        ToolExecutionFailure,
        match="shell interpreter is unavailable: cmd.exe",
    ):
        _shell_argv("echo ok")


def test_posix_uses_resolved_bin_sh(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("sidecar.ai.tools.builtins.shell.os.name", "posix")
    monkeypatch.setattr(
        "sidecar.ai.tools.builtins.shell.shutil.which",
        lambda name: "/bin/sh" if name == "/bin/sh" else None,
    )

    assert _shell_argv("printf ok && pwd") == [
        "/bin/sh",
        "-c",
        "printf ok && pwd",
    ]


def test_posix_fails_before_bootstrap_when_bin_sh_is_unavailable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("sidecar.ai.tools.builtins.shell.os.name", "posix")
    monkeypatch.setattr("sidecar.ai.tools.builtins.shell.shutil.which", lambda _name: None)

    with pytest.raises(
        ToolExecutionFailure,
        match="shell interpreter is unavailable: /bin/sh",
    ):
        _shell_argv("printf ok")


# ── HB-013: cmd.exe /c runs only the first line of a multi-line command ──


_CMD_EXE = r"C:\Windows\System32\cmd.exe"


class _PlatformOs:
    """Module-local ``os`` stand-in: patching ``os.name`` itself would flip
    pathlib to PosixPath for the whole interpreter on a Windows test host."""

    def __init__(self, name: str) -> None:
        self.name = name

    def __getattr__(self, attribute: str) -> object:
        return getattr(os, attribute)


def _use_platform(monkeypatch: pytest.MonkeyPatch, name: str) -> None:
    monkeypatch.setattr(shell_module, "os", _PlatformOs(name))
    monkeypatch.setattr(shell_command_split_module, "os", _PlatformOs(name))


def _record_process_starts(monkeypatch: pytest.MonkeyPatch) -> list[list[str]]:
    started: list[list[str]] = []

    def _fake_run(argv, **_kwargs):
        started.append(list(argv))
        return SimpleNamespace(returncode=0, stdout="ok\n", stderr="")

    def _fake_background(argv, **_kwargs):
        started.append(list(argv))
        raise AssertionError("a refused command must not start a background job")

    monkeypatch.setattr(shell_module, "_run_owned_process", _fake_run)
    monkeypatch.setattr(shell_module, "start_background_job", _fake_background)
    return started


def _as_windows(monkeypatch: pytest.MonkeyPatch) -> None:
    _use_platform(monkeypatch, "nt")
    monkeypatch.setattr(
        "sidecar.ai.tools.builtins.shell.shutil.which",
        lambda name: _CMD_EXE if name == "cmd.exe" else None,
    )


def _as_posix(monkeypatch: pytest.MonkeyPatch) -> None:
    _use_platform(monkeypatch, "posix")
    monkeypatch.setattr(
        "sidecar.ai.tools.builtins.shell.shutil.which",
        lambda name: "/bin/sh" if name == "/bin/sh" else None,
    )


@pytest.mark.parametrize(
    "command",
    [
        # The dogfood HB-013 shapes: three chained lines, and python -c with
        # its program on the following lines (ran as an empty program, exit 0).
        "py -m bank_recon synth --out run1\npy -m bank_recon synth --out run2\n"
        "python -c \"\nprint('compare')\n\"",
        "python -c \"\nimport hashlib\nprint(hashlib.sha256(b'x').hexdigest())\n\"",
        "echo one\r\necho two",
        "echo one\recho two",
        "echo one^\necho two",
    ],
)
@pytest.mark.parametrize("background", [False, True])
def test_windows_refuses_multiline_command_before_any_process_starts(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, command: str, background: bool,
) -> None:
    _as_windows(monkeypatch)
    started = _record_process_starts(monkeypatch)
    arguments: dict[str, object] = {"command": command}
    if background:
        arguments["run_in_background"] = True

    with pytest.raises(ToolExecutionFailure) as caught:
        run_command_tool(arguments, WorkspaceGuard(str(tmp_path)))

    assert caught.value.code == CMP_TOOL_COMMAND_BLOCKED
    assert caught.value.retryable is False
    message = caught.value.message
    assert "first line" in message
    assert "one command per call" in message
    assert "run_temp_script" in message
    assert started == []


def test_windows_single_line_command_with_padding_newlines_still_runs(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    _as_windows(monkeypatch)
    started = _record_process_starts(monkeypatch)

    result = run_command_tool(
        {"command": "\r\n  echo one && echo two  \n"}, WorkspaceGuard(str(tmp_path)),
    )

    assert result.success is True
    assert started == [[
        _CMD_EXE, "/d", "/s", "/c", "echo one && echo two",
    ]]


def test_posix_shell_keeps_running_every_line_of_a_multiline_command(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    _as_posix(monkeypatch)
    started = _record_process_starts(monkeypatch)

    result = run_command_tool(
        {"command": "echo one\necho two\npython3 -c \"\nprint('x')\n\""},
        WorkspaceGuard(str(tmp_path)),
    )

    assert result.success is True
    assert started == [["/bin/sh", "-c", "echo one\necho two\npython3 -c \"\nprint('x')\n\""]]


@pytest.mark.parametrize(
    ("platform", "command", "refused"),
    [
        ("nt", "echo one\necho two", True),
        ("nt", "echo one & echo two", False),
        ("nt", "  echo one\n", False),
        ("posix", "echo one\necho two", False),
    ],
)
def test_cmd_exe_multiline_refusal_predicate(
    monkeypatch: pytest.MonkeyPatch, platform: str, command: str, refused: bool,
) -> None:
    _use_platform(monkeypatch, platform)

    assert (cmd_exe_multiline_refusal(command) is not None) is refused


@pytest.mark.skipif(os.name != "nt", reason="pins the real cmd.exe behaviour behind HB-013")
def test_real_cmd_exe_drops_every_line_after_the_first() -> None:
    completed = subprocess.run(
        [shutil.which("cmd.exe") or "cmd.exe", "/d", "/s", "/c", "echo one\necho two"],
        capture_output=True, text=True, check=False, timeout=30,
    )

    assert completed.returncode == 0
    assert completed.stdout.split() == ["one"]


@pytest.mark.skipif(os.name == "nt", reason="POSIX /bin/sh runs every line")
def test_real_posix_shell_runs_every_line(tmp_path: Path) -> None:
    result = run_command_tool({"command": "echo one\necho two"}, WorkspaceGuard(str(tmp_path)))

    assert json.loads(result.output)["stdout"].split() == ["one", "two"]
