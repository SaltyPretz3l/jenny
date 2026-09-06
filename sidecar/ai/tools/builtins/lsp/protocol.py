"""Minimal stdio JSON-RPC session for local language servers.

Tool handlers and result normalization live in sibling modules.
"""

from __future__ import annotations

import json
import logging
import os
import signal
import subprocess
import threading
import time
from collections import deque
from concurrent.futures import ThreadPoolExecutor, TimeoutError
from contextlib import suppress
from dataclasses import dataclass
from pathlib import Path
from typing import Any, BinaryIO, Deque, Sequence, cast

from sidecar.runtime.bounded_io import BoundedBinaryReader, BoundedIOError
from sidecar.runtime.diagnostics import log_event
from sidecar.runtime.process_containment import log_containment_degraded
from sidecar.runtime.process_job import WindowsJobObject

logger = logging.getLogger(__name__)

_CONTENT_LENGTH = "content-length"
_DEFAULT_REQUEST_TIMEOUT_SECONDS = 5.0
_DEFAULT_CLOSE_TIMEOUT_SECONDS = 2.0
_DEFAULT_STDERR_TAIL_CHARS = 4_000
_DEFAULT_MAX_MESSAGE_BYTES = 8_000_000
_DEFAULT_NOTIFICATION_BUFFER_SIZE = 128
_READ_CHUNK_BYTES = 512
_MAX_HEADER_LINE_BYTES = 8 * 1024
_MAX_HEADER_BYTES = 64 * 1024
_MAX_HEADER_COUNT = 32


class LSPProtocolError(RuntimeError):
    """Raised when the language server violates the JSON-RPC/LSP framing contract."""


class LSPRequestTimeout(LSPProtocolError):
    """Raised when a language-server request does not produce a response in time."""


class LSPServerTerminated(LSPProtocolError):
    """Raised when the language-server process exits before answering a request."""

    def __init__(self, message: str, *, stderr_tail: str = "") -> None:
        super().__init__(message)
        self.stderr_tail = stderr_tail


def _read_lsp_headers(reader: BoundedBinaryReader) -> dict[str, str]:
    headers: dict[str, str] = {}
    header_bytes = 0
    header_count = 0
    try:
        while True:
            line = reader.read_line(max_bytes=_MAX_HEADER_LINE_BYTES)
            if not line:
                raise LSPServerTerminated("LSP process closed stdout")
            header_bytes += len(line)
            if header_bytes > _MAX_HEADER_BYTES:
                raise BoundedIOError("LSP headers exceeded their aggregate limit")
            if line in (b"\r\n", b"\n"):
                return headers
            header_count += 1
            if header_count > _MAX_HEADER_COUNT:
                raise BoundedIOError("LSP header count exceeded its limit")
            decoded = line.decode("ascii", errors="replace").strip()
            if ":" not in decoded:
                raise LSPProtocolError("malformed LSP header")
            key, value = decoded.split(":", 1)
            headers[key.lower()] = value.strip()
    except BoundedIOError as error:
        log_event(
            logger,
            logging.WARNING,
            component="ai.tools.lsp.protocol",
            event="ai.tools.lsp.protocol.frame_bounded",
            message="Language-server framing exceeded a bounded read contract.",
            status="failure",
            data={"reason": str(error)},
        )
        raise LSPProtocolError("LSP framing exceeded configured limits") from error


def _terminate_lsp_posix_group(
    process: subprocess.Popen[bytes],
    process_group_id: int,
    *,
    timeout_seconds: float,
) -> None:
    if not hasattr(os, "killpg"):
        process.terminate()
        return
    try:
        os.killpg(process_group_id, signal.SIGTERM)
    except ProcessLookupError:
        return
    if process.poll() is None:
        try:
            process.wait(timeout=max(0.1, timeout_seconds))
        except subprocess.TimeoutExpired:
            pass
    time.sleep(min(max(0.01, timeout_seconds), 0.1))
    kill_signal = getattr(signal, "SIGKILL", signal.SIGTERM)
    try:
        os.killpg(process_group_id, kill_signal)
    except ProcessLookupError:
        return
    if process.poll() is None:
        process.wait(timeout=max(0.1, timeout_seconds))


@dataclass(frozen=True)
class LSPProcessSessionLimits:
    request_timeout_seconds: float = _DEFAULT_REQUEST_TIMEOUT_SECONDS
    close_timeout_seconds: float = _DEFAULT_CLOSE_TIMEOUT_SECONDS
    stderr_tail_chars: int = _DEFAULT_STDERR_TAIL_CHARS
    max_message_bytes: int = _DEFAULT_MAX_MESSAGE_BYTES


class _StderrTail:
    def __init__(self, stream: BinaryIO, *, max_chars: int) -> None:
        self._stream = stream
        self._max_chars = max(0, int(max_chars))
        self._lock = threading.Lock()
        self._text = ""
        self._thread = threading.Thread(target=self._read_loop, daemon=True)

    def start(self) -> None:
        self._thread.start()

    def tail(self) -> str:
        with self._lock:
            return self._text[-self._max_chars :] if self._max_chars else ""

    def _read_loop(self) -> None:
        while True:
            try:
                chunk = self._stream.read(_READ_CHUNK_BYTES)
            except OSError:
                return
            if not chunk:
                return
            text = chunk.decode("utf-8", errors="replace")
            if not self._max_chars:
                continue
            with self._lock:
                self._text = (self._text + text)[-self._max_chars :]


