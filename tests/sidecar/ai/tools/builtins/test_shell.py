"""Tests for the enhanced shell tool (run_command, background jobs, etc.)."""

from __future__ import annotations

import json
import os
import subprocess
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

import sidecar.ai.tools.distill as distill_module
from sidecar.ai.error_codes import CMP_TOOL_EXECUTION_FAILED, CMP_TOOL_IO_FAILED
from sidecar.ai.tools.builtins import shell as shell_module
from sidecar.ai.tools.builtins import shell_background as shell_background_module
from sidecar.ai.tools.builtins.shell import (
    MAX_OUTPUT_CHARS,
    check_background_job_tool,
    configure_shell_security,
    run_command_tool,
)
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.workspace import WorkspaceGuard


def _guard(tmp_path: Path) -> WorkspaceGuard:
    return WorkspaceGuard(str(tmp_path))


def _exit_command(code: int) -> str:
    return f"exit /b {code}" if os.name == "nt" else f"exit {code}"


def test_expected_nonzero_exit_succeeds_and_reports_shell(tmp_path: Path) -> None:
    result = run_command_tool(
        {"command": _exit_command(3), "expected_exit_codes": [3]}, _guard(tmp_path)
    )
    payload = json.loads(result.output)
    assert result.success is True
    assert payload["expectation_met"] is True
    assert payload["expectation_note"] == "Observed expected exit code: 3"
    assert payload["shell"] == ("cmd.exe" if os.name == "nt" else "/bin/sh")


def test_unexpected_zero_or_code_fails_explicit_contract(tmp_path: Path) -> None:
    zero = run_command_tool(
        {"command": _exit_command(0), "expected_exit_codes": [1]}, _guard(tmp_path)
    )
    other = run_command_tool(
        {"command": _exit_command(2), "expected_exit_codes": [1]}, _guard(tmp_path)
    )
    assert zero.success is False
    assert json.loads(zero.output)["expectation_met"] is False
    assert other.success is False


def test_failing_command_carries_an_error_code(tmp_path: Path) -> None:
    """A non-zero exit must ship a CMP-TOOL code, not an empty string.

    ``_summarize_failed_tool_outcomes`` renders a failed outcome as
    ``"tool [code]"`` and silently degrades to a bare tool name when the code is
    missing -- so a codeless run_command failure produced the least informative
    failure summary of any tool, for the tool that fails most often.
    """
    failed = run_command_tool({"command": _exit_command(3)}, _guard(tmp_path))
    passed = run_command_tool({"command": _exit_command(0)}, _guard(tmp_path))

    assert failed.success is False
    assert failed.error_code == CMP_TOOL_EXECUTION_FAILED
    assert passed.success is True
    assert passed.error_code is None


def test_expected_exit_codes_reject_background_and_duplicates(tmp_path: Path) -> None:
    with pytest.raises(ToolExecutionFailure):
        run_command_tool(
            {"command": "echo hi", "run_in_background": True, "expected_exit_codes": [0]},
            _guard(tmp_path),
        )
    with pytest.raises(ToolExecutionFailure):
        run_command_tool(
            {"command": "echo hi", "expected_exit_codes": [0, 0]}, _guard(tmp_path)
        )


