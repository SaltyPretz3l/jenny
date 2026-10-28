"""Shared noninteractive environment and bounded stream contracts."""

from types import SimpleNamespace

import pytest

from sidecar.ai.tools.builtins import shell_harness, shell_settings
from tests.sidecar._platform_skips import windows_only


@pytest.mark.parametrize("platform", ["posix", "nt"])
def test_noninteractive_env_overrides_interactive_settings(monkeypatch, platform):
    monkeypatch.setattr(shell_harness, "os", SimpleNamespace(name=platform))
    base = {"PATH": "keep", "GIT_EDITOR": "code --wait", "git_editor": "other"}
    result = shell_harness.noninteractive_env(base)
    assert result is not base
    assert base["GIT_EDITOR"] == "code --wait"
    assert result["PATH"] == "keep"
    assert result["PAGER"] == result["GIT_PAGER"] == "cat"
    assert result["GIT_EDITOR"] == result["GIT_SEQUENCE_EDITOR"] == "false"
    assert result["GIT_TERMINAL_PROMPT"] == "0"
    assert result["GIT_EXTERNAL_DIFF"] == ""
    assert result["GCM_INTERACTIVE"] == "never"
    assert ("git_editor" in result) is (platform != "nt")


@pytest.mark.parametrize("head,tail", [(14, 6), (6, 14), (20, 0), (0, 20)])
def test_head_tail_preserves_edges_and_places_marker(head, tail):
    text = "abcdefghijklmnopqrstuvwxyz"
    marker = "\n...[middle truncated]\n"
    result = shell_harness.head_tail(text, head=head, tail=tail, marker=marker)
    assert result == text[:head] + marker + (text[-tail:] if tail else "")
    assert len(result) == head + tail + len(marker)


@pytest.mark.parametrize("text", ["", "short", "x" * 20])
def test_head_tail_under_cap_is_unchanged(text):
    assert shell_harness.head_tail(text, head=14, tail=6, marker="cut") == text


@pytest.mark.parametrize("flags", [{}, {"shell_noninteractive_env": False}])
def test_windows_shell_environment_disables_cwd_executable_lookup(monkeypatch, flags):
    """A bare `git` must resolve from PATH, never from a repo that ships `git.cmd`."""
    saved = dict(shell_settings._FEATURE_FLAGS)
    base = {"PATH": r"C:\Windows\System32", "NODEFAULTCURRENTDIRECTORYINEXEPATH": "0"}
    monkeypatch.setattr(shell_harness, "os", SimpleNamespace(
        name="nt", environ=base, pathsep=";", path=shell_harness.os.path))
    try:
        shell_settings.configure_shell_security(flags)
        env = shell_harness.shell_environment(None)
        assert env is not None
        assert env["NoDefaultCurrentDirectoryInExePath"] == "1"
        assert "NODEFAULTCURRENTDIRECTORYINEXEPATH" not in env
        assert env["PATH"] == base["PATH"]
        background = shell_harness.background_spawn_environment()
        assert background is not None
        assert background["NoDefaultCurrentDirectoryInExePath"] == "1"
    finally:
        shell_settings.configure_shell_security(saved)


@windows_only("cmd.exe lookup semantics")
def test_cmd_exe_skips_cwd_for_bare_names_with_hardened_env(tmp_path):
    """End to end: a planted `jennyplanted.cmd` in cwd is not found by a bare name."""
    import subprocess
    planted = tmp_path / "jennyplanted.cmd"
    planted.write_text("@echo PLANTED\r\n", encoding="ascii")
    hardened = shell_harness.shell_environment(None)
    assert hardened is not None
    run = subprocess.run(
        ["cmd.exe", "/d", "/s", "/c", "jennyplanted"], cwd=tmp_path, env=hardened,
        capture_output=True, text=True, timeout=30, check=False,
    )
    assert "PLANTED" not in run.stdout, run.stdout
    assert run.returncode != 0
    control = subprocess.run(
        ["cmd.exe", "/d", "/s", "/c", "jennyplanted"], cwd=tmp_path,
        env={k: v for k, v in hardened.items()
             if k.upper() != "NODEFAULTCURRENTDIRECTORYINEXEPATH"},
        capture_output=True, text=True, timeout=30, check=False,
    )
    assert "PLANTED" in control.stdout, "control run should prove cwd lookup exists"


@pytest.mark.parametrize("flags", [{}, {"shell_noninteractive_env": True},
                                  {"shell_noninteractive_env": False}])
def test_posix_shell_environment_preserves_legacy_none_only_when_disabled(monkeypatch, flags):
    saved = dict(shell_settings._FEATURE_FLAGS)
    base = {"PATH": "/usr/bin", "GIT_EDITOR": "code --wait"}
    monkeypatch.setattr(shell_harness, "os", SimpleNamespace(name="posix", environ=base))
    try:
        shell_settings.configure_shell_security(flags)
        env = shell_harness.shell_environment(None)
        if flags.get("shell_noninteractive_env") is False:
            assert env is None
        else:
            assert env["PATH"] == "/usr/bin"
            assert env["GIT_EDITOR"] == "false"
    finally:
        shell_settings.configure_shell_security(saved)
