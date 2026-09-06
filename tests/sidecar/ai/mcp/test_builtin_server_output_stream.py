"""End-to-end live output streaming from the builtin MCP server (W2-1).

Spawns the real ``sidecar.ai.mcp.builtin_server`` subprocess, runs a
``run_command`` that prints to stdout/stderr, and asserts the server writes
id-less ``tool/output_chunk`` notifications tagged with the in-flight request
id BEFORE the call's response line — and that the final response still carries
the full captured output (the live tail never replaces the snapshot).
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

_RESPONSE_WAIT_SECONDS = 30.0

_PRINTER_SOURCE = """\
import sys

print("live-line-1")
print("live-line-2")
print("live-err-1", file=sys.stderr)
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


def _read_until_response(
    lines: "queue.Queue[str | None]",
    *,
    response_id: int,
    timeout_seconds: float,
) -> tuple[dict[str, object], list[dict[str, object]]]:
    """Collect id-less notification payloads until the matching response."""
    notifications: list[dict[str, object]] = []
    deadline = time.monotonic() + timeout_seconds
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            pytest.fail("timed out waiting for the builtin server response line")
        try:
            line = lines.get(timeout=min(0.2, remaining))
        except queue.Empty:
            continue
        if line is None:
            pytest.fail("builtin server closed stdout before responding")
        stripped = line.strip()
        if not stripped:
            continue
        payload = json.loads(stripped)
        if payload.get("id") == response_id:
            return payload, notifications
        if "id" not in payload:
            notifications.append(payload)


def test_run_command_streams_output_chunks_before_the_response(tmp_path: Path) -> None:
    (tmp_path / "printer.py").write_text(_PRINTER_SOURCE, encoding="utf-8")
    server = _spawn_builtin_server(tmp_path)
    try:
        lines = _start_stdout_reader(server)
        command = f'"{sys.executable}" printer.py'
        _write_message(
            server,
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": {
                    "name": "run_command",
                    "arguments": {"command": command, "timeout_seconds": 60},
                },
            },
        )
        response, notifications = _read_until_response(
            lines, response_id=1, timeout_seconds=_RESPONSE_WAIT_SECONDS
        )

        chunk_notes = [
            note
            for note in notifications
            if note.get("method") == "tool/output_chunk"
        ]
        assert chunk_notes, (
            f"expected tool/output_chunk notifications before the response; saw: {notifications}"
        )
        streamed_lines: list[dict[str, object]] = []
        for note in chunk_notes:
            params = note.get("params")
            assert isinstance(params, dict)
            assert params.get("request_id") == 1
            assert isinstance(params.get("sequence"), int)
            note_lines = params.get("lines")
            assert isinstance(note_lines, list)
            streamed_lines.extend(note_lines)
        streamed_text = [str(line.get("text")) for line in streamed_lines]
        assert "live-line-1" in streamed_text
        assert "live-line-2" in streamed_text
        assert any(
            line.get("stream") == "stderr" and line.get("text") == "live-err-1"
            for line in streamed_lines
        )

        # The final response snapshot is untouched by the live tail.
        result = response.get("result")
        assert isinstance(result, dict)
        content = result.get("content")
        assert isinstance(content, list) and content
        text_blob = str(content[0].get("text"))
        assert "live-line-1" in text_blob
        assert "live-line-2" in text_blob
    finally:
        if server.stdin is not None:
            server.stdin.close()
        try:
            server.wait(timeout=5)
        except subprocess.TimeoutExpired:
            server.kill()
            server.wait(timeout=5)
