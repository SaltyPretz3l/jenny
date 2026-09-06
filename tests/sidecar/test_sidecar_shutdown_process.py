"""Real framed-stdio regression for graceful sidecar shutdown."""

from __future__ import annotations

import json
import os
import queue
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any, BinaryIO

from sidecar.protocol import API_VERSION


def _frame(payload: dict[str, Any]) -> bytes:
    body = json.dumps(payload).encode("utf-8")
    return f"Content-Length: {len(body)}\r\n\r\n".encode("ascii") + body


def _read_frame(stream: BinaryIO) -> dict[str, Any]:
    content_length = 0
    while True:
        line = stream.readline()
        if not line:
            raise EOFError("sidecar stdout closed before a complete frame")
        if line in {b"\r\n", b"\n"}:
            break
        name, _, value = line.decode("ascii").partition(":")
        if name.lower() == "content-length":
            content_length = int(value.strip())
    if content_length <= 0:
        raise ValueError("missing Content-Length")
    body = stream.read(content_length)
    if len(body) != content_length:
        raise EOFError("sidecar stdout closed during frame body")
    return json.loads(body.decode("utf-8"))


def _read_frame_bounded(stream: BinaryIO, timeout_seconds: float) -> dict[str, Any]:
    results: queue.Queue[dict[str, Any] | BaseException] = queue.Queue(maxsize=1)

    def read() -> None:
        try:
            results.put(_read_frame(stream))
        except BaseException as error:  # noqa: BLE001
            results.put(error)

    threading.Thread(target=read, name="test-sidecar-frame-reader", daemon=True).start()
    result = results.get(timeout=timeout_seconds)
    if isinstance(result, BaseException):
        raise result
    return result


def test_real_sidecar_shutdown_acknowledges_and_exits_without_force_kill(
    tmp_path: Path,
) -> None:
    repo_root = Path(__file__).resolve().parents[2]
    env = {
        key: value
        for key, value in os.environ.items()
        if not key.upper().startswith("JENNY_")
    }
    env.update(
        {
            "HOME": str(tmp_path),
            "USERPROFILE": str(tmp_path),
            "PYTHONUNBUFFERED": "1",
            "JENNY_PARENT_PID": str(os.getpid()),
        }
    )
    process = subprocess.Popen(
        [sys.executable, "-m", "sidecar"],
        cwd=repo_root,
        env=env,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
    )
    assert process.stdin is not None
    assert process.stdout is not None
    try:
        process.stdin.write(
            _frame(
                {
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "initialize",
                    "params": {
                        "accept_version": API_VERSION,
                        "config": {
                            "engine_type": "mock",
                            "feature_flags": {
                                "multiplexer": True,
                                "chat_cancel": True,
                            },
                        },
                    },
                }
            )
        )
        process.stdin.flush()
        initialized = _read_frame_bounded(process.stdout, 5.0)
        assert initialized["id"] == 1
        assert "result" in initialized

        started_at = time.monotonic()
        process.stdin.write(
            _frame(
                {
                    "jsonrpc": "2.0",
                    "id": 2,
                    "method": "shutdown",
                    "params": {"accept_version": API_VERSION},
                }
            )
        )
        process.stdin.flush()
        acknowledged = _read_frame_bounded(process.stdout, 2.0)
        assert acknowledged["id"] == 2
        assert acknowledged["result"]["status"] == "shutting_down"

        # Electron owns the write half and closes it immediately after the
        # acknowledgement. This is what releases Python's blocking reader.
        process.stdin.close()
        assert process.wait(timeout=3.0) == 0
        assert time.monotonic() - started_at < 3.0
    finally:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=2.0)
