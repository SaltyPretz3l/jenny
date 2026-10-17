"""Real script streams and bounded, metadata-only interpreter probes."""
from __future__ import annotations

import json
import os
import re
import shutil
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

from sidecar.ai.tools.builtins import cancellation, shell, shell_settings, temp_script
from sidecar.ai.tools.builtins import temp_script_interpreter as interpreters
from sidecar.ai.tools.builtins.owned_process_observation import (
    create_process_cleanup_observer,
    observe_owned_process_invocation,
)
from sidecar.ai.tools.builtins.owned_process_settlement import OwnedProcessCleanupVerdict
from sidecar.ai.tools.builtins.temp_script import run_temp_script_tool
from sidecar.ai.tools.contracts import ToolHandlerResult
from sidecar.ai.tools.workspace import WorkspaceGuard


@pytest.mark.parametrize("enabled", [True, False])
def test_harness_temp_script_inherits_noninteractive_environment(tmp_path, monkeypatch, enabled):
    saved = dict(shell_settings._FEATURE_FLAGS)
    monkeypatch.setenv("GIT_EDITOR", "code --wait")
    try:
        shell_settings.configure_shell_security({"shell_noninteractive_env": enabled})
        result = run_temp_script_tool({
            "script": "import os; print(os.environ['GIT_EDITOR'])", "language": "python",
        }, WorkspaceGuard(str(tmp_path)))
        assert result.success, result.output
        assert json.loads(result.output)["stdout"].strip() == (
            "false" if enabled else "code --wait"
        )
    finally:
        shell_settings.configure_shell_security(saved)


@pytest.fixture(autouse=True)
def _isolated_version_cache():
    saved_flags = dict(shell_settings._FEATURE_FLAGS)
    interpreters._VERSION_CACHE.clear()
    yield
    interpreters._VERSION_CACHE.clear()
    shell_settings.configure_shell_security(saved_flags)


CONFIRMED = OwnedProcessCleanupVerdict(
    cleanup="confirmed", process_tree_terminated=True, output_readers_terminated=True,
)
UNCERTAIN = OwnedProcessCleanupVerdict(
    cleanup="uncertain", process_tree_terminated=True, output_readers_terminated=False,
    reason="reader_thread_alive",
)
_SCRIPTS = {
    "python": "import sys\nprint('script-output')\n"
              "print('script-warning', file=sys.stderr)\nsys.exit({exit_code})\n",
    "powershell": "[Console]::Out.WriteLine('script-output')\n"
                  "[Console]::Error.WriteLine('script-warning')\nexit {exit_code}\n",
    "javascript": "console.log('script-output');\nconsole.error('script-warning');\n"
                  "process.exit({exit_code});\n",
}


@pytest.mark.parametrize("language", ["python", "powershell", "javascript"])
@pytest.mark.parametrize("exit_code", [0, 7])
@pytest.mark.skipif(os.name != "nt", reason="real Windows cmd and interpreter integration")
def test_real_windows_scripts_keep_streams_exit_and_interpreter(tmp_path, language, exit_code):
    name = {"python": "python", "powershell": "powershell", "javascript": "node"}[language]
    if shutil.which(name) is None:
        pytest.skip(f"{name} is not installed")
    result = run_temp_script_tool({
        "script": _SCRIPTS[language].format(exit_code=exit_code),
        "language": language, "timeout_seconds": 30,
    }, WorkspaceGuard(str(tmp_path)))
    payload = json.loads(result.output)
    assert result.success is (exit_code == 0)
    assert payload["exit_code"] == result.metadata["exit_code"] == exit_code
    assert payload["stdout"].strip() == "script-output"
    assert payload["stderr"].strip() == "script-warning"
    assert payload["shell"] == "cmd.exe"
    assert payload["language"] == result.metadata["language"] == language
    assert Path(payload["interpreter"]).is_absolute()
    assert Path(payload["interpreter"]).samefile(shutil.which(name))
    assert payload["interpreter_version_probe"]["status"] == "available"
    assert re.search(r"\d+\.\d+", payload["interpreter_version"])
    assert len(payload["interpreter_version"]) <= interpreters.MAX_INTERPRETER_VERSION_CHARS
    assert result.metadata["resource_cleanup"]["cleanup"] == "confirmed"
    assert payload["interpreter_version_probe"]["resource_cleanup"]["cleanup"] == "confirmed"
    assert list(tmp_path.iterdir()) == []


