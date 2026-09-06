"""Real stdio regression coverage for grep_search's isolated worker.

The builtin server keeps a thread blocked on stdin so cancellation notifications
can be received while a tool call runs. On Windows, the old multiprocessing
worker deadlocked in spawn bootstrap whenever that pump was active. This test
must use the real server subprocess; direct handler tests cannot reproduce the
failure boundary.
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

_RESPONSE_WAIT_SECONDS = 20.0


def _spawn_builtin_server(workspace_root: Path) -> subprocess.Popen[str]:
    return subprocess.Popen(
        [
            sys.executable,
            "-m",
            "sidecar.ai.mcp.builtin_server",
            "--workspace-root",
            str(workspace_root),
            "--grep-enabled",
            "1",
        ],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        cwd=str(Path(__file__).resolve().parents[4]),
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


def _read_response(
    lines: "queue.Queue[str | None]",
    *,
    response_id: int,
) -> dict[str, object]:
    deadline = time.monotonic() + _RESPONSE_WAIT_SECONDS
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            pytest.fail("timed out waiting for builtin grep response")
        try:
            line = lines.get(timeout=min(0.2, remaining))
        except queue.Empty:
            continue
        if line is None:
            pytest.fail("builtin server exited before returning grep response")
        payload = json.loads(line)
        if payload.get("id") == response_id:
            return payload


def test_grep_search_worker_starts_while_builtin_stdin_pump_is_blocked(
    tmp_path: Path,
) -> None:
    (tmp_path / "sample.txt").write_text("alpha\nneedle\nomega\n", encoding="utf-8")
    server = _spawn_builtin_server(tmp_path)
    try:
        lines = _start_stdout_reader(server)
        _write_message(
            server,
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": {
                    "name": "grep_search",
                    "arguments": {
                        "pattern": "needle",
                        "path": ".",
                        "max_results": 10,
                    },
                },
            },
        )
        response = _read_response(lines, response_id=1)

        assert "error" not in response
        result = response.get("result")
        assert isinstance(result, dict)
        assert result.get("success") is True
        content = result.get("content")
        assert isinstance(content, list) and content
        assert "sample.txt:2:needle" in str(content[0].get("text"))
    finally:
        if server.stdin is not None:
            server.stdin.close()
        try:
            server.wait(timeout=5)
        except subprocess.TimeoutExpired:
            server.kill()
            server.wait(timeout=5)
