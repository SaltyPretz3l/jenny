"""Reusable process and HTTP seams for opt-in live local-model evidence.

The helpers deliberately retain only bounded protocol metadata.  They never
persist prompts, generated text, tool arguments, provider payloads, or paths.
"""

from __future__ import annotations

import json
import os
import queue
import signal
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Sequence

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from sidecar.protocol import API_VERSION, CONTENT_LENGTH_HEADER  # noqa: E402
from sidecar.runtime.framing import read_framed_message, write_framed_message  # noqa: E402

MAX_FRAME_BYTES = 10 * 1024 * 1024
MAX_HTTP_BODY_BYTES = 16 * 1024 * 1024
STDERR_TAIL_BYTES = 8192


class SidecarReaderClosed(RuntimeError):
    """Raised when the sidecar stdout closes before the expected response."""


class JsonRpcSidecar:
    """Own one sidecar process and exchange real framed JSON-RPC messages."""

    def __init__(
        self,
        *,
        command: Sequence[str] | None = None,
        cwd: Path = ROOT,
        env: dict[str, str] | None = None,
    ) -> None:
        self._messages: queue.Queue[dict[str, Any] | BaseException] = queue.Queue()
        self._stderr_chunks: list[bytes] = []
        self._stderr_lock = threading.Lock()
        self._next_id = 1
        self._write_lock = threading.Lock()
        argv = list(command or (sys.executable, "-m", "sidecar"))
        creationflags = (
            getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
            if sys.platform.startswith("win")
            else 0
        )
        self.process = subprocess.Popen(
            argv,
            cwd=cwd,
            env=env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            creationflags=creationflags,
            start_new_session=not sys.platform.startswith("win"),
        )
        self._stdout_thread = threading.Thread(target=self._read_stdout, daemon=True)
        self._stderr_thread = threading.Thread(target=self._read_stderr, daemon=True)
        self._stdout_thread.start()
        self._stderr_thread.start()

    def request(
        self,
        method: str,
        params: dict[str, Any],
        *,
        timeout_seconds: float,
    ) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        message_id = self._next_id
        self._next_id += 1
        self._write({"jsonrpc": "2.0", "id": message_id, "method": method, "params": params})
        deadline = time.monotonic() + timeout_seconds
        notifications: list[dict[str, Any]] = []
        while True:
            message = self._next_message(deadline)
            if message.get("id") == message_id:
                return message, notifications
            if "method" in message:
                notifications.append(message)

    def inspect(self, *, timeout_seconds: float = 30.0) -> dict[str, Any]:
        response, _ = self.request(
            "harness.inspect",
            {"accept_version": API_VERSION},
            timeout_seconds=timeout_seconds,
        )
        result = response.get("result")
        if not isinstance(result, dict):
            raise RuntimeError("harness.inspect returned no object result")
        return result

    def shutdown(self, *, timeout_seconds: float = 5.0) -> None:
        if self.process.poll() is not None:
            return
        try:
            self.request(
                "shutdown",
                {"accept_version": API_VERSION},
                timeout_seconds=timeout_seconds,
            )
        except Exception:  # noqa: BLE001 - cleanup is best effort
            pass
        self._terminate()

    def _write(self, message: dict[str, Any]) -> None:
        if self.process.stdin is None:
            raise RuntimeError("sidecar stdin is unavailable")
        with self._write_lock:
            write_framed_message(
                stdout_buffer=self.process.stdin,
                content_length_header=CONTENT_LENGTH_HEADER,
                message=message,
            )

    def _next_message(self, deadline: float) -> dict[str, Any]:
        remaining = max(deadline - time.monotonic(), 0.0)
        if remaining <= 0:
            raise TimeoutError("timed out waiting for sidecar response")
        try:
            item = self._messages.get(timeout=remaining)
        except queue.Empty as error:
            raise TimeoutError("timed out waiting for sidecar response") from error
        if isinstance(item, BaseException):
            raise RuntimeError(f"sidecar reader failed: {type(item).__name__}") from item
        return item

    def _read_stdout(self) -> None:
        assert self.process.stdout is not None
        while True:
            try:
                message = read_framed_message(
                    stdin_buffer=self.process.stdout,
                    content_length_header=CONTENT_LENGTH_HEADER,
                    max_content_length_bytes=MAX_FRAME_BYTES,
                )
            except EOFError:
                self._messages.put(SidecarReaderClosed("sidecar stdout closed"))
                return
            except BaseException as error:  # noqa: BLE001 - forwarded to owner thread
                self._messages.put(error)
                return
            self._messages.put(message)

    def _read_stderr(self) -> None:
        assert self.process.stderr is not None
        while True:
            chunk = self.process.stderr.read(1024)
            if not chunk:
                return
            with self._stderr_lock:
                self._stderr_chunks.append(chunk)
                joined = b"".join(self._stderr_chunks)[-STDERR_TAIL_BYTES:]
                self._stderr_chunks = [joined]

    def _terminate(self) -> None:
        if self.process.poll() is not None:
            return
        if sys.platform.startswith("win"):
            subprocess.run(
                ["taskkill", "/PID", str(self.process.pid), "/T", "/F"],
                check=False,
                capture_output=True,
                text=True,
            )
        else:
            os.killpg(self.process.pid, signal.SIGTERM)
        try:
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait(timeout=5)