class LSPProcessSession:
    """Persistent Content-Length JSON-RPC peer for one language server process."""

    def __init__(
        self,
        *,
        command: Sequence[str],
        workspace_root: Path | str,
        limits: LSPProcessSessionLimits | None = None,
    ) -> None:
        if not command:
            raise ValueError("language-server command is required")
        resolved_limits = limits or LSPProcessSessionLimits()
        self._command = tuple(str(part) for part in command)
        self._workspace_root = Path(workspace_root)
        self._request_timeout_seconds = max(0.001, float(resolved_limits.request_timeout_seconds))
        self._close_timeout_seconds = max(0.001, float(resolved_limits.close_timeout_seconds))
        self._stderr_tail_chars = max(0, int(resolved_limits.stderr_tail_chars))
        self._max_message_bytes = max(1, int(resolved_limits.max_message_bytes))
        self._lock = threading.Lock()
        self._next_request_id = 1
        self._closed = False
        self._process: subprocess.Popen[bytes] | None = None
        self._stderr_tail: _StderrTail | None = None
        self._stdout_reader: BoundedBinaryReader | None = None
        self._job_object: WindowsJobObject | None = None
        self._process_group_id: int | None = None
        self._reader = ThreadPoolExecutor(max_workers=1, thread_name_prefix="jenny-lsp-reader")
        self._notifications: Deque[dict[str, Any]] = deque(
            maxlen=_DEFAULT_NOTIFICATION_BUFFER_SIZE
        )
        self._notifications_lock = threading.Lock()

    @property
    def is_running(self) -> bool:
        process = self._process
        return process is not None and process.poll() is None

    def start(self) -> None:
        if self._closed:
            raise LSPServerTerminated("LSP session is closed", stderr_tail=self._stderr())
        if self.is_running:
            return
        popen_kwargs: dict[str, Any] = {
            "cwd": str(self._workspace_root),
            "stdin": subprocess.PIPE,
            "stdout": subprocess.PIPE,
            "stderr": subprocess.PIPE,
        }
        if os.name == "nt":
            popen_kwargs["creationflags"] = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
        else:
            popen_kwargs["start_new_session"] = True
        try:
            process = subprocess.Popen(self._command, **popen_kwargs)
        except OSError as error:
            raise LSPServerTerminated("failed to start LSP process") from error
        self._process = process
        if os.name != "nt":
            self._process_group_id = int(process.pid)
        if process.stdout is not None:
            self._stdout_reader = BoundedBinaryReader(cast(BinaryIO, process.stdout))
        if process.stderr is not None:
            self._stderr_tail = _StderrTail(
                cast(BinaryIO, process.stderr),
                max_chars=self._stderr_tail_chars,
            )
            self._stderr_tail.start()
        if os.name == "nt":
            self._contain_windows_process(process)

    def _contain_windows_process(self, process: subprocess.Popen[Any]) -> None:
        """Put the server in a kill-on-close job. Failures degrade and log; none raise."""
        try:
            self._job_object = WindowsJobObject()
        except Exception as error:  # noqa: BLE001
            self._job_object = None
            log_containment_degraded(task_key="lsp", stage="create", reason=str(error))
            return
        try:
            self._job_object.assign_pid(int(process.pid))
        except Exception as error:  # noqa: BLE001
            self._job_object.close()
            self._job_object = None
            log_containment_degraded(task_key="lsp", stage="assign", reason=str(error))
            return
        if not self._job_object.contains_pid(int(process.pid)):
            # Keep the handle. The assign may well have taken and only the
            # probe been refused; closing a job the server is in would kill
            # it (KILL_ON_JOB_CLOSE) while the log claims it merely runs
            # uncontained. The handle is closed at stop, when a kill is the
            # intent.
            log_containment_degraded(
                task_key="lsp",
                stage="verify",
                reason=f"containment could not be confirmed for pid {process.pid}",
            )

    def request(self, method: str, params: dict[str, Any] | None = None) -> Any:
        with self._lock:
            self.start()
            process = self._require_process()
            request_id = self._next_request_id
            self._next_request_id += 1
            payload = {
                "jsonrpc": "2.0",
                "id": request_id,
                "method": str(method),
                "params": params or {},
            }
            self._write_message(process, payload)
            deadline = time.monotonic() + self._request_timeout_seconds
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    self._stop_process()
                    raise LSPRequestTimeout(f"LSP request timed out: {method}")
                future = self._reader.submit(self._read_message, process)
                try:
                    message = future.result(timeout=remaining)
                except TimeoutError as error:
                    self._stop_process()
                    raise LSPRequestTimeout(f"LSP request timed out: {method}") from error
                except LSPProtocolError:
                    self._stop_process()
                    raise
                if message.get("id") is None and "method" in message:
                    self._record_notification(message)
                    continue
                if "id" in message and "method" in message:
                    error_message = (
                        "LSP client does not implement server request: "
                        f"{message['method']}"
                    )
                    self._write_error_response(
                        process,
                        message["id"],
                        code=-32601,
                        message=error_message,
                    )
                    continue
                break
            if message.get("id") != request_id:
                self._stop_process()
                raise LSPProtocolError("LSP response id did not match the request id")
            if "error" in message:
                raise LSPProtocolError(f"LSP server returned error: {message['error']!r}")
            return message.get("result")

    def notify(self, method: str, params: dict[str, Any] | None = None) -> None:
        with self._lock:
            self.start()
            process = self._require_process()
            payload = {
                "jsonrpc": "2.0",
                "method": str(method),
                "params": params or {},
            }
            self._write_message(process, payload)

    def drain_notifications(self) -> list[dict[str, Any]]:
        with self._notifications_lock:
            notifications = list(self._notifications)
            self._notifications.clear()
        return notifications

    def close(self) -> None:
        if self._closed:
            return
        process = self._process
        if process is not None and process.poll() is None:
            try:
                self.request("shutdown", {})
            except LSPProtocolError:
                pass
        self._closed = True
        self._stop_process()
        self._reader.shutdown(wait=False, cancel_futures=True)

    def _require_process(self) -> subprocess.Popen[bytes]:
        process = self._process
        if process is None or process.stdin is None or process.stdout is None:
            raise LSPServerTerminated("LSP process is not running", stderr_tail=self._stderr())
        if process.poll() is not None:
            raise LSPServerTerminated("LSP process exited", stderr_tail=self._stderr())
        return process

    def _write_message(self, process: subprocess.Popen[bytes], payload: dict[str, Any]) -> None:
        if process.stdin is None:
            raise LSPServerTerminated("LSP stdin is closed", stderr_tail=self._stderr())
        raw = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        try:
            process.stdin.write(f"Content-Length: {len(raw)}\r\n\r\n".encode("ascii"))
            process.stdin.write(raw)
            process.stdin.flush()
        except OSError as error:
            raise LSPServerTerminated(
                "failed to write LSP request", stderr_tail=self._stderr()
            ) from error

    def _write_error_response(
        self,
        process: subprocess.Popen[bytes],
        request_id: object,
        *,
        code: int,
        message: str,
    ) -> None:
        self._write_message(
            process,
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "error": {"code": code, "message": message},
            },
        )

    def _record_notification(self, message: dict[str, Any]) -> None:
        with self._notifications_lock:
            self._notifications.append(dict(message))

    def _read_message(self, process: subprocess.Popen[bytes]) -> dict[str, Any]:
        reader = self._stdout_reader
        if process.stdout is None or reader is None:
            raise LSPServerTerminated("LSP stdout is closed", stderr_tail=self._stderr())
        try:
            headers = _read_lsp_headers(reader)
        except LSPServerTerminated as error:
            raise LSPServerTerminated(str(error), stderr_tail=self._stderr()) from error
        try:
            length = int(headers[_CONTENT_LENGTH])
        except (KeyError, ValueError) as error:
            raise LSPProtocolError("missing or invalid LSP Content-Length header") from error
        if length < 0:
            raise LSPProtocolError("LSP Content-Length header must not be negative")
        if length > self._max_message_bytes:
            raise LSPProtocolError("LSP Content-Length exceeds configured maximum")
        body = reader.read_exact(length)
        if len(body) != length:
            raise LSPServerTerminated("LSP response body ended early", stderr_tail=self._stderr())
        try:
            value = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise LSPProtocolError("LSP response body was not valid JSON") from error
        if not isinstance(value, dict):
            raise LSPProtocolError("LSP response body must be a JSON object")
        return value

    def _stop_process(self) -> None:
        process = self._process
        if process is not None and os.name == "nt":
            if process.poll() is None:
                with suppress(OSError, subprocess.SubprocessError):
                    subprocess.run(
                        ["taskkill", "/T", "/F", "/PID", str(process.pid)],
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL,
                        timeout=5,
                        check=False,
                    )
            if self._job_object is not None:
                self._job_object.close()
                self._job_object = None
        if process is not None and os.name != "nt" and self._process_group_id is not None:
            _terminate_lsp_posix_group(
                process,
                self._process_group_id,
                timeout_seconds=self._close_timeout_seconds,
            )
            self._process_group_id = None
        elif process is not None and process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=self._close_timeout_seconds)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=self._close_timeout_seconds)
        self._close_pipes(process)
        self._stdout_reader = None
        if self._job_object is not None:
            self._job_object.close()
            self._job_object = None

    def _close_pipes(self, process: subprocess.Popen[bytes] | None) -> None:
        if process is None:
            return
        for stream in (process.stdin, process.stdout):
            if stream is None:
                continue
            try:
                stream.close()
            except OSError:
                pass

    def _stderr(self) -> str:
        return self._stderr_tail.tail() if self._stderr_tail is not None else ""