@pytest.mark.parametrize("exit_code", [0, 9])
@pytest.mark.skipif(os.name != "nt", reason="actual Windows executable stream semantics")
def test_real_windows_executable_stderr_does_not_replace_exit_status(tmp_path, exit_code):
    command = f'"{sys.executable}" -c "import sys; print(\'native-out\'); '
    command += f'print(\'native-err\', file=sys.stderr); sys.exit({exit_code})"'
    result = shell.run_command_tool({"command": command}, WorkspaceGuard(str(tmp_path)))
    payload = json.loads(result.output)
    assert result.success is (exit_code == 0)
    assert payload["exit_code"] == exit_code
    assert payload["stdout"].strip() == "native-out"
    assert payload["stderr"].strip() == "native-err"
    assert result.metadata["resource_cleanup"]["cleanup"] == "confirmed"


def _completed(**overrides):
    values = dict(stdout="fixture-version 1.2.3", stderr="", returncode=0,
                  timed_out=False, aborted=False, drain_incomplete=False,
                  cleanup_verdict=CONFIRMED)
    values.update(overrides)
    return SimpleNamespace(**values)


def _fake_service(monkeypatch, run):
    monkeypatch.setattr(interpreters, "get_owned_process_service", lambda: SimpleNamespace(run=run))


def _script_result(exit_code=0):
    return ToolHandlerResult(
        output=json.dumps({"stdout": "script-out", "stderr": "script-warning",
                           "exit_code": exit_code}),
        success=exit_code == 0,
        metadata={"exit_code": exit_code, "resource_cleanup": CONFIRMED.metadata()},
    )


@pytest.mark.parametrize("language", ["cmd", "sh"])
def test_unstandardized_shell_versions_are_explicitly_unavailable(monkeypatch, language):
    _fake_service(monkeypatch, lambda *_args, **_kwargs: pytest.fail("must not probe cmd/sh"))
    details = interpreters.interpreter_version_metadata(
        sys.executable, language, execution_completed=True,
    )
    assert details["interpreter_version"] is None
    assert details["interpreter_version_probe"] == {"status": "unavailable", "reason": "unsupported"}


def test_real_probe_timeout_is_metadata_only_and_confirms_cleanup(tmp_path, monkeypatch):
    monkeypatch.setattr(interpreters, "VERSION_PROBE_TIMEOUT_SECONDS", 0.1)
    monkeypatch.setattr(interpreters, "_version_argv", lambda interpreter, _language: [
        interpreter, "-I", "-c", "import time; time.sleep(5)",
    ])
    result = run_temp_script_tool({"script": _SCRIPTS["python"].format(exit_code=0),
                                   "language": "python"}, WorkspaceGuard(str(tmp_path)))
    payload = json.loads(result.output)
    assert result.success is True
    assert payload["exit_code"] == 0
    assert payload["stderr"].strip() == "script-warning"
    assert payload["interpreter_version"] is None
    assert payload["interpreter_version_probe"]["reason"] == "timed_out"
    assert payload["interpreter_version_probe"]["resource_cleanup"] == CONFIRMED.metadata()
    assert result.metadata["resource_cleanup"] == CONFIRMED.metadata()


