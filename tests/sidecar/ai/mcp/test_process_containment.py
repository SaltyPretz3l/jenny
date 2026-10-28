from __future__ import annotations

import signal
from pathlib import Path
from types import SimpleNamespace

import pytest

from sidecar.ai.config import MCPServerConfig
from sidecar.ai.config_parsing import _parse_mcp_servers, mcp_env_key_rejection
from sidecar.ai.mcp import process_containment as module
from sidecar.ai.mcp.process_containment import MCPProcessContainment
from tests.sidecar._platform_skips import windows_only


@pytest.mark.parametrize("exited", [False, True])
def test_group_cleanup_escalates_after_parent_exit(monkeypatch: pytest.MonkeyPatch, exited: bool) -> None:
    containment = MCPProcessContainment(MCPServerConfig(name="test", transport="stdio", command="python"))
    process = SimpleNamespace(pid=12345, poll=lambda: 0 if exited else None, wait=lambda **kwargs: 0)
    monkeypatch.setattr(signal, "SIGKILL", 9, raising=False)
    signals = []
    alive = True
    def killpg(pid: int, sig: int) -> None:
        nonlocal alive
        assert pid == process.pid
        if sig == 0:
            if not alive:
                raise ProcessLookupError()
            return
        signals.append(sig)
        if sig == getattr(signal, "SIGKILL", signal.SIGTERM):
            alive = False
    monkeypatch.setattr(module, "_is_posix", lambda: True)
    monkeypatch.setattr(module, "_is_windows", lambda: False)
    monkeypatch.setattr(module.os, "killpg", killpg, raising=False)
    monkeypatch.setattr(module, "_PROCESS_EXIT_TIMEOUT_SECONDS", 0.01)
    containment.after_spawn(process)
    containment.terminate(process)
    assert signals == [signal.SIGTERM, getattr(signal, "SIGKILL", signal.SIGTERM)]


def test_minimal_env_adds_row_env_after_the_scrub(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(module, "read_environment_value",
                        lambda key, default="": "/parent-temp" if key == "TEMP" else default)
    [config] = _parse_mcp_servers(
        [{"name": "rea", "transport": "stdio", "command": "npx", "env": {"REA_LOG_LEVEL": "debug"}}],
        sse_enabled=False,
    )
    env = module._minimal_env(config, command_path=None)
    assert env["REA_LOG_LEVEL"] == "debug"
    assert env["TEMP"] == "/parent-temp"


def test_minimal_env_never_lets_a_row_override_or_add_reserved_keys(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(module, "read_environment_value",
                        lambda key, default="": "/parent-temp" if key == "TEMP" else default)
    # Built directly, bypassing the parser, to prove the containment re-check.
    config = MCPServerConfig(name="rea", transport="stdio", command="npx", env=(
        ("NODE_OPTIONS", "--require=evil.js"), ("PATH", "/evil-bin"), ("REA_LOG_LEVEL", "debug"),
        ("NPM_CONFIG_NODE_OPTIONS", "--require=evil.js"), ("JAVA_TOOL_OPTIONS", "-javaagent:evil.jar"),
        ("TEMP", "/evil-temp"), ("TMPDIR", "/evil"),
    ))
    baseline = module._minimal_env(MCPServerConfig(name="rea", transport="stdio", command="npx"),
                                   command_path=None)
    env = module._minimal_env(config, command_path=None)
    assert env == {**baseline, "REA_LOG_LEVEL": "debug"}


def test_every_passthrough_key_is_reserved_for_rows() -> None:
    for key in (*module._ENV_PASSTHROUGH_KEYS, "PATH", "PYTHONIOENCODING", "PYTHONUNBUFFERED",
                "OPENBLAS_NUM_THREADS"):
        # PROGRAMFILES(X86)-style names can never be row keys: the key pattern refuses them.
        expected = "env_invalid" if "(" in key else "reserved_env_key"
        assert mcp_env_key_rejection(key) == expected, key


def test_minimal_env_passes_windows_machine_facts_to_the_builtin_server(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # A 15-variable child env left CMake's VS generator unable to find the VS
    # Setup instance store under ProgramData (2026-10-20).
    parent = {"PROGRAMDATA": r"C:\ProgramData", "PROGRAMFILES(X86)": r"C:\Program Files (x86)"}
    monkeypatch.setattr(module, "read_environment_value",
                        lambda key, default="": parent.get(key, default))
    env = module._minimal_env(
        MCPServerConfig(name=module.BUILTIN_MCP_SERVER_NAME, transport="stdio", command="python"),
        command_path=None,
    )
    assert env["PROGRAMDATA"] == r"C:\ProgramData"
    assert env["PROGRAMFILES(X86)"] == r"C:\Program Files (x86)"


def test_a_row_env_naming_programdata_is_rejected_as_reserved() -> None:
    assert mcp_env_key_rejection("PROGRAMDATA") == "reserved_env_key"
    assert _parse_mcp_servers(
        [{"name": "rea", "transport": "stdio", "command": "npx", "env": {"PROGRAMDATA": "/evil"}}],
        sse_enabled=False,
    ) == ()


@pytest.mark.parametrize("memory_limit_mb", [2048, 8192])
def test_row_memory_limit_reaches_the_windows_job(
    monkeypatch: pytest.MonkeyPatch, memory_limit_mb: int,
) -> None:
    observed: list[dict[str, object]] = []

    class FakeJob:
        def __init__(self, **kwargs: object) -> None:
            observed.append(kwargs)

        def __enter__(self) -> "FakeJob":
            return self

        def assign(self, _process: object) -> None:
            pass

        def resume(self, _process: object) -> None:
            pass

    monkeypatch.setattr(module, "_is_windows", lambda: True)
    monkeypatch.setattr(module, "JobObject", FakeJob)
    [config] = _parse_mcp_servers(
        [{"name": "rea", "transport": "stdio", "command": "npx",
          "memory_limit_mb": memory_limit_mb, "max_processes": 16}],
        sse_enabled=False,
    )
    MCPProcessContainment(config).after_spawn(SimpleNamespace(pid=4321))  # type: ignore[arg-type]
    assert observed == [{"memory_limit_mb": memory_limit_mb, "max_processes": 16}]


@windows_only("CreateProcess searches the cwd for a bare command name")
def test_bare_mcp_command_never_resolves_from_the_cwd(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    cwd_dir = tmp_path / "cwd"
    bin_dir = tmp_path / "bin"
    cwd_dir.mkdir()
    bin_dir.mkdir()
    (cwd_dir / "docs-mcp.exe").write_text("", encoding="utf-8")
    (bin_dir / "npx.cmd").write_text("", encoding="utf-8")
    monkeypatch.chdir(cwd_dir)
    monkeypatch.setattr(
        module,
        "read_environment_value",
        lambda key, default="": str(bin_dir) if key == "PATH" else default,
    )
    monkeypatch.setattr(module, "_default_path_segments", lambda: ())
    docs = MCPProcessContainment(MCPServerConfig(name="docs", transport="stdio", command="docs-mcp"))

    with pytest.raises(FileNotFoundError):
        docs.spawn_command()
    assert module._resolve_command_for_env("docs-mcp") is None

    (bin_dir / "docs-mcp.exe").write_text("", encoding="utf-8")
    assert docs.spawn_command() == str(bin_dir / "docs-mcp.exe")
    # A bare name keeps CreateProcess's .exe-only rule: npx.cmd is not picked up.
    npx = MCPProcessContainment(MCPServerConfig(name="npx", transport="stdio", command="npx"))
    with pytest.raises(FileNotFoundError):
        npx.spawn_command()
