"""End-to-end cooperative cancellation for the builtin MCP server.

Spawns the real ``sidecar.ai.mcp.builtin_server`` subprocess, starts a
long-sleeping ``run_command``, then delivers ``notifications/cancelled`` for
the in-flight request and asserts:

- the tools/call answers promptly with ``CMP-TOOL-0041`` (aborted, not the
  600s command timeout), and
- the command's own subprocess tree is actually dead.

This is the regression gate for "Stop kills the running subprocess".
"""

from __future__ import annotations

import json
import os
import queue
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest

from sidecar.ai.error_codes import CMP_TOOL_COMMAND_ABORTED
from sidecar.ai.tools.builtins.owned_process import owned_process_pid_is_alive

_RESPONSE_WAIT_SECONDS = 20.0
_PID_FILE_WAIT_SECONDS = 15.0
_PROCESS_DEATH_WAIT_SECONDS = 5.0

_SLEEPER_SOURCE = """\
import os
import pathlib
import time

pathlib.Path("sleeper.pid").write_text(str(os.getpid()), encoding="utf-8")
time.sleep(120)
"""


def _spawn_builtin_server(workspace_root: Path) -> subprocess.Popen[str]:
    return subprocess.Popen(
        [
            sys.executable,
            "-m",
            "sidecar.ai.mcp.builtin_server",
            "--workspace-root",
            str(workspace_root),
            "--shell-enabled",
            "1",
        ],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        cwd=str(Path(__file__).resolve().parents[4]),
        # Mirror production: the MCP containment env forces utf-8 pipes
        # (process_containment.py), so the reader can decode strictly.
        env={**os.environ, "PYTHONIOENCODING": "utf-8"},
    )


def _start_stdout_reader(process: subprocess.Popen[str]) -> "queue.Queue[str | None]":
    lines: "queue.Queue[str | None]" = queue.Queue()

    def _pump() -> None:
        assert process.stdout is not None
        for line in process.stdout:
            lines.put(line)
        lines.put(None)

    threading.Thread(target=_pump, daemon=True).start()
    return lines


def _write_message(process: subprocess.Popen[str], payload: dict[str, object]) -> None:
    assert process.stdin is not None
    process.stdin.write(json.dumps(payload) + "\n")
    process.stdin.flush()


def _next_response(
    lines: "queue.Queue[str | None]",
    *,
    timeout_seconds: float,
) -> dict[str, object]:
    deadline = time.monotonic() + timeout_seconds
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            pytest.fail("timed out waiting for a builtin server response line")
        try:
            line = lines.get(timeout=min(0.2, remaining))
        except queue.Empty:
            continue
        if line is None:
            pytest.fail("builtin server closed stdout before responding")
        stripped = line.strip()
        if not stripped:
            continue
        response = json.loads(stripped)
        if "id" not in response:
            continue
        return response


def _wait_for_pid_file(pid_file: Path) -> int:
    deadline = time.monotonic() + _PID_FILE_WAIT_SECONDS
    while time.monotonic() < deadline:
        if pid_file.exists():
            text = pid_file.read_text(encoding="utf-8").strip()
            if text:
                return int(text)
        time.sleep(0.1)
    pytest.fail("run_command sleeper never wrote its pid file")


def _wait_for_pid_death(pid: int) -> bool:
    deadline = time.monotonic() + _PROCESS_DEATH_WAIT_SECONDS
    while time.monotonic() < deadline:
        if not owned_process_pid_is_alive(pid):
            return True
        time.sleep(0.1)
    return False


def test_cancel_notification_aborts_running_command(tmp_path: Path) -> None:
    (tmp_path / "sleeper.py").write_text(_SLEEPER_SOURCE, encoding="utf-8")
    server = _spawn_builtin_server(tmp_path)
    try:
        lines = _start_stdout_reader(server)
        command = f'"{sys.executable}" sleeper.py'
        _write_message(
            server,
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": {
                    "name": "run_command",
                    "arguments": {"command": command, "timeout_seconds": 120},
                },
            },
        )
        sleeper_pid = _wait_for_pid_file(tmp_path / "sleeper.pid")
        assert owned_process_pid_is_alive(sleeper_pid)

        cancelled_at = time.monotonic()
        _write_message(
            server,
            {
                "jsonrpc": "2.0",
                "method": "notifications/cancelled",
                "params": {"requestId": 1, "reason": "turn_cancelled"},
            },
        )
        response = _next_response(lines, timeout_seconds=_RESPONSE_WAIT_SECONDS)
        answered_after = time.monotonic() - cancelled_at

        assert response.get("id") == 1
        error = response.get("error")
        assert isinstance(error, dict), f"expected aborted error, got: {response}"
        data = error.get("data")
        assert isinstance(data, dict)
        assert data.get("code") == CMP_TOOL_COMMAND_ABORTED
        # Aborted promptly — nowhere near the 120s command budget.
        assert answered_after < _RESPONSE_WAIT_SECONDS
        assert _wait_for_pid_death(sleeper_pid), (
            f"sleeper pid {sleeper_pid} survived cooperative cancellation"
        )
    finally:
        if server.stdin is not None:
            server.stdin.close()
        try:
            server.wait(timeout=5)
        except subprocess.TimeoutExpired:
            server.kill()
            server.wait(timeout=5)


def test_cancel_notification_for_unknown_request_is_ignored(tmp_path: Path) -> None:
    server = _spawn_builtin_server(tmp_path)
    try:
        lines = _start_stdout_reader(server)
        # A cancellation for a request that is not in flight must not produce
        # a response and must not disturb the next real call.
        _write_message(
            server,
            {
                "jsonrpc": "2.0",
                "method": "notifications/cancelled",
                "params": {"requestId": 42},
            },
        )
        _write_message(
            server,
            {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}},
        )
        response = _next_response(lines, timeout_seconds=_RESPONSE_WAIT_SECONDS)
        assert response.get("id") == 2
        assert isinstance(response.get("result"), dict)
    finally:
        if server.stdin is not None:
            server.stdin.close()
        try:
            server.wait(timeout=5)
        except subprocess.TimeoutExpired:
            server.kill()
            server.wait(timeout=5)