@pytest.mark.parametrize("exit_code", [0, 7])
def test_probe_launch_failure_preserves_script_outcome(tmp_path, monkeypatch, exit_code):
    def fail(*_args, **_kwargs):
        raise OSError("unavailable")
    _fake_service(monkeypatch, fail)
    monkeypatch.setattr(temp_script, "run_command_tool", lambda *_args: _script_result(exit_code))
    result = run_temp_script_tool({"script": "print('ok')", "language": "python"},
                                   WorkspaceGuard(str(tmp_path)))
    payload = json.loads(result.output)
    assert result.success is (exit_code == 0)
    assert payload["exit_code"] == exit_code
    assert payload["stdout"] == "script-out"
    assert payload["stderr"] == "script-warning"
    assert payload["interpreter_version_probe"]["reason"] == "probe_failed"
    assert result.metadata["resource_cleanup"] == CONFIRMED.metadata()


def test_pending_cancellation_skips_probe_after_completed_script(tmp_path, monkeypatch):
    event = cancellation.begin_tool_call("probe-skip")
    def finish_script(*_args):
        event.set()
        return _script_result()
    monkeypatch.setattr(temp_script, "run_command_tool", finish_script)
    _fake_service(monkeypatch, lambda *_args, **_kwargs: pytest.fail("cancelled probe spawned"))
    try:
        result = run_temp_script_tool({"script": "print('ok')", "language": "python"},
                                       WorkspaceGuard(str(tmp_path)))
    finally:
        cancellation.end_tool_call()
    assert result.success is True
    assert result.metadata["interpreter_version_probe"]["reason"] == "cancelled"
    assert result.metadata["resource_cleanup"] == CONFIRMED.metadata()


def test_real_cancellation_during_probe_stops_owned_child(tmp_path, monkeypatch):
    event = cancellation.begin_tool_call("probe-running")
    real_service = interpreters.get_owned_process_service()
    def cancel_probe(argv, **kwargs):
        import threading
        timer = threading.Timer(0.2, event.set)
        timer.start()
        try:
            return real_service.run(
                [argv[0], "-I", "-c", "import time; time.sleep(5)"], **kwargs,
            )
        finally:
            timer.cancel()
            timer.join()
    _fake_service(monkeypatch, cancel_probe)
    try:
        result = run_temp_script_tool({"script": "print('ok')", "language": "python"},
                                       WorkspaceGuard(str(tmp_path)))
    finally:
        cancellation.end_tool_call()
    assert result.success is True
    assert result.metadata["exit_code"] == 0
    assert result.metadata["interpreter_version_probe"]["reason"] == "cancelled"
    assert result.metadata["interpreter_version_probe"]["resource_cleanup"] == CONFIRMED.metadata()


@pytest.mark.parametrize("raises", [False, True])
def test_uncertain_probe_cleanup_is_not_masked_by_script_cleanup(tmp_path, monkeypatch, raises):
    def finish_script(*_args):
        create_process_cleanup_observer()(CONFIRMED)
        return _script_result()
    def uncertain_probe(_argv, **kwargs):
        create_process_cleanup_observer(kwargs["on_cleanup"])(UNCERTAIN)
        if raises:
            raise OSError("probe failed after launch")
        return _completed(cleanup_verdict=UNCERTAIN)
    monkeypatch.setattr(temp_script, "run_command_tool", finish_script)
    _fake_service(monkeypatch, uncertain_probe)
    with observe_owned_process_invocation("run_temp_script") as observation:
        result = run_temp_script_tool({"script": "print('ok')", "language": "python"},
                                       WorkspaceGuard(str(tmp_path)))
        observation.add_metadata(result.metadata)
    assert result.success is True
    assert result.metadata["exit_code"] == 0
    assert result.metadata["resource_cleanup"] == UNCERTAIN.metadata()
    assert observation.resource_cleanup() == UNCERTAIN.metadata()
    assert result.metadata["interpreter_version_probe"]["reason"] == (
        "probe_failed" if raises else "cleanup_unconfirmed"
    )


