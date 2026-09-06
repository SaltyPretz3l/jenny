"""Feature-flag / config threading into the builtin-tools MCP subprocess.

``run_command`` executes inside this subprocess, so the shell-security classifier
and git-tracking telemetry are permanently disabled unless the ``shell_security``
and ``git_tracking`` feature flags cross the process boundary. These tests pin the
full path: container argv -> ``main`` argparse -> ``_default_tools`` -> module state.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from sidecar.ai.config import RuntimeConfig
from sidecar.ai.container import _default_mcp_servers
from sidecar.ai.mcp import builtin_server
from sidecar.ai.tools.builtins import shell as shell_module
from sidecar.ai.tools.workspace import WorkspaceGuard


def _reset_shell_flags() -> None:
    # configure_shell_security() updates (never replaces) module state, so every
    # test explicitly drives both flags to a known baseline before and after.
    shell_module.configure_shell_security({"shell_security": False, "git_tracking": False})


# ── _default_tools threading ──────────────────────────────────────────


def test_default_tools_enable_shell_security_classifier() -> None:
    _reset_shell_flags()
    try:
        builtin_server._default_tools(  # noqa: SLF001
            shell_enabled=True,
            shell_security_enabled=True,
        )
        assert shell_module._shell_security_enabled() is True  # noqa: SLF001
    finally:
        _reset_shell_flags()


def test_default_tools_enable_git_tracking() -> None:
    _reset_shell_flags()
    try:
        builtin_server._default_tools(  # noqa: SLF001
            shell_enabled=True,
            git_tracking_enabled=True,
        )
        assert shell_module._git_tracking_enabled() is True  # noqa: SLF001
    finally:
        _reset_shell_flags()


def test_default_tools_leave_shell_security_and_git_tracking_off_by_default() -> None:
    # Baseline them ON so a no-op (the bug) would leave them ON and fail the assert.
    shell_module.configure_shell_security({"shell_security": True, "git_tracking": True})
    try:
        builtin_server._default_tools(shell_enabled=True)  # noqa: SLF001
        assert shell_module._shell_security_enabled() is False  # noqa: SLF001
        assert shell_module._git_tracking_enabled() is False  # noqa: SLF001
    finally:
        _reset_shell_flags()


def test_default_tools_expose_complete_background_job_lifecycle() -> None:
    tools = builtin_server._default_tools(shell_enabled=True)  # noqa: SLF001

    assert "run_command" in tools
    assert "check_background_job" in tools
    assert "stop_background_job" in tools
    assert tools["check_background_job"].side_effecting is False
    assert tools["stop_background_job"].side_effecting is True


def test_default_tools_shell_security_arms_classification_metadata(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
) -> None:
    # Behavioral proof: the classifier only attaches classification metadata when
    # _shell_security_enabled() is true inside the handler that actually runs.
    _reset_shell_flags()
    try:
        tools = builtin_server._default_tools(  # noqa: SLF001
            shell_enabled=True,
            shell_security_enabled=True,
        )
        # Patch the owned-process seam, not subprocess.run: real execution goes
        # through OwnedProcessService.run(), which uses Popen, so a subprocess.run
        # fake is never called here and the command would run for real.
        monkeypatch.setattr(
            shell_module,
            "_run_owned_process",
            lambda *a, **kw: SimpleNamespace(returncode=0, stdout="ok", stderr=""),
        )
        result = tools["run_command"].handler({"command": "ls"}, WorkspaceGuard(str(tmp_path)))
        assert "classification" in result.metadata
        assert result.metadata["classification"]["verdict"] == "allowed"
    finally:
        _reset_shell_flags()


def test_default_tools_no_classification_metadata_when_shell_security_off(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
) -> None:
    _reset_shell_flags()
    try:
        tools = builtin_server._default_tools(shell_enabled=True)  # noqa: SLF001
        # Patch the owned-process seam, not subprocess.run: real execution goes
        # through OwnedProcessService.run(), which uses Popen, so a subprocess.run
        # fake is never called here and the command would run for real.
        monkeypatch.setattr(
            shell_module,
            "_run_owned_process",
            lambda *a, **kw: SimpleNamespace(returncode=0, stdout="ok", stderr=""),
        )
        result = tools["run_command"].handler({"command": "ls"}, WorkspaceGuard(str(tmp_path)))
        assert "classification" not in result.metadata
    finally:
        _reset_shell_flags()


def test_default_tools_gate_delete_file_tool() -> None:
    enabled = builtin_server._default_tools()  # noqa: SLF001 — default True
    disabled = builtin_server._default_tools(delete_file_enabled=False)  # noqa: SLF001

    assert "delete_file" in enabled
    assert "delete_file" not in disabled


def test_default_tools_hide_workspace_tools_when_root_is_absent() -> None:
    tools = builtin_server._default_tools(workspace_root_present=False)  # noqa: SLF001

    assert "read_file" not in tools
    assert "list_dir" not in tools
    assert "git_status" not in tools
    assert "load_skill" in tools


# ── main() argparse plumbing ──────────────────────────────────────────


def _run_main_capturing_kwargs(
    monkeypatch: pytest.MonkeyPatch,
    argv: list[str],
) -> dict[str, object]:
    captured: dict[str, object] = {}

    def fake_default_tools(**kwargs):
        captured.update(kwargs)
        return {}

    monkeypatch.setattr(builtin_server, "_default_tools", fake_default_tools)
    monkeypatch.setattr(
        builtin_server.sys,
        "stdin",
        type("EmptyStdin", (), {"readline": staticmethod(lambda: "")})(),
    )
    builtin_server.main(argv)
    return captured


def test_main_threads_shell_security_and_git_tracking(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
) -> None:
    captured = _run_main_capturing_kwargs(
        monkeypatch,
        [
            "--workspace-root",
            str(tmp_path),
            "--shell-enabled",
            "1",
            "--shell-security-enabled",
            "1",
            "--git-tracking-enabled",
            "1",
        ],
    )

    assert captured["shell_security_enabled"] is True
    assert captured["git_tracking_enabled"] is True


def test_main_defaults_shell_security_and_git_tracking_off(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
) -> None:
    captured = _run_main_capturing_kwargs(
        monkeypatch,
        ["--workspace-root", str(tmp_path)],
    )

    assert captured["shell_security_enabled"] is False
    assert captured["git_tracking_enabled"] is False


def test_main_threads_delete_file_flag(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
) -> None:
    captured = _run_main_capturing_kwargs(
        monkeypatch,
        ["--workspace-root", str(tmp_path), "--delete-file-enabled", "0"],
    )

    assert captured["delete_file_enabled"] is False


def test_container_emitted_argv_parses_in_main_without_systemexit(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
) -> None:
    # Parity guard across BOTH files: the exact argv the container emits must be
    # accepted by main()'s parser, or the real subprocess dies at startup. Fails
    # loudly if any future container flag lacks a matching parser dest.
    config = RuntimeConfig(
        tools_shell_enabled=True,
        tools_delete_file_enabled=False,
        tools_image_read_enabled=True,
        tools_todo_enabled=True,
        tools_web_searxng_url="http://searx.local",
        feature_flags={"shell_security": True, "git_tracking": True},
        tools_load_skill_enabled=True,
        skills_bundled_root="C:\\jenny\\skills",
        skills_user_root="C:\\Users\\me\\.jenny\\skills",
        skills_user_enabled=False,
        skills_disabled_ids=("bundled/verification-specialist", "user/team/review"),
        skills_auto_index="off",
    )
    servers = _default_mcp_servers(config, tmp_path)  # noqa: SLF001
    argv = list(servers[0].args)
    # main() receives only the flag args; the python -m module-selection prefix is
    # consumed by the interpreter. --workspace-root is always the first flag.
    flag_argv = argv[argv.index("--workspace-root"):]

    captured = _run_main_capturing_kwargs(monkeypatch, flag_argv)

    assert captured["shell_security_enabled"] is True
    assert captured["git_tracking_enabled"] is True
    assert captured["delete_file_enabled"] is False
    assert captured["image_read_enabled"] is True
    assert captured["todo_enabled"] is True
    assert captured["web_searxng_url"] == "http://searx.local"
    assert captured["load_skill_enabled"] is True
    assert captured["skills_bundled_root"] == "C:\\jenny\\skills"
    assert captured["skills_user_root"] == "C:\\Users\\me\\.jenny\\skills"
    assert captured["skills_user_enabled"] is False
    assert captured["skills_disabled_ids"] == (
        "bundled/verification-specialist",
        "user/team/review",
    )
    assert captured["skills_auto_index"] == "off"


# ── load_skill scope-root threading ────────────────────────────────────


def test_main_threads_skill_scope_roots(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
) -> None:
    captured = _run_main_capturing_kwargs(
        monkeypatch,
        [
            "--workspace-root",
            str(tmp_path),
            "--skill-bundled-root",
            "C:\\jenny\\skills",
            "--skill-bundled-enabled",
            "1",
            "--skill-user-root",
            "C:\\Users\\me\\.jenny\\skills",
            "--skill-user-enabled",
            "0",
            "--skill-project-root",
            "D:\\proj\\.jenny\\skills",
            "--load-skill-enabled",
            "1",
            "--skill-disabled-id",
            "bundled/verification-specialist",
            "--skill-disabled-id",
            "project/team/review",
            "--skill-auto-index",
            "on",
        ],
    )

    assert captured["skills_bundled_root"] == "C:\\jenny\\skills"
    assert captured["skills_bundled_enabled"] is True
    assert captured["skills_user_root"] == "C:\\Users\\me\\.jenny\\skills"
    assert captured["skills_user_enabled"] is False
    assert captured["skills_project_root"] == "D:\\proj\\.jenny\\skills"
    assert captured["load_skill_enabled"] is True
    assert captured["skills_disabled_ids"] == (
        "bundled/verification-specialist",
        "project/team/review",
    )
    assert captured["skills_auto_index"] == "on"


def test_main_defaults_skill_scope_roots_to_none_and_load_skill_on(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
) -> None:
    captured = _run_main_capturing_kwargs(
        monkeypatch,
        ["--workspace-root", str(tmp_path)],
    )

    assert captured["skills_bundled_root"] is None
    assert captured["skills_user_root"] is None
    assert captured["skills_project_root"] is None
    assert captured["load_skill_enabled"] is True
    assert captured["skills_disabled_ids"] == ()
    assert captured["skills_auto_index"] == "auto"


def test_default_tools_binds_load_skill_by_default() -> None:
    tools = builtin_server._default_tools()  # noqa: SLF001
    assert "load_skill" in tools


def test_default_tools_omits_load_skill_when_disabled() -> None:
    tools = builtin_server._default_tools(load_skill_enabled=False)  # noqa: SLF001
    assert "load_skill" not in tools