@pytest.fixture(autouse=True)
def _legacy_unit_process_adapters(monkeypatch: pytest.MonkeyPatch) -> None:
    """Keep legacy assembly tests isolated from real process ownership.

    WIDE-015 exercises the production owner in ``test_owned_process.py``;
    this file's existing tests intentionally keep their injected completed
    processes and background fakes.
    """

    def _run_owned(
        argv: list[str],
        *,
        cwd: Path,
        timeout_seconds: float,
    ) -> object:
        launch_args: list[str] | str = argv
        if (
            os.name == "nt"
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

    def _spawn_background(
        argv: list[str],
        *,
        cwd: Path,
    ) -> object:
        process = shell_background_module.subprocess.Popen(
            argv,
            cwd=str(cwd),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        return shell_background_module._ManagedBackgroundProcess(process=process)  # noqa: SLF001

    monkeypatch.setattr(shell_module, "_run_owned_process", _run_owned)
    monkeypatch.setattr(
        shell_background_module,
        "_spawn_background_process",
        _spawn_background,
    )


# ── Basic execution ───────────────────────────────────────────────────


def test_run_command_basic_execution(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setattr(
        "sidecar.ai.tools.builtins.shell.subprocess.run",
        lambda *a, **kw: SimpleNamespace(returncode=0, stdout="hello\n", stderr=""),
    )
    result = run_command_tool({"command": "echo hello"}, _guard(tmp_path))
    body = json.loads(result.output)
    assert body["ok"] is True
    assert body["exit_code"] == 0
    assert "hello" in body["stdout"]


def test_run_command_executes_compound_shell_command(tmp_path: Path) -> None:
    result = run_command_tool(
        {"command": "echo first && echo second"},
        _guard(tmp_path),
    )

    body = json.loads(result.output)
    assert body["ok"] is True
    assert "first" in body["stdout"]
    assert "second" in body["stdout"]


def test_unconditional_compound_command_reports_final_segment_exit_code(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setattr(
        shell_module,
        "_run_owned_process",
        lambda *a, **kw: SimpleNamespace(
            returncode=0,
            stdout="ok1",
            stderr="The filename, directory name, or volume label syntax is incorrect.",
        ),
    )

    result = run_command_tool({"command": r"move a.js b\c & echo ok1"}, _guard(tmp_path))
    body = json.loads(result.output)

    assert body["exit_code"] == 0
    assert body["stderr"] == "The filename, directory name, or volume label syntax is incorrect."
    assert body["exit_code_covers"] == "final_segment_only"
    assert body["completed_with_warnings"] is True


def test_single_command_stderr_does_not_gain_compound_warning_keys(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setattr(
        shell_module,
        "_run_owned_process",
        lambda *a, **kw: SimpleNamespace(returncode=0, stdout="", stderr="warning"),
    )

    result = run_command_tool({"command": "git status"}, _guard(tmp_path))
    body = json.loads(result.output)

    assert result.success is True
    assert body["exit_code"] == 0
    assert body["stderr"] == "warning"
    assert "exit_code_covers" not in body
    assert "completed_with_warnings" not in body


def test_shell_mode_still_blocked(tmp_path: Path) -> None:
    with pytest.raises(ToolExecutionFailure, match="shell execution mode"):
        run_command_tool({"command": "ls", "shell": True}, _guard(tmp_path))


# ── Legacy deny patterns ─────────────────────────────────────────────


def test_deny_patterns_still_block_without_security_flag(tmp_path: Path) -> None:
    configure_shell_security({})  # no flags
    with pytest.raises(ToolExecutionFailure, match="blocked by policy"):
        run_command_tool({"command": "rm -rf /"}, _guard(tmp_path))


@pytest.mark.parametrize(
    "command",
    [
        "reboot",
        "shutdown\t-r now",
        "shutdown    -r now",
        "format\tC:",
        ":(){:|:&};:",
        "echo pwned > /dev/sda",
    ],
)
def test_blocked_patterns_cover_classifier_patterns_without_security_flag(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    command: str,
) -> None:
    configure_shell_security({"shell_security": False})
    monkeypatch.setattr(
        "sidecar.ai.tools.builtins.shell.subprocess.run",
        lambda *a, **kw: SimpleNamespace(returncode=0, stdout="not blocked", stderr=""),
    )

    with pytest.raises(ToolExecutionFailure, match="blocked by policy"):
        run_command_tool({"command": command}, _guard(tmp_path))


# ── Security classifier integration ──────────────────────────────────


def test_security_classifier_blocks_destructive(tmp_path: Path) -> None:
    configure_shell_security({"shell_security": True})
    try:
        # The fork-bomb pattern is only in the classifier's blocked list,
        # not the legacy deny patterns — this proves the classifier is active.
        with pytest.raises(ToolExecutionFailure, match="blocked"):
            run_command_tool({"command": ":(){:|:&};:"}, _guard(tmp_path))
    finally:
        configure_shell_security({"shell_security": False})


def test_security_classifier_off_uses_legacy_deny(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    configure_shell_security({"shell_security": False})
    # Legacy pattern still blocks
    with pytest.raises(ToolExecutionFailure, match="blocked by policy"):
        run_command_tool({"command": "rm -rf /"}, _guard(tmp_path))

    # Unknown command is NOT blocked without classifier (would need approval via Electron)
    monkeypatch.setattr(
        "sidecar.ai.tools.builtins.shell.subprocess.run",
        lambda *a, **kw: SimpleNamespace(returncode=0, stdout="ok", stderr=""),
    )
    result = run_command_tool({"command": "some_random_tool"}, _guard(tmp_path))
    assert result.success is True


def test_classification_metadata_in_response(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    configure_shell_security({"shell_security": True})
    try:
        monkeypatch.setattr(
            "sidecar.ai.tools.builtins.shell.subprocess.run",
            lambda *a, **kw: SimpleNamespace(returncode=0, stdout="ok", stderr=""),
        )
        result = run_command_tool({"command": "ls"}, _guard(tmp_path))
        assert "classification" in result.metadata
        assert result.metadata["classification"]["verdict"] == "allowed"
    finally:
        configure_shell_security({"shell_security": False})


# ── Semantic exit codes ───────────────────────────────────────────────


def test_semantic_exit_code_git_diff(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setattr(
        "sidecar.ai.tools.builtins.shell.subprocess.run",
        lambda *a, **kw: SimpleNamespace(returncode=1, stdout="", stderr=""),
    )
    result = run_command_tool({"command": "git diff --exit-code HEAD"}, _guard(tmp_path))
    body = json.loads(result.output)
    assert body["ok"] is True
    assert "differences found" in body.get("semantic_note", "")


def test_semantic_exit_code_does_not_apply_to_compound_command(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setattr(
        "sidecar.ai.tools.builtins.shell.subprocess.run",
        lambda *a, **kw: SimpleNamespace(returncode=1, stdout="", stderr="later failed"),
    )

    result = run_command_tool({"command": "grep needle file && false"}, _guard(tmp_path))
    body = json.loads(result.output)

    assert body["ok"] is False
    assert body.get("semantic_note") is None


def test_semantic_exit_code_grep_no_match(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setattr(
        "sidecar.ai.tools.builtins.shell.subprocess.run",
        lambda *a, **kw: SimpleNamespace(returncode=1, stdout="", stderr=""),
    )
    result = run_command_tool({"command": "grep pattern file"}, _guard(tmp_path))
    body = json.loads(result.output)
    assert body["ok"] is True
    assert "no matches" in body.get("semantic_note", "")


def test_semantic_exit_code_real_error(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setattr(
        "sidecar.ai.tools.builtins.shell.subprocess.run",
        lambda *a, **kw: SimpleNamespace(returncode=2, stdout="", stderr="error"),
    )
    result = run_command_tool({"command": "grep pattern file"}, _guard(tmp_path))
    body = json.loads(result.output)
    assert body["ok"] is False
    assert body.get("semantic_note") is None


# ── Timeout ceiling ──────────────────────────────────────────────────


def test_timeout_ceiling_raised(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    captured: list[float] = []

    def mock_run(*_a: object, **kw: object) -> SimpleNamespace:
        captured.append(kw.get("timeout", 0))  # type: ignore[arg-type]
        return SimpleNamespace(returncode=0, stdout="ok", stderr="")

    monkeypatch.setattr("sidecar.ai.tools.builtins.shell.subprocess.run", mock_run)
    run_command_tool(
        {"command": "echo hi", "timeout_seconds": 300},
        _guard(tmp_path),
    )
    assert captured[0] == 300.0


def test_timeout_max_capped(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    captured: list[float] = []

    def mock_run(*_a: object, **kw: object) -> SimpleNamespace:
        captured.append(kw.get("timeout", 0))  # type: ignore[arg-type]
        return SimpleNamespace(returncode=0, stdout="ok", stderr="")

    monkeypatch.setattr("sidecar.ai.tools.builtins.shell.subprocess.run", mock_run)
    run_command_tool(
        {"command": "echo hi", "timeout_seconds": 9999},
        _guard(tmp_path),
    )
    assert captured[0] == 600.0


def test_timeout_returns_bounded_partial_output(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setattr(
        shell_module,
        "_run_owned_process",
        lambda *_a, **_kw: SimpleNamespace(
            returncode=-1,
            stdout="before timeout\n",
            stderr="diagnostic tail\n",
            timed_out=True,
            aborted=False,
            drain_incomplete=False,
        ),
    )

    result = run_command_tool(
        {"command": "long build", "timeout_seconds": 1},
        _guard(tmp_path),
    )
    payload = json.loads(result.output)

    assert result.success is False
    assert result.error_code == CMP_TOOL_IO_FAILED
    assert payload["timed_out"] is True
    assert payload["stdout"] == "before timeout\n"
    assert payload["stderr"] == "diagnostic tail\n"


# ── Large output persistence ─────────────────────────────────────────


def test_large_output_persisted_to_disk(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    big = "x" * (MAX_OUTPUT_CHARS + 100)
    monkeypatch.setattr(
        "sidecar.ai.tools.builtins.shell.subprocess.run",
        lambda *a, **kw: SimpleNamespace(returncode=0, stdout=big, stderr=""),
    )
    result = run_command_tool({"command": "generate_big"}, _guard(tmp_path))
    body = json.loads(result.output)

    assert "full_output_path" in body
    assert body["full_output_complete"] is True
    assert body["stdout"].endswith("...[truncated]")

    # Verify file was written
    full_path = Path(body["full_output_path"])
    assert full_path.exists()
    content = full_path.read_text(encoding="utf-8")
    assert len(content) > MAX_OUTPUT_CHARS


def test_large_output_path_in_metadata(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    big = "x" * (MAX_OUTPUT_CHARS + 100)
    monkeypatch.setattr(
        "sidecar.ai.tools.builtins.shell.subprocess.run",
        lambda *a, **kw: SimpleNamespace(returncode=0, stdout=big, stderr=""),
    )
    result = run_command_tool({"command": "big"}, _guard(tmp_path))
    assert "full_output_path" in result.metadata
    assert result.metadata["full_output_complete"] is True


# ── Background job ───────────────────────────────────────────────────


def test_background_job_returns_job_id(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    # Mock Popen to avoid real subprocess
    class FakePopen:
        pid = 999
        returncode = 0

        def __init__(self, *_a: object, **_kw: object) -> None:
            pass

        def communicate(self, timeout: float | None = None) -> tuple[str, str]:
            return ("done\n", "")

        def kill(self) -> None:
            pass

    monkeypatch.setattr(
        "sidecar.ai.tools.builtins.shell_background.subprocess.Popen",
        FakePopen,
    )
    result = run_command_tool(
        {"command": "sleep 10", "run_in_background": True},
        _guard(tmp_path),
    )
    body = json.loads(result.output)
    assert body["status"] == "started"
    assert "job_id" in body
    assert result.metadata.get("background_job_id")
    # The spawned PID rides the trusted tool-result channel — it is the only
    # kill authority Electron may bind (status.json pid is display-only).
    assert result.metadata.get("background_job_pid") == 999


def test_background_job_uses_the_same_platform_shell_argv(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    captured: dict[str, object] = {}

    def fake_start_background_job(argv, **kwargs):  # noqa: ANN001, ANN003
        captured["argv"] = argv
        captured.update(kwargs)
        return shell_background_module.BackgroundJobStart("0123456789ab", 4242)

    monkeypatch.setattr(shell_module, "start_background_job", fake_start_background_job)

    result = run_command_tool(
        {
            "command": "echo first && echo second",
            "run_in_background": True,
        },
        _guard(tmp_path),
    )

    assert result.success is True
    assert captured["argv"][-1] == "echo first && echo second"
    if os.name == "nt":
        assert captured["argv"][1:4] == ["/d", "/s", "/c"]
    else:
        assert captured["argv"][1] == "-c"


def test_background_spawn_failure_is_not_reported_as_started(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    def fail_spawn(*_args, **_kwargs):  # noqa: ANN002, ANN003
        raise FileNotFoundError("missing shell")

    monkeypatch.setattr(shell_background_module, "_spawn_background_process", fail_spawn)

    with pytest.raises(ToolExecutionFailure) as caught:
        run_command_tool(
            {"command": "missing-command", "run_in_background": True},
            _guard(tmp_path),
        )

    assert caught.value.code == CMP_TOOL_IO_FAILED
    assert caught.value.retryable is False


def test_check_background_job_completed(tmp_path: Path) -> None:
    # Manually write a completed status file. Canonical 12-lowercase-hex
    # form (WIDE-011) — not-found/stale semantics live in dedicated tests
    # below and in test_shell_job_id.py; this test is about happy-path reads.
    job_id = "0123456789ab"
    jdir = tmp_path / ".jenny" / "tool-results" / job_id
    jdir.mkdir(parents=True)
    (jdir / "status.json").write_text(
        json.dumps(
            {
                "job_id": job_id,
                "state": "completed",
                "exit_code": 0,
                "stdout": "hello",
                "stderr": "",
            }
        ),
        encoding="utf-8",
    )
    result = check_background_job_tool({"job_id": job_id}, _guard(tmp_path))
    body = json.loads(result.output)
    assert body["state"] == "completed"
    assert body["stdout"] == "hello"


def test_check_background_job_truncates_large_output_to_file(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    big_stdout = "x" * (MAX_OUTPUT_CHARS + 250)

    class FakePopen:
        pid = 999
        returncode = 0

        def __init__(self, *_a: object, **_kw: object) -> None:
            pass

        def communicate(self, timeout: float | None = None) -> tuple[str, str]:
            return (big_stdout, "")

        def kill(self) -> None:
            pass

    monkeypatch.setattr(
        "sidecar.ai.tools.builtins.shell_background.subprocess.Popen",
        FakePopen,
    )
    started = run_command_tool(
        {"command": "sleep 10", "run_in_background": True},
        _guard(tmp_path),
    )
    job_id = json.loads(started.output)["job_id"]

    for _ in range(20):
        status = json.loads(check_background_job_tool({"job_id": job_id}, _guard(tmp_path)).output)
        if status["state"] == "completed":
            break
        time.sleep(0.01)
    else:
        raise AssertionError("background job did not complete in time")

    assert status["output_truncated"] is True
    assert status["stdout"].endswith("...[truncated]")
    full_output_path = Path(status["full_output_path"])
    assert full_output_path.exists()
    assert len(full_output_path.read_text(encoding="utf-8")) > MAX_OUTPUT_CHARS
    assert status["full_output_complete"] is True


def test_background_job_full_output_file_is_capped(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    output_cap = 128
    big_stdout = "x" * (output_cap * 20)
    monkeypatch.setattr(
        shell_background_module,
        "MAX_BACKGROUND_OUTPUT_BYTES",
        output_cap,
        raising=False,
    )

    class FakePopen:
        pid = 999
        returncode = 0

        def __init__(self, *_a: object, **_kw: object) -> None:
            pass

        def communicate(self, timeout: float | None = None) -> tuple[str, str]:
            return (big_stdout, "")

        def kill(self) -> None:
            pass

    monkeypatch.setattr(
        "sidecar.ai.tools.builtins.shell_background.subprocess.Popen",
        FakePopen,
    )
    started = run_command_tool(
        {"command": "write_big", "run_in_background": True},
        _guard(tmp_path),
    )
    job_id = json.loads(started.output)["job_id"]

    for _ in range(20):
        status = json.loads(check_background_job_tool({"job_id": job_id}, _guard(tmp_path)).output)
        if status["state"] == "completed":
            break
        time.sleep(0.01)
    else:
        raise AssertionError("background job did not complete in time")

    full_output_path = Path(status["full_output_path"])
    persisted = full_output_path.read_text(encoding="utf-8")
    assert len(persisted.encode("utf-8")) <= output_cap + 128
    assert status["output_file_truncated"] is True
    assert status["output_size_exceeded"] is True
    assert status["full_output_complete"] is False


def test_start_background_job_sweeps_stale_job_directories(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    stale_dir = tmp_path / ".jenny" / "tool-results" / "stale-job"
    stale_dir.mkdir(parents=True)
    (stale_dir / "status.json").write_text(
        json.dumps({"job_id": "stale-job", "state": "completed"}),
        encoding="utf-8",
    )
    old_time = time.time() - 10_000
    os.utime(stale_dir / "status.json", (old_time, old_time))
    os.utime(stale_dir, (old_time, old_time))

    monkeypatch.setattr(shell_background_module, "JOB_RETENTION_SECONDS", 1, raising=False)

    class FakePopen:
        pid = 999
        returncode = 0

        def __init__(self, *_a: object, **_kw: object) -> None:
            pass

        def communicate(self, timeout: float | None = None) -> tuple[str, str]:
            return ("done\n", "")

        def kill(self) -> None:
            pass

    monkeypatch.setattr(
        "sidecar.ai.tools.builtins.shell_background.subprocess.Popen",
        FakePopen,
    )

    run_command_tool(
        {"command": "sleep 10", "run_in_background": True},
        _guard(tmp_path),
    )

    assert not stale_dir.exists()


def test_check_background_job_not_found(tmp_path: Path) -> None:
    # Canonical-format ID (WIDE-011) that simply has no job directory on
    # disk — format-invalid IDs are covered separately in test_shell_job_id.py.
    with pytest.raises(ToolExecutionFailure, match="no background job"):
        check_background_job_tool({"job_id": "abcdef012345"}, _guard(tmp_path))


def test_background_job_timeout_uses_process_tree_termination(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    class FakePopen:
        pid = 999
        returncode = None

        def __init__(self) -> None:
            self.communicate_calls = 0

        def poll(self) -> None:
            return None

        def communicate(self, timeout: float | None = None) -> tuple[str, str]:
            self.communicate_calls += 1
            if self.communicate_calls == 1:
                raise subprocess.TimeoutExpired("python", timeout or 0)
            self.returncode = -9
            return ("partial stdout", "partial stderr")

        def wait(self, timeout: float | None = None) -> int:
            self.returncode = -9
            return -9

        def terminate(self) -> None:
            self.returncode = -15

        def kill(self) -> None:
            self.returncode = -9

    process = FakePopen()
    managed = shell_background_module._ManagedBackgroundProcess(process=process)
    terminated: list[float] = []

    monkeypatch.setattr(
        shell_background_module,
        "_spawn_background_process",
        lambda argv, *, cwd: managed,
    )

    def fake_terminate(job, *, timeout_seconds: float) -> None:
        terminated.append(timeout_seconds)
        assert job is managed
        job.process.returncode = -9

    monkeypatch.setattr(shell_background_module, "_terminate_background_process", fake_terminate)

    result = run_command_tool(
        {"command": "sleep 10", "run_in_background": True, "timeout_seconds": 1},
        _guard(tmp_path),
    )
    job_id = json.loads(result.output)["job_id"]

    for _ in range(30):
        status = json.loads(check_background_job_tool({"job_id": job_id}, _guard(tmp_path)).output)
        if status["state"] == "failed":
            break
        time.sleep(0.01)
    else:
        raise AssertionError("background job did not record timeout status")

    assert terminated == [1.0]
    assert status["error"] == "timed out after 1s"
    assert status["exit_code"] == -1


def test_cleanup_active_jobs_uses_shared_tree_termination(monkeypatch: pytest.MonkeyPatch) -> None:
    class FakePopen:
        pid = 1001
        returncode = None

        def poll(self) -> None:
            return None

    managed = shell_background_module._ManagedBackgroundProcess(process=FakePopen())
    terminated: list[tuple[object, float]] = []

    monkeypatch.setattr(
        shell_background_module,
        "_terminate_background_process",
        lambda job, *, timeout_seconds: terminated.append((job, timeout_seconds)),
    )

    with shell_background_module._lock:
        shell_background_module._active_jobs["job-1"] = managed

    shell_background_module._cleanup_active_jobs()

    assert terminated == [(managed, 0.5)]
    assert shell_background_module._active_jobs == {}


# ── Git tracking integration ─────────────────────────────────────────


def test_git_tracking_in_response(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    configure_shell_security({"git_tracking": True})
    try:
        monkeypatch.setattr(
            "sidecar.ai.tools.builtins.shell.subprocess.run",
            lambda *a, **kw: SimpleNamespace(
                returncode=0,
                stdout="[main abc1234] fix bug\n 1 file changed",
                stderr="",
            ),
        )
        result = run_command_tool({"command": "git commit -m 'fix'"}, _guard(tmp_path))
        body = json.loads(result.output)
        assert "git_operations" in body
        assert body["git_operations"][0]["kind"] == "commit"
        assert body["git_operations"][0]["sha"] == "abc1234"
        assert "git_operations" in result.metadata
    finally:
        configure_shell_security({"git_tracking": False})


def test_git_tracking_disabled_no_ops(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    configure_shell_security({"git_tracking": False})
    monkeypatch.setattr(
        "sidecar.ai.tools.builtins.shell.subprocess.run",
        lambda *a, **kw: SimpleNamespace(
            returncode=0,
            stdout="[main abc1234] fix",
            stderr="",
        ),
    )
    result = run_command_tool({"command": "git commit -m 'fix'"}, _guard(tmp_path))
    body = json.loads(result.output)
    assert "git_operations" not in body


# ── Tool-output distillation wiring (tools_distill_enabled) ────────────


@pytest.fixture(autouse=True)
def _reset_distill_config() -> None:
    distill_module.configure_distill(None)
    yield
    distill_module.configure_distill(None)


_PYTEST_PARADE = (
    "============================= test session starts =============================\n"
    + "\n".join(f"tests/test_{i}.py .....                     [ {i}%]" for i in range(40))
    + "\n=================================== FAILURES ===================================\n"
    ">       assert compute() == 42\n"
    "E       assert 0 == 42\n"
    "tests/test_x.py:9: AssertionError\n"
    "========================= 1 failed, 39 passed in 0.10s =========================\n"
)


def test_distill_flag_off_payload_is_byte_identical(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setattr(
        "sidecar.ai.tools.builtins.shell.subprocess.run",
        lambda *a, **kw: SimpleNamespace(
            returncode=1, stdout=_PYTEST_PARADE, stderr="a stderr line"
        ),
    )
    # Flag OFF (fixture default) → today's path, untouched.
    result = run_command_tool({"command": "pytest"}, _guard(tmp_path))
    body = json.loads(result.output)
    assert body["stdout"] == _PYTEST_PARADE
    assert body["stderr"] == "a stderr line"
    assert body["exit_code"] == 1
    assert "[jenny#" not in body["stdout"]
    assert "tests/test_20.py" in body["stdout"]  # parade NOT collapsed when off


def test_distill_flag_on_renders_errors_first_with_marker(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setattr(
        "sidecar.ai.tools.builtins.shell.subprocess.run",
        lambda *a, **kw: SimpleNamespace(returncode=1, stdout=_PYTEST_PARADE, stderr=""),
    )
    distill_module.configure_distill({"tools_distill_enabled": True})
    result = run_command_tool({"command": "pytest"}, _guard(tmp_path))
    body = json.loads(result.output)
    assert "E       assert 0 == 42" in body["stdout"]  # error line survives
    assert "1 failed, 39 passed in 0.10s" in body["stdout"]  # summary survives
    assert "lines omitted" in body["stdout"]  # marker spliced
    assert "full output: .jenny/tool-results/" in body["stdout"]
    assert body["full_output_display_path"].startswith(".jenny/tool-results/")
    assert body["exit_code"] == 1  # exit code preserved
    assert "tests/test_20.py" not in body["stdout"]  # parade collapsed


def test_distill_flag_on_small_output_passes_through(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setattr(
        "sidecar.ai.tools.builtins.shell.subprocess.run",
        lambda *a, **kw: SimpleNamespace(returncode=0, stdout="ok\nok\nok", stderr=""),
    )
    distill_module.configure_distill({"tools_distill_enabled": True})
    result = run_command_tool({"command": "pytest"}, _guard(tmp_path))
    body = json.loads(result.output)
    assert body["stdout"] == "ok\nok\nok"
    assert "[jenny#" not in body["stdout"]


def test_full_output_path_written_when_over_cap_regardless_of_flag(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    big = "A" * (MAX_OUTPUT_CHARS + 500)
    monkeypatch.setattr(
        "sidecar.ai.tools.builtins.shell.subprocess.run",
        lambda *a, **kw: SimpleNamespace(returncode=0, stdout=big, stderr=""),
    )
    distill_module.configure_distill({"tools_distill_enabled": True})
    result = run_command_tool({"command": "echo big"}, _guard(tmp_path))
    body = json.loads(result.output)
    assert "full_output_path" in body  # additive spill preserved
    assert "full_output_display_path" in body


def test_distill_flag_on_unrecognized_command_passes_through(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    # The pre-redaction sniff short-circuit: no filter matches `ls` output, so
    # the flag-on path returns raw without sanitizing or touching the store.
    listing = "\n".join(f"file_{i}.txt" for i in range(50))
    monkeypatch.setattr(
        "sidecar.ai.tools.builtins.shell.subprocess.run",
        lambda *a, **kw: SimpleNamespace(returncode=0, stdout=listing, stderr=""),
    )
    distill_module.configure_distill({"tools_distill_enabled": True})
    result = run_command_tool({"command": "dir_listing_tool"}, _guard(tmp_path))
    body = json.loads(result.output)
    assert body["stdout"] == listing
    assert "[jenny#" not in body["stdout"]
    assert not (tmp_path / ".jenny" / "omissions").exists()  # store never opened


def test_distill_flag_on_oversized_input_skipped(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    # Inputs beyond MAX_DISTILL_INPUT_CHARS skip distillation entirely — the
    # redaction pipeline must not run over an unbounded stream.
    big = "a" * (distill_module.MAX_DISTILL_INPUT_CHARS + 1)
    monkeypatch.setattr(
        "sidecar.ai.tools.builtins.shell.subprocess.run",
        lambda *a, **kw: SimpleNamespace(returncode=0, stdout=big, stderr=""),
    )
    distill_module.configure_distill({"tools_distill_enabled": True})
    result = run_command_tool({"command": "pytest"}, _guard(tmp_path))
    body = json.loads(result.output)
    assert "[jenny#" not in body["stdout"]
    assert body["stdout"].startswith("a" * 100)  # today's truncation path


# ── Internal-destination guard (P0-2 stopgap for WIDE-002) ────────────
# _persist_large_output (shell.py) and _write_status (shell_background.py)
# assemble .jenny-relative destinations and must refuse to write through a
# symlink or Windows reparse point anywhere on that chain.


def _make_junction(link: Path, target: Path) -> bool:
    result = subprocess.run(
        ["cmd", "/c", "mklink", "/J", str(link), str(target)],
        capture_output=True,
        check=False,
        text=True,
    )
    return result.returncode == 0


def test_persist_large_output_returns_none_on_guarded_store_refusal(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    def _fail(*_args: object, **_kwargs: object) -> object:
        raise ToolExecutionFailure(code=CMP_TOOL_IO_FAILED, message="unsafe", retryable=True)

    monkeypatch.setattr(
        shell_module.GuardedWorkspaceStore,
        "write_text_atomic",
        _fail,
    )
    guard = _guard(tmp_path)
    big = "x" * (MAX_OUTPUT_CHARS + 10)

    result = shell_module._persist_large_output(guard, big, "abc123abc123")

    assert result is None
    assert not (tmp_path / ".jenny" / "tool-results").exists()


def test_persist_large_output_still_writes_when_destination_is_safe(
    tmp_path: Path,
) -> None:
    guard = _guard(tmp_path)
    big = "y" * (MAX_OUTPUT_CHARS + 10)

    result = shell_module._persist_large_output(guard, big, "abc123abc123")

    assert result is not None
    result_path = Path(result.absolute_path)
    assert result_path.exists()
    assert result_path.read_text(encoding="utf-8") == big


def test_persist_large_output_redacts_secrets_before_disk_write(tmp_path: Path) -> None:
    guard = _guard(tmp_path)
    token = "sk-" + ("a" * 40)
    signature = "deadbeef" * 8
    big = ("ordinary output\n" * 2_000) + (
        f"api_key={token}\nhttps://example.test/file?X-Amz-Signature={signature}"
    )

    result = shell_module._persist_large_output(guard, big, "abc123abc123")

    assert result is not None
    persisted = Path(result.absolute_path).read_text(encoding="utf-8")
    assert token not in persisted
    assert signature not in persisted
    assert "[REDACTED]" in persisted


@pytest.mark.skipif(os.name != "nt", reason="Windows junctions only")
def test_persist_large_output_quarantines_junctioned_tool_results_dir(tmp_path: Path) -> None:
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    jenny = tmp_path / ".jenny"
    jenny.mkdir()

    if not _make_junction(jenny / "tool-results", elsewhere):
        pytest.skip("mklink /J not permitted in this environment")
    guard = _guard(tmp_path)
    big = "z" * (MAX_OUTPUT_CHARS + 10)
    outcome = shell_module._persist_large_output(guard, big, "abc123abc123")

    assert outcome is not None
    assert Path(outcome.absolute_path).read_text(encoding="utf-8") == big
    assert list(elsewhere.iterdir()) == []
    assert any(
        entry.name.startswith("tool-results-tool-results")
        for entry in (jenny / "quarantine").iterdir()
    )


def test_write_status_swallows_guarded_store_refusal(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    def _fail(*_args: object, **_kwargs: object) -> object:
        raise ToolExecutionFailure(code=CMP_TOOL_IO_FAILED, message="unsafe", retryable=True)

    monkeypatch.setattr(
        shell_background_module.GuardedWorkspaceStore,
        "write_json_atomic",
        _fail,
    )
    store = shell_background_module.GuardedWorkspaceStore(tmp_path)
    job_ref = store.resolve(
        shell_background_module.WorkspaceStoreKind.TOOL_RESULTS,
        "abc123abc123",
    )

    shell_background_module._write_status(
        store, job_ref, {"job_id": "abc123abc123", "state": "running", "pid": 42}
    )

    assert not (tmp_path / ".jenny" / "tool-results" / "abc123abc123").exists()


def test_write_status_still_writes_when_destination_is_safe(tmp_path: Path) -> None:
    job_dir = tmp_path / ".jenny" / "tool-results" / "abc123abc123"
    store = shell_background_module.GuardedWorkspaceStore(tmp_path)
    job_ref = store.resolve(
        shell_background_module.WorkspaceStoreKind.TOOL_RESULTS,
        "abc123abc123",
    )

    shell_background_module._write_status(
        store, job_ref, {"job_id": "abc123abc123", "state": "running", "pid": 42}
    )

    status_file = job_dir / "status.json"
    assert status_file.exists()
    persisted = json.loads(status_file.read_text(encoding="utf-8"))
    assert persisted["state"] == "running"
    assert persisted["schema_version"] == 1
    assert shell_background_module.read_background_job(
        tmp_path, "abc123abc123"
    )["pid"] == 42
    assert not (tmp_path / ".jenny" / "omissions").exists()


def test_terminal_status_and_full_output_are_redacted_before_persistence(
    tmp_path: Path,
) -> None:
    store = shell_background_module.GuardedWorkspaceStore(tmp_path)
    job_ref = store.resolve(
        shell_background_module.WorkspaceStoreKind.TOOL_RESULTS,
        "abc123abc123",
    )
    token = "ghp_" + ("a" * 24)
    stdout = ("ordinary output\n" * 2_000) + f"token={token}"

    status = shell_background_module._build_terminal_status(
        job_id="abc123abc123",
        state="completed",
        exit_code=0,
        stdout=stdout,
        stderr=f"Bearer {token}",
        store=store,
        job_ref=job_ref,
    )
    assert shell_background_module._write_status(store, job_ref, status) is True

    job_dir = tmp_path / ".jenny" / "tool-results" / "abc123abc123"
    status_text = (job_dir / "status.json").read_text(encoding="utf-8")
    output_text = (job_dir / "output.txt").read_text(encoding="utf-8")
    assert token not in status_text
    assert token not in output_text
    assert "[REDACTED]" in status_text
    assert "[REDACTED]" in output_text


def test_write_status_refuses_an_invalid_v1_producer_shape(tmp_path: Path) -> None:
    store = shell_background_module.GuardedWorkspaceStore(tmp_path)
    job_ref = store.resolve(
        shell_background_module.WorkspaceStoreKind.TOOL_RESULTS,
        "abc123abc123",
    )

    shell_background_module._write_status(
        store,
        job_ref,
        {"job_id": "abc123abc123", "state": "running"},
    )

    assert not (tmp_path / ".jenny" / "tool-results" / "abc123abc123").exists()


def test_unresolved_command_hint_points_at_an_absolute_path() -> None:
    """A bare "not recognized" line must become actionable guidance.

    Owner repro (2026-08-21): run_command returned only cmd.exe's own message,
    so the model announced it would retry with the full path and the turn ended
    before it did. The result now names the resolved path up front.
    """
    windows_stderr = (
        "'powershell' is not recognized as an internal or external command,"
        " operable program or batch file."
    )
    hint = shell_module._unresolved_command_hint(windows_stderr)
    assert hint is not None
    assert "powershell" in hint.lower()
    if os.name == "nt":
        assert "WindowsPowerShell" in hint

    posix_hint = shell_module._unresolved_command_hint("sh: frobnicate: command not found")
    assert posix_hint is not None
    assert "frobnicate" in posix_hint

    assert shell_module._unresolved_command_hint("permission denied") is None
    assert shell_module._unresolved_command_hint("") is None


@pytest.mark.skipif(os.name != "nt", reason="PowerShell PATH repair is Windows-only")
def test_shell_environment_adds_powershell_directory_when_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """PowerShell lives in a PATH entry separate from System32.

    A launcher that trims PATH can leave cmd.exe resolvable while powershell is
    not, which is exactly how the owner's turn failed.
    """
    directory = shell_module._powershell_directory()
    if directory is None:
        pytest.skip("no Windows PowerShell on this host")

    monkeypatch.setenv("PATH", r"C:\Windows\System32")
    env = shell_module._shell_environment()
    assert env is not None
    assert str(directory) in env["PATH"].split(os.pathsep)

    # Already present -> no override, so the child keeps the inherited env.
    monkeypatch.setenv("PATH", os.pathsep.join([r"C:\Windows\System32", str(directory)]))
    assert shell_module._shell_environment() is None