def test_fixed_probe_argv_ignores_node_startup_hooks_and_bounds_report(monkeypatch):
    starts = []
    monkeypatch.setenv("NODE_OPTIONS", "--require user-script.js")
    monkeypatch.setenv("NODE_PATH", "user-modules")
    def run(argv, **kwargs):
        starts.append((argv, kwargs))
        return _completed(stdout="v1.2.3 " + "x" * 1000)
    _fake_service(monkeypatch, run)
    details = interpreters.interpreter_version_metadata(
        sys.executable, "javascript", execution_completed=True,
    )
    argv, kwargs = starts[0]
    assert argv == [sys.executable, "--version"]
    assert kwargs["timeout_seconds"] == interpreters.VERSION_PROBE_TIMEOUT_SECONDS
    assert kwargs["cwd"] == Path(sys.executable).parent
    assert "NODE_OPTIONS" not in kwargs["env"]
    assert "NODE_PATH" not in kwargs["env"]
    assert len(details["interpreter_version"]) == interpreters.MAX_INTERPRETER_VERSION_CHARS


@pytest.mark.parametrize("changes, reason", [
    ({"returncode": 1}, "probe_failed"),
    ({"stdout": ""}, "empty_output"),
    ({"drain_incomplete": True}, "probe_failed"),
])
def test_unavailable_probe_results_are_metadata_only(monkeypatch, changes, reason):
    _fake_service(monkeypatch, lambda *_args, **_kwargs: _completed(**changes))
    details = interpreters.interpreter_version_metadata(
        sys.executable, "python", execution_completed=True,
    )
    assert details["interpreter_version"] is None
    assert details["interpreter_version_probe"]["reason"] == reason


@pytest.mark.skipif(os.name != "nt", reason="Windows bounded discovery and real interpreter")
def test_real_scripts_run_with_constructed_desktop_path(tmp_path, monkeypatch):
    from sidecar.ai.config import MCPServerConfig
    from sidecar.ai.mcp.process_containment import _minimal_env

    config = MCPServerConfig(name="jenny_local_tools", transport="stdio", command=sys.executable)
    environment = _minimal_env(config, command_path=Path(sys.executable))
    monkeypatch.setenv("PATH", environment["PATH"])
    result = run_temp_script_tool({
        "script": _SCRIPTS["powershell"].format(exit_code=0), "language": "powershell",
    }, WorkspaceGuard(str(tmp_path)))
    assert result.success is True
    assert result.metadata["interpreter_version_probe"]["status"] == "available"
    assert str(Path(sys.executable).parent) not in environment["PATH"].split(os.pathsep)


def test_raw_script_reports_effective_shell_and_unsupported_version(tmp_path):
    result = run_temp_script_tool({"script": "echo raw-metadata"}, WorkspaceGuard(str(tmp_path)))
    payload = json.loads(result.output)
    language = "cmd" if os.name == "nt" else "sh"
    assert result.success is True
    assert payload["language"] == language
    assert Path(payload["interpreter"]).is_absolute()
    assert payload["interpreter_version"] is None
    assert payload["interpreter_version_probe"]["reason"] == "unsupported"



def test_script_timeout_does_not_launch_version_probe(tmp_path, monkeypatch):
    _fake_service(monkeypatch, lambda *_args, **_kwargs: pytest.fail("timed-out script probed"))
    result = run_temp_script_tool({
        "script": "import time\ntime.sleep(5)\n", "language": "python", "timeout_seconds": 0.1,
    }, WorkspaceGuard(str(tmp_path)))
    assert result.success is False
    assert result.metadata["timed_out"] is True
    assert result.metadata["interpreter_version_probe"]["reason"] == "script_not_completed"
    assert result.metadata["resource_cleanup"] == CONFIRMED.metadata()