@dataclass(frozen=True)
class CapturedRequest:
    path: str
    fields: dict[str, Any]


class ForwardingCaptureProxy:
    """Forward a local provider endpoint while retaining sampler fields only."""

    _OLLAMA_FIELDS = (
        "temperature",
        "top_k",
        "top_p",
        "min_p",
        "repeat_penalty",
        "num_ctx",
    )
    _OPENAI_FIELDS = (
        "temperature",
        "top_k",
        "top_p",
        "min_p",
        "presence_penalty",
        "repeat_penalty",
        "repetition_penalty",
    )

    def __init__(self, upstream: str) -> None:
        self.upstream = upstream.rstrip("/")
        self._captures: list[CapturedRequest] = []
        self._capture_lock = threading.Lock()
        self._server: ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None

    @property
    def url(self) -> str:
        if self._server is None:
            raise RuntimeError("capture proxy is not started")
        host, port = self._server.server_address[:2]
        return f"http://{host}:{port}"

    def captures(self, *, path: str | None = None) -> list[CapturedRequest]:
        with self._capture_lock:
            items = list(self._captures)
        return [item for item in items if path is None or item.path == path]

    def start(self) -> "ForwardingCaptureProxy":  # noqa: C901 - local forwarding boundary
        owner = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.0"

            def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler contract
                self._forward(None)

            def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler contract
                length = int(self.headers.get("Content-Length") or 0)
                if length < 0 or length > MAX_HTTP_BODY_BYTES:
                    self.send_error(413)
                    return
                self._forward(self.rfile.read(length))

            def log_message(self, _format: str, *_args: object) -> None:
                return

            def _forward(self, body: bytes | None) -> None:
                if body:
                    owner._capture(self.path, body)
                headers = {
                    key: value
                    for key, value in self.headers.items()
                    if key.lower() not in {"host", "connection", "content-length"}
                }
                request = urllib.request.Request(
                    f"{owner.upstream}{self.path}",
                    data=body,
                    headers=headers,
                    method=self.command,
                )
                try:
                    response = urllib.request.urlopen(request, timeout=900)  # noqa: S310
                except urllib.error.HTTPError as error:
                    response = error
                except (OSError, urllib.error.URLError, TimeoutError):
                    self.send_error(502)
                    return
                with response:
                    try:
                        self.send_response(response.status)
                        content_type = response.headers.get("Content-Type")
                        if content_type:
                            self.send_header("Content-Type", content_type)
                        self.send_header("Connection", "close")
                        self.end_headers()
                        while True:
                            chunk = response.read(8192)
                            if not chunk:
                                break
                            self.wfile.write(chunk)
                            self.wfile.flush()
                    except OSError:
                        # The sidecar may close a warmup request during orderly
                        # shutdown; that is normal and must not pollute evidence.
                        return

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()
        return self

    def close(self) -> None:
        if self._server is not None:
            self._server.shutdown()
            self._server.server_close()
        if self._thread is not None:
            self._thread.join(timeout=5)
        self._server = None
        self._thread = None

    def __enter__(self) -> "ForwardingCaptureProxy":
        return self.start()

    def __exit__(self, *_exc: object) -> None:
        self.close()

    def _capture(self, path: str, body: bytes) -> None:
        try:
            payload = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return
        if not isinstance(payload, dict):
            return
        if path.startswith("/api/"):
            source = payload.get("options") if isinstance(payload.get("options"), dict) else {}
            allowed = self._OLLAMA_FIELDS
        elif path.startswith("/v1/"):
            source = payload
            allowed = self._OPENAI_FIELDS
        else:
            return
        fields = {key: source[key] for key in allowed if key in source}
        with self._capture_lock:
            self._captures.append(CapturedRequest(path=path.split("?", 1)[0], fields=fields))


__all__ = [
    "API_VERSION",
    "CapturedRequest",
    "ForwardingCaptureProxy",
    "JsonRpcSidecar",
    "ROOT",
    "SidecarReaderClosed",
]
