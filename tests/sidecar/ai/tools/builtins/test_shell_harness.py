"""Shared noninteractive environment and bounded stream contracts."""

from types import SimpleNamespace

import pytest

from sidecar.ai.tools.builtins import shell_harness, shell_settings


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
