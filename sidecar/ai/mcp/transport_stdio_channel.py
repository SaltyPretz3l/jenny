"""Stdio MCP transport request channel: line writes, pipe pumps and request correlation.

Split from ``transport_stdio.py`` (at the 1015-line hard cap, row 105). ``StdioMCPTransport``
mixes this in and still owns spawn, containment, close/termination, the response-line
parser and server error mapping.
"""

from __future__ import annotations

import json
import logging
import queue
import subprocess
import threading
import time
from dataclasses import dataclass, field
from itertools import count
from typing import TYPE_CHECKING, Any, NoReturn

from sidecar.ai.mcp import transport_stdio_reader as _reader
from sidecar.ai.mcp.exceptions import CMP_MCP_PROTOCOL_FAILED, CMP_MCP_SERVER_FAILED, MCPError
from sidecar.ai.mcp.transport_base import raise_cancelled_keeping_reply
from sidecar.ai.mcp.transport_base import raise_if_cancelled as _raise_if_cancelled
from sidecar.ai.mcp.transport_lifecycle import RequestScopedStderr, ToolLifecycleTracker
from sidecar.runtime.chat_models import TerminalChatStateError

# Records keep the transport's logger name (this code moved out of transport_stdio).
logger = logging.getLogger("sidecar.ai.mcp.transport_stdio")

# Builtin cap, kept for importers.
MCP_MAX_STDOUT_LINE_CHARS = _reader.MCP_MAX_STDOUT_LINE_CHARS_BUILTIN
MCP_READER_QUEUE_MAX_BYTES = _reader.MCP_READER_QUEUE_MAX_BYTES
_read_bounded_text_line = _reader._read_bounded_text_line
ReaderBudget = _reader.ReaderBudget
MCP_MAX_STDERR_LINE_CHARS = 64 * 1024
MCP_QUEUE_PUT_TIMEOUT_SECONDS = 0.05
MCP_REQUEST_LOCK_POLL_SECONDS = 0.05
MCP_THREAD_JOIN_TIMEOUT_SECONDS = 0.2
# Cooperative cancellation: the first-party builtin server aborts its running
# tool (and the tool's owned subprocess tree) when it receives the MCP
# notifications/cancelled for the in-flight request. Third-party servers keep
# the terminate-on-cancel callback — there is no protocol guarantee they honor
# the notification. Grace bounds how long a cancelled turn waits for the
# server's aborted response before escalating to process termination.
CANCEL_NOTIFICATION_METHOD = "notifications/cancelled"
MCP_CANCEL_GRACE_SECONDS = 5.0
# Id-less notification method the first-party builtin server writes to
# stdout while a tools/call is in flight (live run_command output). Must stay
# in lockstep with builtin_server_protocol's writer.
OUTPUT_CHUNK_NOTIFICATION_METHOD = "tool/output_chunk"


def _cancel_observed(cancel_handle: Any) -> bool:
    """Non-raising cancellation probe for the cooperative-cancel read loop."""
    return cancel_handle is not None and bool(getattr(cancel_handle, "cancelled", False))


class _CancelObserved(Exception):
    """Internal: the cooperative read loop saw the turn flip to cancelled."""


class _ResponseTimeout(Exception):
    """Internal: the current request exhausted its response deadline."""


@dataclass(frozen=True, slots=True)
class _PendingRequest:
    request_id: int
    method: str
    response_queue: queue.Queue[dict[str, Any]]
    deadline: float
    cancel_handle: Any
    on_output_chunk: Any
    started_event: threading.Event = field(default_factory=threading.Event)
    operation_id: str = ""
    stderr_cursor: int = 0


