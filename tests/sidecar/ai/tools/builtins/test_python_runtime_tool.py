"""Focused failure-redaction regressions for the Python runtime tool."""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from sidecar.ai.error_codes import CMP_TOOL_PYTHON_EXECUTION_FAILED
from sidecar.ai.tools.builtins.python_runtime import tool
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.workspace import WorkspaceGuard


def test_python_execute_unexpected_failure_redacts_configured_paths(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    private_path = tmp_path / "private" / "missing-wheelhouse"

    def fail_runtime(_config: object, **_kwargs: object) -> Path:
        raise RuntimeError(f"Configured python runtime wheelhouse not found: {private_path}")

    monkeypatch.setattr(tool.sys, "platform", "win32")
    monkeypatch.setattr(
        tool,
        "_PYTHON_RUNTIME_CONFIG",
        {"tools_python_runtime_wheelhouse_dir": str(private_path)},
    )
    monkeypatch.setattr(tool, "ensure_runtime_venv", fail_runtime)

    with pytest.raises(ToolExecutionFailure) as exc_info:
        tool.python_execute_tool({"code": "print(1)"}, WorkspaceGuard(str(tmp_path)))

    assert exc_info.value.code == CMP_TOOL_PYTHON_EXECUTION_FAILED
    assert str(private_path) not in exc_info.value.message
    assert exc_info.value.error_type == "RuntimeError"
    # The detail field reaches the model and the transcript exactly like
    # the message does; redaction that stops at the message is no redaction.
    details = exc_info.value.to_error_data()
    assert str(private_path) not in details.get("error_message", "")
    assert "[redacted:path]" in details.get("error_message", "")


def test_bootstrap_lock_timeout_between_phases_is_redacted(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A failure raised outside every telemetry phase still gets redacted.

    The lock wait raises a bare TimeoutError naming the lock path; nothing has
    stamped a bootstrap_error_message on it, so the sink must do the work.
    """
    lock_path = tmp_path / "private" / ".bootstrap.lock"

    def fail_runtime(_config: object, **_kwargs: object) -> Path:
        raise TimeoutError(f"Timed out waiting for python runtime bootstrap lock: {lock_path}")

    monkeypatch.setattr(tool.sys, "platform", "win32")
    monkeypatch.setattr(tool, "_PYTHON_RUNTIME_CONFIG", {})
    monkeypatch.setattr(tool, "ensure_runtime_venv", fail_runtime)

    with pytest.raises(ToolExecutionFailure) as exc_info:
        tool.python_execute_tool({"code": "print(1)"}, WorkspaceGuard(str(tmp_path)))

    details = exc_info.value.to_error_data()
    assert str(lock_path) not in details["error_message"]
    assert str(tmp_path) not in exc_info.value.message
    assert details["error_type"] == "TimeoutError"


def test_bootstrap_timeout_reports_the_phase_that_ran_out_of_time(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A pip timeout is the likeliest bootstrap failure; it must not be reported
    as a bare "bootstrap" timeout when the phase context already knows more."""
    private = tmp_path / "private" / "wheelhouse"

    def fail_runtime(_config: object, **_kwargs: object) -> Path:
        error = subprocess.TimeoutExpired(cmd=["python", "-m", "pip"], timeout=120)
        error.failed_phase = "install_finished"  # type: ignore[attr-defined]
        error.bootstrap_error_message = (  # type: ignore[attr-defined]
            "TimeoutExpired: pip timed out; stderr tail: [redacted:path]"
        )
        error.phase_timings_json = '{"install_finished": 120000.0}'  # type: ignore[attr-defined]
        error.stderr = f"looking in {private}"  # type: ignore[attr-defined]
        raise error

    monkeypatch.setattr(tool.sys, "platform", "win32")
    monkeypatch.setattr(tool, "_PYTHON_RUNTIME_CONFIG", {})
    monkeypatch.setattr(tool, "ensure_runtime_venv", fail_runtime)

    with pytest.raises(ToolExecutionFailure) as exc_info:
        tool.python_execute_tool({"code": "print(1)"}, WorkspaceGuard(str(tmp_path)))

    details = exc_info.value.to_error_data()
    assert details["failed_phase"] == "install_finished"
    assert details["failure_class"] == "limit_exceeded"
    assert details["phase_timings_json"] == '{"install_finished": 120000.0}'
    assert "package installation" in exc_info.value.message
    assert str(private) not in details["error_message"]
