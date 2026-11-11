"""grep_search's regex worker client: one child process on dedicated stdio pipes.

The model's regex runs only in that child. Each response has its own timeout and
a timeout kills the child, so a pathological pattern never stalls the sidecar.
"""

from __future__ import annotations

import contextlib
import json
import queue
import re
import subprocess
import sys
import threading
from concurrent.futures import TimeoutError as FutureTimeoutError
from pathlib import Path
from typing import IO, Callable, Sequence

from sidecar.ai.error_codes import CMP_TOOL_IO_FAILED
from sidecar.ai.tools.builtins.grep_search_file import FileSearchResult
from sidecar.ai.tools.builtins.grep_search_file import (
    search_result_from_response as _response_to_search_result,
)
from sidecar.ai.tools.builtins.grep_search_worker import (
    WORKER_PROTOCOL_MAX_LINE_CHARS,
    WORKER_READY_MESSAGE,
)
from sidecar.ai.tools.builtins.grep_search_worker import (
    encode_worker_message as _encode_worker_message,
)
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.ai.tools.hosted_file_io import hosted_file_io_enabled

REGEX_SEARCH_TIMEOUT_SECONDS = 5.0
REGEX_WORKER_STARTUP_TIMEOUT_SECONDS = 15.0
_WORKER_JOIN_TIMEOUT_SECONDS = 0.2

_GREP_WORKER_FLAG = "--grep-search-worker"
_WORKER_STDERR_MAX_CHARS = 2000
_WORKER_EOF = object()


def _grep_worker_command() -> list[str]:
    if getattr(sys, "frozen", False):
        return [sys.executable, _GREP_WORKER_FLAG]
    return [sys.executable, "-m", "sidecar", _GREP_WORKER_FLAG]


class _WorkerUnavailable(ToolExecutionFailure):
    """The regex worker itself failed (start, pipes, exit); never one file's error."""


