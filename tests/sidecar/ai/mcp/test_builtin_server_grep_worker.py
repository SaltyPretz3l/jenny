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


def test_a_worker_request_carries_the_scope_identity_and_the_worker_pins_with_it(
    monkeypatch, tmp_path: Path,
) -> None:
    """Any OS: the parent sends its scope's pair and switch; the worker pins with them."""
    from contextlib import contextmanager

    from sidecar.ai.tools import hosted_file_io
    from sidecar.ai.tools.builtins import grep_search_worker as worker

    class Pin:
        closed = 0

        def close(self) -> None:
            Pin.closed += 1

    class Backend:
        pinned: list[tuple] = []

        def open_root(self, root, device, inode):
            self.pinned.append((root, device, inode))
            return Pin()

    monkeypatch.setattr(hosted_file_io, "select_backend", lambda platform: Backend())
    with hosted_file_io.scoped_hosted_file_io(
        str(tmp_path), enabled=True, expected_device_id="7", expected_inode="9"
    ):
        fields = worker.hosted_request_fields()
    assert fields == {"hosted_file_io": True, "hosted_win32_files": False,
                      "workspace_device_id": "7", "workspace_inode": "9"}
    assert Pin.closed == 1, "the scope closed its pin"

    seen: list[tuple] = []

    @contextmanager
    def recording_scope(root, *, enabled, expected_device_id, expected_inode):
        seen.append((root, enabled, expected_device_id, expected_inode,
                     hosted_file_io.hosted_win32_files_enabled()))
        yield

    monkeypatch.setattr(worker, "scoped_hosted_file_io", recording_scope)
    request = {"workspace_root": str(tmp_path), **fields, "hosted_win32_files": True}
    try:
        with worker._request_root(request) as root:
            assert root == tmp_path
    finally:
        hosted_file_io.set_hosted_win32_files(False)
    assert seen == [(str(tmp_path), True, "7", "9", True)]


def test_both_request_senders_put_the_hosted_fields_on_the_wire(monkeypatch, tmp_path: Path) -> None:
    """Any OS, through the real senders: without these fields a hosted worker would
    pin nothing and its reads would have no pair (review item 8)."""
    import re

    from sidecar.ai.tools import hosted_file_io
    from sidecar.ai.tools.builtins import grep_search_client, grep_search_worker
    from sidecar.ai.tools.builtins.grep_search_file import worker_ok_response

    class Pin:
        def close(self) -> None:
            pass

    class Backend:
        def open_root(self, root, device, inode):
            return Pin()

    empty = grep_search_worker._EMPTY_RESULT
    wire: list[dict[str, object]] = []

    class Wire:
        def send(self, request, *, expected_responses=1):
            wire.append(dict(request))

        def receive(self, timeout_seconds):
            return worker_ok_response(empty)

    monkeypatch.setattr(hosted_file_io, "select_backend", lambda platform: Backend())
    client = grep_search_client._RegexSearchWorker()
    monkeypatch.setattr(client, "send", Wire().send)
    monkeypatch.setattr(client, "receive", Wire().receive)
    hosted_file_io.set_hosted_win32_files(True)
    try:
        with hosted_file_io.scoped_hosted_file_io(
            str(tmp_path), enabled=True, expected_device_id="7", expected_inode="9"
        ):
            client.search(path=tmp_path / "a.txt", compiled=re.compile("x"), workspace_root=tmp_path,
                          context_lines=0, max_output_matches=1, max_output_bytes=100,
                          timeout_seconds=5)
            list(grep_search_worker.scan_text_batches(
                Wire(), [tmp_path / "a.txt"], re.compile("x"), workspace_root=tmp_path,
                context_lines=0, max_output_matches=1, max_output_bytes=100, max_file_bytes=100,
                timeout_seconds=5))
    finally:
        hosted_file_io.set_hosted_win32_files(False)
    assert len(wire) == 2
    for request in wire:
        assert {key: request[key] for key in ("hosted_file_io", "hosted_win32_files",
                                              "workspace_device_id", "workspace_inode")} == {
            "hosted_file_io": True, "hosted_win32_files": True,
            "workspace_device_id": "7", "workspace_inode": "9"}


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX only: the descriptor backend")
def test_posix_grep_worker_pins_per_request_and_a_stale_pair_fails_the_request(tmp_path: Path) -> None:
    """Since 3b-4b the POSIX grep worker pins per request with the parent's pair."""
    from sidecar.ai.error_codes import CMP_TOOL_INVALID_PATH
    from sidecar.ai.tools.builtins import grep_search_worker as worker

    root = tmp_path.resolve()
    (root / "a.txt").write_text("needle\n", encoding="utf-8")
    status = root.stat()
    request = {"path": str(root / "a.txt"), "pattern": "needle", "flags": 0,
               "workspace_root": str(root), "hosted_file_io": True, "hosted_win32_files": False,
               "workspace_device_id": str(status.st_dev), "workspace_inode": str(status.st_ino),
               "context_lines": 0, "max_output_matches": 10, "max_output_bytes": 4096}

    assert worker.run_worker_request(request).get("status") == "ok"
    stale = worker.run_worker_request({**request, "workspace_inode": str(status.st_ino + 1)})
    assert stale.get("status") == "error" and stale.get("error_code") == CMP_TOOL_INVALID_PATH