class StdioChannelMixin:
    # Host-state declarations for static type-checking only. ``StdioMCPTransport``
    # sets every attribute in ``__init__`` and defines the methods stubbed under
    # TYPE_CHECKING; bare annotations only populate ``__annotations__``, so they
    # have no runtime effect and cannot shadow the host's implementations.
    _SENTINEL: object
    _ids: count[int]
    _process: subprocess.Popen[str]
    _request_timeout_seconds: float
    _reader_queue: queue.Queue[object]
    _reader_budget: ReaderBudget
    _reader_error: BaseException | None
    _stderr_error: BaseException | None
    _stderr_evidence: RequestScopedStderr
    _closed: threading.Event
    _request_lock: threading.Lock
    _response_read_lock: threading.Lock
    _pending_lock: threading.Lock
    _pending_responses: dict[int, queue.Queue[dict[str, Any]]]
    _pending_output_callbacks: dict[int, Any]
    _tool_lifecycle: ToolLifecycleTracker
    _active_stderr_cursor: int

    if TYPE_CHECKING:
        @property
        def server_name(self) -> str: ...

        def _read_response_line(
            self,
            *,
            deadline: float,
            cancel_handle: Any = None,
            should_stop: Any = None,
            stderr_cursor: int | None = None,
        ) -> dict[str, Any]: ...

        def _raise_for_error(self, response: dict[str, Any]) -> None: ...

        def _terminate_after_reader_failure(self, reason: str) -> None: ...

    def _acquire_request_lock(
        self,
        *,
        deadline: float,
        cancel_handle: Any,
    ) -> None:
        self._acquire_lock(
            self._request_lock,
            deadline=deadline,
            cancel_handle=cancel_handle,
            wait_label="dispatch",
        )

    def _acquire_lock(
        self,
        lock: threading.Lock,
        *,
        deadline: float,
        cancel_handle: Any,
        wait_label: str,
    ) -> None:
        while True:
            _raise_if_cancelled(cancel_handle, message="MCP stdio request cancelled")
            remaining_seconds = deadline - time.monotonic()
            if remaining_seconds <= 0:
                raise MCPError(
                    code=CMP_MCP_SERVER_FAILED,
                    message=(
                        f"mcp server '{self.server_name}' request timed out "
                        f"waiting to {wait_label}"
                    ),
                    retryable=True,
                    transport_terminated=False,  # a lock wait never stops the server
                )
            if lock.acquire(
                timeout=min(MCP_REQUEST_LOCK_POLL_SECONDS, remaining_seconds)
            ):
                return

    def _send_request(
        self,
        method: str,
        params: dict[str, Any],
        *,
        timeout_seconds: float | None = None,
        cancel_handle: Any = None,
        on_output_chunk: Any = None,
    ) -> dict[str, Any]:
        request_timeout_seconds = (
            float(timeout_seconds)
            if timeout_seconds is not None
            else self._request_timeout_seconds
        )
        deadline = time.monotonic() + max(0.0, request_timeout_seconds)
        pending = self._dispatch_request(
            method,
            params,
            deadline=deadline,
            cancel_handle=cancel_handle,
            on_output_chunk=on_output_chunk,
        )
        try:
            return self._await_request_result(pending)
        finally:
            with self._pending_lock:
                self._pending_responses.pop(pending.request_id, None)
                self._pending_output_callbacks.pop(pending.request_id, None)
                self._tool_lifecycle.finish(pending.request_id)

    def _dispatch_request(
        self,
        method: str,
        params: dict[str, Any],
        *,
        deadline: float,
        cancel_handle: Any,
        on_output_chunk: Any,
    ) -> _PendingRequest:
        self._acquire_request_lock(deadline=deadline, cancel_handle=cancel_handle)
        request_id = next(self._ids)
        lifecycle = self._tool_lifecycle
        try:
            response_queue: queue.Queue[dict[str, Any]] = queue.Queue()
            started_event, operation_id = lifecycle.begin(request_id)
            stderr_cursor = self._stderr_evidence.cursor()
            _raise_if_cancelled(cancel_handle, message="MCP stdio request cancelled")
            payload = {
                "jsonrpc": "2.0",
                "id": request_id,
                "method": method,
                "params": params,
            }
            with self._pending_lock:
                self._pending_responses[request_id] = response_queue
                if on_output_chunk is not None:
                    self._pending_output_callbacks[request_id] = on_output_chunk
            try:
                self._write_line(payload, deadline=deadline, cancel_handle=cancel_handle)
            except BaseException as error:
                if (
                    isinstance(error, MCPError)
                    and method == "tools/call"
                    and error.code == CMP_MCP_SERVER_FAILED
                ):
                    raise lifecycle.classify_error(
                        error,
                        operation_id=operation_id,
                        started=False,
                    ) from error
                raise
            return _PendingRequest(
                request_id=request_id,
                method=method,
                response_queue=response_queue,
                deadline=deadline,
                cancel_handle=cancel_handle,
                on_output_chunk=on_output_chunk,
                started_event=started_event,
                operation_id=operation_id,
                stderr_cursor=stderr_cursor,
            )
        except BaseException:
            with self._pending_lock:
                self._pending_responses.pop(request_id, None)
                self._pending_output_callbacks.pop(request_id, None)
                lifecycle.finish(request_id)
            raise
        finally:
            self._request_lock.release()

    def _await_request_result(self, pending: _PendingRequest) -> dict[str, Any]:
        try:
            while True:
                response = self._take_next_response(pending, observe_cancel=True)
                if self._handle_out_of_band_response(
                    response,
                    request_id=pending.request_id,
                    method=pending.method,
                    on_output_chunk=pending.on_output_chunk,
                ):
                    continue
                self._raise_for_error(response)
                return response
        except MCPError as error:
            lost = error.code == CMP_MCP_SERVER_FAILED or (
                error.code == CMP_MCP_PROTOCOL_FAILED and error.transport_terminated is True)
            if pending.method != "tools/call" or not lost:
                raise
            lifecycle = self._tool_lifecycle
            raise lifecycle.classify_error(
                error,
                operation_id=lifecycle.operation_id(
                    pending.request_id, pending.operation_id
                ),
                started=pending.started_event.is_set(),
            ) from error
        except (_CancelObserved, TerminalChatStateError):
            self._notify_cancelled(pending.request_id)
            cancel_deadline = min(
                pending.deadline,
                time.monotonic() + MCP_CANCEL_GRACE_SECONDS,
            )
            # A reply that settled the race wins; no reply re-raises the cancellation.
            return self._await_cancel_race_result(
                pending,
                deadline=cancel_deadline,
            )

    def _await_cancel_race_result(
        self,
        pending: _PendingRequest,
        *,
        deadline: float,
    ) -> dict[str, Any]:
        while True:
            try:
                response = self._take_next_response(
                    pending,
                    deadline=deadline,
                    observe_cancel=False,
                )
            except MCPError:
                _raise_if_cancelled(
                    pending.cancel_handle,
                    message="MCP stdio request cancelled",
                )
                raise
            if self._handle_out_of_band_response(
                response,
                request_id=pending.request_id,
                method=pending.method,
                on_output_chunk=pending.on_output_chunk,
            ):
                continue
            if "error" in response:
                raise_cancelled_keeping_reply(
                    pending.cancel_handle, self._raise_for_error, response
                )
            self._raise_for_error(response)
            return response

    def _take_next_response(
        self,
        pending: _PendingRequest,
        *,
        deadline: float | None = None,
        observe_cancel: bool,
    ) -> dict[str, Any]:
        try:
            return pending.response_queue.get_nowait()
        except queue.Empty:
            pass
        read_deadline = pending.deadline if deadline is None else deadline
        cancel_handle = pending.cancel_handle if observe_cancel else None
        self._acquire_lock(
            self._response_read_lock,
            deadline=read_deadline,
            cancel_handle=cancel_handle,
            wait_label="read a response" if observe_cancel else "settle cancellation",
        )
        try:
            try:
                return pending.response_queue.get_nowait()
            except queue.Empty:
                try:
                    if observe_cancel and pending.cancel_handle is not None:
                        def should_stop() -> bool:
                            return _cancel_observed(pending.cancel_handle)

                        self._active_stderr_cursor = pending.stderr_cursor
                        return self._read_response_line(
                            deadline=read_deadline,
                            should_stop=should_stop,
                        )
                    self._active_stderr_cursor = pending.stderr_cursor
                    return self._read_response_line(deadline=read_deadline)
                except _ResponseTimeout:
                    self._raise_response_timeout(pending.request_id)
        finally:
            self._response_read_lock.release()

    def _raise_response_timeout(self, request_id: int) -> NoReturn:
        # A timeout stays local while another request is pending: killing the shared
        # server would fail every concurrent turn. Serialize this check with dispatch
        # so a new request cannot race process termination.
        with self._request_lock:
            with self._pending_lock:
                has_other_pending = any(
                    pending_id != request_id for pending_id in self._pending_responses
                )
            if not has_other_pending:
                self._terminate_after_reader_failure("timeout")
        poll = getattr(self._process, "poll", None)
        raise MCPError(
            code=CMP_MCP_SERVER_FAILED,
            message=f"mcp server '{self.server_name}' response timed out",
            retryable=True,
            transport_terminated=not has_other_pending and callable(poll) and poll() is not None,
        )

    def _handle_out_of_band_response(
        self,
        response: dict[str, Any],
        *,
        request_id: int,
        method: str,
        on_output_chunk: Any,
    ) -> bool:
        if response.get("id") == request_id:
            return False
        response_id = response.get("id")
        if isinstance(response_id, int):
            with self._pending_lock:
                pending_queue = self._pending_responses.get(response_id)
            if pending_queue is not None:
                pending_queue.put(response)
                return True
        # The first-party builtin server may emit id-less live-output
        # notifications while a call is in flight.
        if (
            "id" not in response
            and response.get("method") == OUTPUT_CHUNK_NOTIFICATION_METHOD
        ):
            chunk_params = response.get("params")
            chunk_request_id = (
                chunk_params.get("request_id") if isinstance(chunk_params, dict) else None
            )
            callback = None
            if isinstance(chunk_request_id, int):
                with self._pending_lock:
                    callback = self._pending_output_callbacks.get(chunk_request_id)
            if callback is None and chunk_request_id == request_id:
                callback = on_output_chunk
            if isinstance(chunk_params, dict) and callback is not None:
                try:
                    callback(chunk_params)
                except Exception:  # noqa: BLE001 - tail must not kill the call
                    logger.debug(
                        "tool output chunk handler failed server=%s",
                        self.server_name,
                    )
            return True
        if self._tool_lifecycle.handle_notification(response):
            return True
        logger.warning(
            "mcp response id mismatch server=%s method=%s expected=%s received=%s",
            self.server_name,
            method,
            request_id,
            response.get("id"),
        )
        return True

    def _write_line(self, payload: dict[str, Any], *, deadline: float | None = None,
                    cancel_handle: Any = None) -> None:
        if self._closed.is_set() or self._process.stdin is None:
            raise MCPError(code=CMP_MCP_SERVER_FAILED, retryable=True,
                           message=f"mcp server '{self.server_name}' stdin is unavailable")
        deadline = (
            deadline if deadline is not None else time.monotonic() + self._request_timeout_seconds
        )
        finished = threading.Event()
        errors: list[BaseException] = []
        line = json.dumps(payload, ensure_ascii=False) + "\n"

        def write() -> None:
            try:
                assert self._process.stdin is not None
                self._process.stdin.write(line)
                self._process.stdin.flush()
            except (OSError, ValueError) as error:
                errors.append(error)
            finally:
                finished.set()

        writer = threading.Thread(target=write, name=f"mcp-write-{self.server_name}", daemon=True)
        writer.start()
        try:
            while not finished.wait(timeout=min(0.05, max(0.0, deadline - time.monotonic()))):
                _raise_if_cancelled(cancel_handle)
                if self._closed.is_set() or time.monotonic() >= deadline:
                    raise MCPError(code=CMP_MCP_SERVER_FAILED, retryable=True,
                                   message=f"mcp server '{self.server_name}' write timed out")
            # A finished write leaves the pipe intact: a Stop from here on takes the
            # response wait's cooperative cancel path instead of killing the server.
            if errors:
                raise MCPError(
                    code=CMP_MCP_SERVER_FAILED, retryable=True,
                    message=f"failed to write mcp request for '{self.server_name}'",
                ) from errors[0]
        except BaseException:
            self._terminate_after_reader_failure("stdin")
            writer.join(timeout=MCP_THREAD_JOIN_TIMEOUT_SECONDS)
            raise

    def _pump_stdout(self) -> None:
        if self._process.stdout is None:
            self._set_reader_error(RuntimeError("stdout is unavailable"))
            self._queue_reader_item(self._SENTINEL)
            return
        while True:
            try:
                line = _read_bounded_text_line(
                    self._process.stdout,
                    max_chars=_reader.max_stdout_line_chars(self.server_name),
                )
            except BaseException as error:  # noqa: BLE001
                self._set_reader_error(error)
                self._terminate_after_reader_failure("stdout")
                self._queue_reader_item(self._SENTINEL)
                return
            if not line:
                self._queue_reader_item(self._SENTINEL)
                return
            # Backpressure: wait for consumers to take queued text, never past close.
            cost = self._reader_budget.cost(line)
            while not self._reader_budget.reserve(cost, timeout=MCP_QUEUE_PUT_TIMEOUT_SECONDS):
                if self._closed.is_set():
                    return
            if not self._queue_reader_item(line, retry_until_available=False):
                self._reader_budget.release(cost)
                self._set_reader_error(
                    RuntimeError(
                        f"mcp server '{self.server_name}' stdout queue overflowed "
                        "while reading responses"
                    )
                )
                self._terminate_after_reader_failure("stdout_queue")
                self._queue_reader_item(self._SENTINEL)
                return

    def _pump_stderr(self) -> None:
        if self._process.stderr is None:
            return
        while True:
            try:
                line = _read_bounded_text_line(
                    self._process.stderr,
                    max_chars=MCP_MAX_STDERR_LINE_CHARS,
                )
            except BaseException as error:  # noqa: BLE001
                self._stderr_error = error
                self._terminate_after_reader_failure("stderr")
                return
            if not line:
                return
            self._append_stderr_tail(line)

    def _notify_cancelled(self, request_id: Any) -> None:
        try:
            with self._request_lock:
                self._write_line(
                    {
                        "jsonrpc": "2.0",
                        "method": CANCEL_NOTIFICATION_METHOD,
                        "params": {"requestId": request_id, "reason": "turn_cancelled"},
                    },
                    deadline=time.monotonic() + MCP_CANCEL_GRACE_SECONDS,
                )
        except MCPError:
            # Pipe already dead — the read loop surfaces the failure and the
            # cooperative path converts it into a cancellation outcome.
            logger.warning(
                "mcp cancel notification write failed server=%s", self.server_name
            )

    def _append_stderr_tail(self, line: str) -> None:
        self._stderr_evidence.append(line)

    def _set_reader_error(self, error: BaseException) -> None:
        if self._reader_error is None:
            self._reader_error = error

    def _queue_reader_item(self, item: object, *, retry_until_available: bool = True) -> bool:
        while True:
            try:
                self._reader_queue.put(item, timeout=MCP_QUEUE_PUT_TIMEOUT_SECONDS)
                return True
            except queue.Full:
                if not retry_until_available:
                    return False
                if self._closed.is_set():
                    return False