def test_selected_interpreter_symlink_preserves_invocation_identity(tmp_path, monkeypatch):
    selected = tmp_path / ("selected-python.exe" if os.name == "nt" else "selected-python")
    try:
        selected.symlink_to(sys.executable)
    except OSError:
        pytest.skip("interpreter symlinks unavailable on this host")
    monkeypatch.setenv("PATH", str(tmp_path))
    monkeypatch.setattr(shell.shutil, "which", lambda *_args, **_kwargs: str(selected))
    executable = interpreters.resolve_script_interpreter("python")
    assert executable == str(selected.absolute())
    assert executable != str(selected.resolve())
    command = interpreters.script_command(tmp_path / "script.py", language="python",
                                          interpreter=executable)
    assert command.startswith(f'"{selected.absolute()}" ')


@pytest.mark.skipif(os.name != "nt", reason="Windows PowerShell 5.1 Unicode decoding")
def test_powershell_51_preserves_unicode_literals(tmp_path):
    result = run_temp_script_tool({"script": "$s='caf\u00e9 \u2713'; [Console]::Out.WriteLine($s.Length)",
        "language": "powershell", "timeout_seconds": 30}, WorkspaceGuard(str(tmp_path)))
    assert result.success, result.output
    assert json.loads(result.output)["stdout"].strip() == "6"
    assert list(tmp_path.iterdir()) == []


def test_version_cache_reuses_success_and_invalidates_file_identity(tmp_path, monkeypatch):
    executable = tmp_path / "interpreter"
    executable.write_bytes(b"old")
    calls = []
    def probe(*args, **kwargs):
        calls.append(args)
        return _completed()
    _fake_service(monkeypatch, probe)
    first = interpreters.interpreter_version_metadata(str(executable), "python", execution_completed=True)
    first["interpreter_version_probe"]["status"] = "mutated"
    second = interpreters.interpreter_version_metadata(str(executable), "python", execution_completed=True)
    assert second["interpreter_version_probe"]["status"] == "available"
    assert len(calls) == 1
    executable.write_bytes(b"replacement")
    interpreters.interpreter_version_metadata(str(executable), "python", execution_completed=True)
    assert len(calls) == 2


def test_version_cache_is_bounded(tmp_path, monkeypatch):
    monkeypatch.setattr(interpreters, "MAX_VERSION_CACHE_ENTRIES", 2)
    _fake_service(monkeypatch, lambda *_args, **_kwargs: _completed())
    for index in range(3):
        executable = tmp_path / str(index)
        executable.write_bytes(b"fixture")
        interpreters.interpreter_version_metadata(str(executable), "python", execution_completed=True)
    assert len(interpreters._VERSION_CACHE) == 2


def test_interpreter_resolution_rejects_cwd_fallback(tmp_path, monkeypatch):
    allowed = tmp_path / "allowed"
    allowed.mkdir()
    hostile = tmp_path / "cwd" / "python.exe"
    monkeypatch.setenv("PATH", str(allowed))
    monkeypatch.setattr(shell.shutil, "which", lambda *_args, **_kwargs: str(hostile))
    from sidecar.ai.tools.contracts import ToolExecutionFailure
    with pytest.raises(ToolExecutionFailure, match="unavailable"):
        interpreters.resolve_script_interpreter("python")


@pytest.mark.skipif(os.name != "nt", reason="Windows cmd explicit PATH discovery")
def test_outer_cmd_resolution_rejects_cwd_fallback(tmp_path, monkeypatch):
    shell_settings.configure_shell_security({"shell_noninteractive_env": False})
    allowed = tmp_path / "allowed"
    allowed.mkdir()
    monkeypatch.setenv("PATH", str(allowed))
    monkeypatch.setattr(shell, "_shell_environment", lambda: None)
    monkeypatch.setattr(shell.shutil, "which", lambda *_args, **_kwargs: str(tmp_path / "cmd.exe"))
    from sidecar.ai.tools.contracts import ToolExecutionFailure
    with pytest.raises(ToolExecutionFailure, match="unavailable"):
        shell._shell_argv("echo safe")
