"""Platform-shell selection tests for the run_command tool."""

from __future__ import annotations

import pytest

from sidecar.ai.tools.builtins.shell import _shell_argv
from sidecar.ai.tools.contracts import ToolExecutionFailure


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