class _RegexSearchWorker:
    """Persistent regex worker with dedicated, non-MCP stdio pipes.

    Python's Windows ``multiprocessing`` bootstrap can deadlock before the target
    is entered when another thread is blocked reading the parent's stdin pipe.
    The builtin MCP server necessarily has exactly such a thread so cancellation
    notifications can interrupt a running tool. An explicit subprocess gives the
    regex worker its own stdin/stdout pair, avoids that inherited-stream bootstrap,
    and still preserves the hard kill boundary required for pathological regexes.
    """

    def __init__(
        self,
        *,
        popen_factory: Callable[..., subprocess.Popen[str]] | None = None,
        command_factory: Callable[[], Sequence[str]] | None = None,
    ) -> None:
        self._popen_factory = popen_factory or subprocess.Popen
        self._command_factory = command_factory or _grep_worker_command
        self._process: subprocess.Popen[str] | None = None
        self._responses: queue.Queue[object] | None = None
        self._stderr_tail = ""
        self._stderr_lock = threading.Lock()
        self._outstanding = 0
        # False from spawn until the readiness line arrives.
        self._ready = False

    def prestart(self) -> None:
        """Spawn the worker now so its start overlaps other work.

        Readiness is awaited on first use; a spawn failure here is retried
        and reported there, so a search that never needs the worker is unaffected.
        """
        if self._process is None:
            with contextlib.suppress(ToolExecutionFailure):
                self._spawn()

    def search(  # noqa: PLR0913 - one request's fields, all keyword-only
        self,
        *,
        path: Path,
        compiled: re.Pattern[str],
        workspace_root: Path | None,
        context_lines: int,
        max_output_matches: int,
        max_output_bytes: int,
        timeout_seconds: float,
    ) -> FileSearchResult:
        return self.request(
            {
                "path": str(path),
                "pattern": compiled.pattern,
                "flags": int(compiled.flags),
                "workspace_root": str(workspace_root) if workspace_root is not None else "",
                "hosted_file_io": hosted_file_io_enabled(),
                "context_lines": context_lines,
                "max_output_matches": max_output_matches,
                "max_output_bytes": max_output_bytes,
            },
            timeout_seconds,
        )

    def request(self, request: dict[str, object], timeout_seconds: float) -> FileSearchResult:
        """Send one search request (a file path, or a ``lines`` chunk) to the worker."""

        self.send(request)
        return _response_to_search_result(self.receive(timeout_seconds))

    def send(self, request: dict[str, object], *, expected_responses: int = 1) -> None:
        """Write one request; ``receive`` then reads its ``expected_responses`` answers."""

        self._ensure_started()
        process = self._process
        if process is None or process.stdin is None or self._responses is None:
            raise _WorkerUnavailable(
                code=CMP_TOOL_IO_FAILED,
                message="grep worker failed to start",
                retryable=True,
            )
        try:
            process.stdin.write(_encode_worker_message(request))
            process.stdin.flush()
        except (BrokenPipeError, OSError, ValueError) as error:
            self._reset(force=True)
            raise _WorkerUnavailable(
                code=CMP_TOOL_IO_FAILED,
                message=f"grep worker communication failed: {error}",
                retryable=True,
            ) from error
        self._outstanding += expected_responses

    def receive(self, timeout_seconds: float) -> object:
        """The next raw response; a timeout kills the worker and raises FutureTimeoutError."""

        process = self._process
        response = self._wait_for_response(timeout_seconds)
        if response is _WORKER_EOF or process is None:
            detail = self._bounded_stderr_detail()
            self._reset(force=True)
            suffix = f": {detail}" if detail else ""
            raise _WorkerUnavailable(
                code=CMP_TOOL_IO_FAILED,
                message=f"grep worker exited unexpectedly{suffix}",
                retryable=True,
            )
        if response is None:
            alive = process.poll() is None
            self._reset(force=True)
            if not alive:
                raise _WorkerUnavailable(
                    code=CMP_TOOL_IO_FAILED,
                    message="grep worker exited unexpectedly",
                    retryable=True,
                )
            raise FutureTimeoutError()
        self._outstanding = max(0, self._outstanding - 1)
        return response

    def abandon_pending(self) -> None:
        """Discard a worker that still owes answers to an abandoned batch.

        Requests are answered in order, so the next one would read a stale answer;
        the next send starts a fresh worker instead.
        """
        if self._outstanding:
            self._reset(force=True)

    def close(self) -> None:
        process = self._process
        if process is not None and not self._ready:
            process.kill()  # pre-started and never used: nothing to stop cleanly
        # A worker still answering an abandoned batch would not read the stop message.
        self._reset(force=self._outstanding > 0 or not self._ready)

    def _ensure_started(self) -> None:
        if self._process is None or self._process.poll() is not None:
            self._reset(force=True)  # also clears _ready
            self._spawn()
        if not self._ready:
            self._await_ready()

    def _spawn(self) -> None:
        try:
            process = self._popen_factory(
                list(self._command_factory()),
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                errors="replace",
                bufsize=1,
            )
        except (OSError, ValueError) as error:
            raise _WorkerUnavailable(
                code=CMP_TOOL_IO_FAILED,
                message=f"grep worker failed to start: {error}",
                retryable=True,
            ) from error
        if process.stdin is None or process.stdout is None or process.stderr is None:
            process.kill()
            process.wait(timeout=_WORKER_JOIN_TIMEOUT_SECONDS)
            raise _WorkerUnavailable(
                code=CMP_TOOL_IO_FAILED,
                message="grep worker failed to create dedicated protocol pipes",
                retryable=True,
            )

        self._process = process
        self._responses = queue.Queue()
        self._stderr_tail = ""
        threading.Thread(
            target=self._pump_stdout,
            args=(process.stdout, self._responses),
            name="grep-worker-stdout",
            daemon=True,
        ).start()
        threading.Thread(
            target=self._pump_stderr,
            args=(process.stderr,),
            name="grep-worker-stderr",
            daemon=True,
        ).start()

    def _await_ready(self) -> None:
        process = self._process
        if process is None:
            raise _WorkerUnavailable(
                code=CMP_TOOL_IO_FAILED, message="grep worker failed to start", retryable=True
            )
        ready_message = self._wait_for_response(REGEX_WORKER_STARTUP_TIMEOUT_SECONDS)
        if ready_message is None:
            message = (
                "grep worker exited during startup"
                if process.poll() is not None
                else "grep worker startup timed out"
            )
            self._reset(force=True)
            raise _WorkerUnavailable(
                code=CMP_TOOL_IO_FAILED,
                message=message,
                retryable=True,
            )
        if ready_message is _WORKER_EOF:
            detail = self._bounded_stderr_detail()
            self._reset(force=True)
            suffix = f": {detail}" if detail else ""
            raise _WorkerUnavailable(
                code=CMP_TOOL_IO_FAILED,
                message=f"grep worker exited during startup{suffix}",
                retryable=True,
            )
        if ready_message != WORKER_READY_MESSAGE:
            self._reset(force=True)
            raise _WorkerUnavailable(
                code=CMP_TOOL_IO_FAILED,
                message="grep worker returned an invalid readiness response",
                retryable=True,
            )
        self._ready = True

    def _wait_for_response(self, timeout_seconds: float) -> object | None:
        responses = self._responses
        if responses is None:
            return _WORKER_EOF
        try:
            return responses.get(timeout=max(0.0, float(timeout_seconds)))
        except queue.Empty:
            return None

    def _pump_stdout(self, stream: IO[str], responses: queue.Queue[object]) -> None:
        try:
            while True:
                line = stream.readline(WORKER_PROTOCOL_MAX_LINE_CHARS + 1)
                if not line:
                    break
                if len(line) > WORKER_PROTOCOL_MAX_LINE_CHARS or not line.endswith("\n"):
                    responses.put({
                        "status": "error",
                        "error_code": CMP_TOOL_IO_FAILED,
                        "message": "grep worker response exceeded its protocol limit",
                        "retryable": True,
                    })
                    break
                try:
                    responses.put(json.loads(line))
                except json.JSONDecodeError:
                    responses.put({
                        "status": "error",
                        "error_code": CMP_TOOL_IO_FAILED,
                        "message": "grep worker returned invalid JSON",
                        "retryable": True,
                    })
                    break
        except (OSError, ValueError):
            pass
        finally:
            responses.put(_WORKER_EOF)

    def _pump_stderr(self, stream: IO[str]) -> None:
        try:
            while True:
                chunk = stream.read(512)
                if not chunk:
                    return
                with self._stderr_lock:
                    self._stderr_tail = (self._stderr_tail + chunk)[-_WORKER_STDERR_MAX_CHARS:]
        except (OSError, ValueError):
            return

    def _bounded_stderr_detail(self) -> str:
        with self._stderr_lock:
            return " ".join(self._stderr_tail.strip().split())[-_WORKER_STDERR_MAX_CHARS:]

    def _reset(self, *, force: bool) -> None:
        process = self._process
        self._process = None
        self._responses = None
        self._outstanding = 0
        self._ready = False
        if process is not None:
            _shutdown_worker_process(process, force=force)


def _shutdown_worker_process(process: subprocess.Popen[str], *, force: bool) -> None:
    if not force and process.poll() is None and process.stdin is not None:
        try:
            process.stdin.write(_encode_worker_message(None))
            process.stdin.flush()
        except (BrokenPipeError, OSError, ValueError):
            pass
    _close_worker_stream(process.stdin)
    _reap_worker_process(process)
    _close_worker_stream(process.stdout)
    _close_worker_stream(process.stderr)


def _reap_worker_process(process: subprocess.Popen[str]) -> None:
    if process.poll() is None:
        try:
            process.wait(timeout=_WORKER_JOIN_TIMEOUT_SECONDS)
        except subprocess.TimeoutExpired:
            process.terminate()
    if process.poll() is None:
        try:
            process.wait(timeout=_WORKER_JOIN_TIMEOUT_SECONDS)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()


def _close_worker_stream(stream: IO[str] | None) -> None:
    if stream is None:
        return
    try:
        stream.close()
    except OSError:
        pass

