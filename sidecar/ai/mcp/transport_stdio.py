"""Stdio MCP transport implementation."""

from __future__ import annotations

import atexit
import json
import logging
import queue
import subprocess
import threading
import time
import weakref
from dataclasses import dataclass, field
from itertools import count
from typing import Any, NoReturn

from sidecar.ai.config import MCPServerConfig
from sidecar.ai.error_codes import CMP_MCP_PROTOCOL_FAILED, CMP_MCP_SERVER_FAILED
from sidecar.ai.mcp.exceptions import MCPError
from sidecar.ai.mcp.transport_base import MCPTransport
from sidecar.ai.mcp.transport_base import raise_if_cancelled as _raise_if_cancelled
from sidecar.ai.mcp.transport_lifecycle import (
    ProcessContainment as MCPProcessContainment,
)
from sidecar.ai.mcp.transport_lifecycle import (
    RequestScopedStderr,
    ToolLifecycleTracker,
)
from sidecar.ai.mcp.transport_lifecycle import (
    validate_stdio_command as _validate_stdio_command,
)
from sidecar.ai.tools.sanitization import sanitize_tool_output
from sidecar.runtime.diagnostics import log_event

logger = logging.getLogger(__name__)
MCP_READER_QUEUE_MAXSIZE = 32
MCP_STDERR_TAIL_MAX_CHARS = 4096
MCP_MAX_STDOUT_LINE_CHARS = 256 * 1024
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
# in lockstep with builtin_server's writer.
OUTPUT_CHUNK_NOTIFICATION_METHOD = "tool/output_chunk"
MCP_PROTOCOL_VERSION = "2025-03-26"
_JENNY_CLIENT_NAME = "jenny"
_JENNY_CLIENT_VERSION = "1"


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


# Live transports tracked by weakref so the atexit handler can close
# any survivor on interpreter shutdown without leaking MCP subprocesses.
_ACTIVE_TRANSPORTS: "set[weakref.ref[StdioMCPTransport]]" = set()
_ACTIVE_TRANSPORTS_LOCK = threading.Lock()
_ACTIVE_PROCESSES: dict[int, tuple[str, subprocess.Popen[str], MCPProcessContainment | None]] = {}
_ACTIVE_PROCESSES_LOCK = threading.Lock()


def _register_active_transport(transport: "StdioMCPTransport") -> None:
    ref = weakref.ref(transport, _discard_active_transport_ref)
    with _ACTIVE_TRANSPORTS_LOCK:
        _ACTIVE_TRANSPORTS.add(ref)


def _discard_active_transport_ref(ref: "weakref.ref[StdioMCPTransport]") -> None:
    with _ACTIVE_TRANSPORTS_LOCK:
        _ACTIVE_TRANSPORTS.discard(ref)


def _unregister_active_transport(transport: "StdioMCPTransport") -> None:
    with _ACTIVE_TRANSPORTS_LOCK:
        dead: list[weakref.ref[StdioMCPTransport]] = []
        for ref in _ACTIVE_TRANSPORTS:
            target = ref()
            if target is None or target is transport:
                dead.append(ref)
        for ref in dead:
            _ACTIVE_TRANSPORTS.discard(ref)


def _register_active_process(
    server_name: str,
    process: subprocess.Popen[str],
    containment: MCPProcessContainment | None = None,
) -> None:
    with _ACTIVE_PROCESSES_LOCK:
        _ACTIVE_PROCESSES[id(process)] = (server_name, process, containment)


def _unregister_active_process(process: subprocess.Popen[str]) -> None:
    with _ACTIVE_PROCESSES_LOCK:
        _ACTIVE_PROCESSES.pop(id(process), None)


def _terminate_process(
    server_name: str,
    process: subprocess.Popen[str],
    containment: MCPProcessContainment | None = None,
) -> None:
    try:
        if process.poll() is not None:
            return
        if containment is not None:
            try:
                containment.terminate(process)
            except Exception as error:  # noqa: BLE001
                logger.error(
                    "mcp.transport_stdio.containment_close_failed server=%s error=%s",
                    server_name,
                    error,
                )
            if process.poll() is not None:
                return
        process.terminate()
        try:
            process.wait(timeout=1.5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=1.5)
    except Exception as error:  # noqa: BLE001
        logger.error("mcp.transport_stdio.process_close_failed server=%s error=%s", server_name, error)


def _close_all_transports_atexit() -> None:
    with _ACTIVE_TRANSPORTS_LOCK:
        refs = list(_ACTIVE_TRANSPORTS)
    for ref in refs:
        transport = ref()
        if transport is None:
            continue
        try:
            transport.close()
        except Exception as error:  # noqa: BLE001 — best-effort at shutdown
            logger.error(
                "mcp.transport_stdio.atexit_close_failed server=%s error=%s",
                getattr(transport, "server_name", "?"),
                error,
            )
    with _ACTIVE_PROCESSES_LOCK:
        processes = list(_ACTIVE_PROCESSES.values())
    for server_name, process, containment in processes:
        _terminate_process(server_name, process, containment)
        _unregister_active_process(process)


atexit.register(_close_all_transports_atexit)


def _request_timeout_from_config(config: MCPServerConfig) -> float:
    return min(max(float(config.request_timeout_seconds), 1.0), 600.0)


def _sanitize_mcp_detail(text: object) -> str:
    return sanitize_tool_output(
        str(text or ""),
        max_chars=MCP_STDERR_TAIL_MAX_CHARS,
        tool_name="mcp_stdio",
    )


def _read_bounded_text_line(stream: Any, *, max_chars: int) -> str:
    """Read one text line without allowing ``TextIOWrapper`` to grow forever."""

    limit = max(1, int(max_chars))
    line = stream.readline(limit + 1)
    if not isinstance(line, str):
        raise RuntimeError("mcp stdio stream returned non-text data")
    if len(line) > limit or (len(line) == limit and not line.endswith("\n")):
        raise RuntimeError("mcp stdio line exceeded its configured limit")
    return line


class StdioMCPTransport(MCPTransport):
    _SENTINEL = object()

    def __init__(
        self,
        config: MCPServerConfig,
        *,
        request_timeout_seconds: float | None = None,
    ) -> None:
        if config.command is None:
            raise MCPError(
                code=CMP_MCP_SERVER_FAILED,
                message=f"stdio transport requires a command for '{config.name}'",
                retryable=False,
            )
        self._config = config
        self._ids = count(1)
        _validate_stdio_command(config)
        self._containment = MCPProcessContainment(config)
        spawn_kwargs = self._containment.popen_kwargs()
        try:
            self._process = subprocess.Popen(
                [config.command, *config.args],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                errors="replace",
                bufsize=1,
                **spawn_kwargs,
            )
        except Exception as error:  # noqa: BLE001
            raise MCPError(
                code=CMP_MCP_SERVER_FAILED,
                message=f"failed to spawn mcp server '{config.name}': {error}",
                retryable=False,
            ) from error
        try:
            self._containment.after_spawn(self._process)
        except Exception as error:  # noqa: BLE001
            self._containment.terminate(self._process)
            self._containment.close()
            raise MCPError(
                code=CMP_MCP_SERVER_FAILED,
                message=f"failed to apply mcp containment for '{config.name}': {error}",
                retryable=False,
            ) from error
        _register_active_process(config.name, self._process, self._containment)
        self._request_timeout_seconds = (
            request_timeout_seconds
            if request_timeout_seconds is not None
            else _request_timeout_from_config(config)
        )
        self._reader_queue: queue.Queue[object] = queue.Queue(maxsize=MCP_READER_QUEUE_MAXSIZE)
        self._reader_error: BaseException | None = None
        self._stderr_error: BaseException | None = None
        self._stderr_evidence = RequestScopedStderr()
        self._closed = threading.Event()
        self._request_lock = threading.Lock()
        self._response_read_lock = threading.Lock()
        self._pending_lock = threading.Lock()
        self._pending_responses: dict[int, queue.Queue[dict[str, Any]]] = {}
        self._pending_output_callbacks: dict[int, Any] = {}
        self._tool_lifecycle = ToolLifecycleTracker()
        self._initialize_lock = threading.Lock()
        self._initialized = False
        self._reader_thread = threading.Thread(
            target=self._pump_stdout,
            name=f"mcp-stdio-{config.name}",
            daemon=True,
        )
        self._stderr_thread = threading.Thread(
            target=self._pump_stderr,
            name=f"mcp-stdio-{config.name}-stderr",
            daemon=True,
        )
        try:
            self._containment.start_cpu_watchdog(logger=logger, process=self._process)
        except Exception as error:  # noqa: BLE001
            logger.warning(
                "mcp.transport_stdio.cpu_watchdog_failed server=%s error=%s",
                config.name,
                error,
            )
        self._reader_thread.start()
        self._stderr_thread.start()
        _register_active_transport(self)

    @property
    def server_name(self) -> str:
        return self._config.name

    def list_tools(self, *, cancel_handle: Any = None) -> list[dict[str, Any]]:
        self._ensure_initialized(cancel_handle=cancel_handle)
        response = self._send_request("tools/list", {}, cancel_handle=cancel_handle)
        result = self._require_result(response, "tools/list")
        tools = result.get("tools")
        if not isinstance(tools, list):
            return []
        return [tool for tool in tools if isinstance(tool, dict)]

    def call_tool(
        self,
        tool_name: str,
        arguments: dict[str, Any],
        *,
        timeout_seconds: float | None = None,
        cancel_handle: Any = None,
        on_output_chunk: Any = None,
    ) -> dict[str, Any]:
        self._ensure_initialized(cancel_handle=cancel_handle)
        response = self._send_request(
            "tools/call",
            {
                "name": tool_name,
                "arguments": arguments,
            },
            timeout_seconds=timeout_seconds,
            cancel_handle=cancel_handle,
            on_output_chunk=on_output_chunk,
        )
        return self._require_result(response, "tools/call")

    def list_resources(
        self,
        *,
        cursor: str | None = None,
        timeout_seconds: float | None = None,
        cancel_handle: Any = None,
    ) -> dict[str, Any]:
        self._ensure_initialized(cancel_handle=cancel_handle)
        params: dict[str, Any] = {}
        if isinstance(cursor, str) and cursor.strip():
            params["cursor"] = cursor.strip()
        response = self._send_request(
            "resources/list",
            params,
            timeout_seconds=timeout_seconds,
            cancel_handle=cancel_handle,
        )
        return self._require_result(response, "resources/list")

    def read_resource(
        self,
        uri: str,
        *,
        timeout_seconds: float | None = None,
        cancel_handle: Any = None,
    ) -> dict[str, Any]:
        self._ensure_initialized(cancel_handle=cancel_handle)
        response = self._send_request(
            "resources/read",
            {"uri": uri},
            timeout_seconds=timeout_seconds,
            cancel_handle=cancel_handle,
        )
        return self._require_result(response, "resources/read")

    def list_resource_templates(
        self,
        *,
        cursor: str | None = None,
        timeout_seconds: float | None = None,
        cancel_handle: Any = None,
    ) -> dict[str, Any]:
        self._ensure_initialized(cancel_handle=cancel_handle)
        params: dict[str, Any] = {}
        if isinstance(cursor, str) and cursor.strip():
            params["cursor"] = cursor.strip()
        response = self._send_request(
            "resources/templates/list",
            params,
            timeout_seconds=timeout_seconds,
            cancel_handle=cancel_handle,
        )
        return self._require_result(response, "resources/templates/list")

    def _ensure_initialized(self, *, cancel_handle: Any = None) -> None:
        if bool(getattr(self, "_initialized", False)):
            return
        initialize_lock = getattr(self, "_initialize_lock", None)
        if initialize_lock is None:
            initialize_lock = threading.Lock()
            self._initialize_lock = initialize_lock
        with initialize_lock:
            if bool(getattr(self, "_initialized", False)):
                return
            response = self._send_request(
                "initialize",
                {
                    "protocolVersion": MCP_PROTOCOL_VERSION,
                    "clientInfo": {
                        "name": _JENNY_CLIENT_NAME,
                        "version": _JENNY_CLIENT_VERSION,
                    },
                    "capabilities": {},
                },
                cancel_handle=cancel_handle,
            )
            result = self._require_result(response, "initialize")
            if not str(result.get("protocolVersion") or "").strip():
                raise MCPError(
                    code=CMP_MCP_PROTOCOL_FAILED,
                    message=(
                        f"mcp server '{self.server_name}' returned an invalid initialize result"
                    ),
                    retryable=False,
                )
            self._request_lifecycle().configure(result)
            with self._request_lock:
                self._write_line(
                    {
                        "jsonrpc": "2.0",
                        "method": "notifications/initialized",
                        "params": {},
                    }
                )
            self._initialized = True

    def _require_result(self, response: dict[str, Any], method: str) -> dict[str, Any]:
        result = response.get("result")
        if not isinstance(result, dict):
            raise MCPError(
                code=CMP_MCP_PROTOCOL_FAILED,
                message=f"mcp server '{self.server_name}' returned invalid {method} result",
                retryable=False,
            )
        return result

    def close(self) -> None:
        if self._closed.is_set():
            # Idempotent — the atexit handler may double-call close()
            # after the caller already invoked it explicitly.
            return
        process = self._process
        self._closed.set()
        _unregister_active_transport(self)
        _unregister_active_process(process)
        if process.stdin is not None:
            try:
                process.stdin.close()
            except OSError:
                pass
        containment = getattr(self, "_containment", None)
        _terminate_process(self.server_name, process, containment)
        if containment is not None:
            containment.close()
        if process.stdout is not None:
            try:
                process.stdout.close()
            except OSError:
                pass
        if process.stderr is not None:
            try:
                process.stderr.close()
            except OSError:
                pass
        self._queue_reader_item(self._SENTINEL, retry_until_available=False)
        if self._reader_thread.is_alive():
            self._reader_thread.join(timeout=MCP_THREAD_JOIN_TIMEOUT_SECONDS)
        if self._stderr_thread.is_alive():
            self._stderr_thread.join(timeout=MCP_THREAD_JOIN_TIMEOUT_SECONDS)

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
                )
            if lock.acquire(
                timeout=min(MCP_REQUEST_LOCK_POLL_SECONDS, remaining_seconds)
            ):
                return

    def _ensure_request_routing_state(self) -> None:
        if not hasattr(self, "_response_read_lock"):
            self._response_read_lock = threading.Lock()
        if not hasattr(self, "_pending_lock"):
            self._pending_lock = threading.Lock()
        if not hasattr(self, "_pending_responses"):
            self._pending_responses = {}
        if not hasattr(self, "_pending_output_callbacks"):
            self._pending_output_callbacks = {}
        self._request_lifecycle()
        self._request_stderr_evidence()

    def _request_lifecycle(self) -> ToolLifecycleTracker:
        if not hasattr(self, "_tool_lifecycle"):
            self._tool_lifecycle = ToolLifecycleTracker()
        return self._tool_lifecycle

    def _request_stderr_evidence(self) -> RequestScopedStderr:
        if not hasattr(self, "_stderr_evidence"):
            self._stderr_evidence = RequestScopedStderr()
        return self._stderr_evidence

    @property
    def server_generation_id(self) -> str | None:
        return self._request_lifecycle().generation_id

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
        self._ensure_request_routing_state()
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
                self._request_lifecycle().finish(pending.request_id)

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
        response_queue: queue.Queue[dict[str, Any]] = queue.Queue()
        lifecycle = self._request_lifecycle()
        started_event, operation_id = lifecycle.begin(request_id)
        stderr_cursor = self._request_stderr_evidence().cursor()
        try:
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
                self._write_line(payload)
            except BaseException as error:
                with self._pending_lock:
                    self._pending_responses.pop(request_id, None)
                    self._pending_output_callbacks.pop(request_id, None)
                    lifecycle.finish(request_id)
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
        finally:
            self._request_lock.release()
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
            if pending.method != "tools/call" or error.code != CMP_MCP_SERVER_FAILED:
                raise
            lifecycle = self._request_lifecycle()
            raise lifecycle.classify_error(
                error,
                operation_id=lifecycle.operation_id(
                    pending.request_id, pending.operation_id
                ),
                started=pending.started_event.is_set(),
            ) from error
        except _CancelObserved:
            self._notify_cancelled(pending.request_id)
            cancel_deadline = min(
                pending.deadline,
                time.monotonic() + MCP_CANCEL_GRACE_SECONDS,
            )
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
                _raise_if_cancelled(
                    pending.cancel_handle,
                    message="MCP stdio request cancelled",
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
        # A request timeout is local while another request is still pending.
        # Killing the shared stdio server here would turn one caller's shorter
        # deadline into a failure for every concurrent turn. Serialize the
        # final check with dispatch so a new request cannot race between the
        # pending-set observation and process termination.
        with self._request_lock:
            with self._pending_lock:
                has_other_pending = any(
                    pending_id != request_id for pending_id in self._pending_responses
                )
            if not has_other_pending:
                self._terminate_after_reader_failure("timeout")
        raise MCPError(
            code=CMP_MCP_SERVER_FAILED,
            message=f"mcp server '{self.server_name}' response timed out",
            retryable=True,
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
        if self._request_lifecycle().handle_notification(response):
            return True
        logger.warning(
            "mcp response id mismatch server=%s method=%s expected=%s received=%s",
            self.server_name,
            method,
            request_id,
            response.get("id"),
        )
        return True

    def _write_line(self, payload: dict[str, Any]) -> None:
        if self._process.stdin is None:
            raise MCPError(
                code=CMP_MCP_SERVER_FAILED,
                message=f"mcp server '{self.server_name}' stdin is unavailable",
                retryable=True,
            )
        try:
            self._process.stdin.write(json.dumps(payload, ensure_ascii=False) + "\n")
            self._process.stdin.flush()
        except OSError as error:
            raise MCPError(
                code=CMP_MCP_SERVER_FAILED,
                message=f"failed to write mcp request for '{self.server_name}': {error}",
                retryable=True,
            ) from error

    def _pump_stdout(self) -> None:
        if self._process.stdout is None:
            self._set_reader_error(RuntimeError("stdout is unavailable"))
            self._queue_reader_item(self._SENTINEL)
            return
        while True:
            try:
                line = _read_bounded_text_line(
                    self._process.stdout,
                    max_chars=MCP_MAX_STDOUT_LINE_CHARS,
                )
            except BaseException as error:  # noqa: BLE001
                self._set_reader_error(error)
                self._terminate_after_reader_failure("stdout")
                self._queue_reader_item(self._SENTINEL)
                return
            if not line:
                self._queue_reader_item(self._SENTINEL)
                return
            if not self._queue_reader_item(line, retry_until_available=False):
                self._set_reader_error(
                    RuntimeError(
                        f"mcp server '{self.server_name}' stdout queue overflowed while reading responses"
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

    def _read_response_line(
        self,
        *,
        deadline: float,
        cancel_handle: Any = None,
        should_stop: Any = None,
        stderr_cursor: int | None = None,
    ) -> dict[str, Any]:
        while True:
            _raise_if_cancelled(cancel_handle, message="MCP stdio request cancelled")
            if should_stop is not None and should_stop():
                raise _CancelObserved()
            remaining_seconds = max(0.0, deadline - time.monotonic())
            if remaining_seconds <= 0:
                raise _ResponseTimeout()
            try:
                item = self._reader_queue.get(timeout=min(0.1, remaining_seconds))
                break
            except queue.Empty:
                continue

        if item is self._SENTINEL:
            message = f"mcp server '{self.server_name}' closed its pipe unexpectedly"
            if self._reader_error is not None:
                message = f"{message}: {_sanitize_mcp_detail(self._reader_error)}"
            elif self._stderr_error is not None:
                message = f"{message}: {_sanitize_mcp_detail(self._stderr_error)}"
            scoped_cursor = (
                getattr(self, "_active_stderr_cursor", 0)
                if stderr_cursor is None
                else stderr_cursor
            )
            stderr_text = self._request_stderr_evidence().since(scoped_cursor)
            if stderr_text:
                message = f"{message}: {stderr_text}"
            raise MCPError(
                code=CMP_MCP_SERVER_FAILED,
                message=message,
                retryable=True,
            )
        if not isinstance(item, str):
            raise MCPError(
                code=CMP_MCP_PROTOCOL_FAILED,
                message=f"mcp server '{self.server_name}' returned non-text response",
                retryable=False,
            )

        line = item
        try:
            data = json.loads(line)
        except json.JSONDecodeError as error:
            raise MCPError(
                code=CMP_MCP_PROTOCOL_FAILED,
                message=f"mcp server '{self.server_name}' returned invalid json: {error}",
                retryable=False,
            ) from error
        if not isinstance(data, dict):
            raise MCPError(
                code=CMP_MCP_PROTOCOL_FAILED,
                message=f"mcp server '{self.server_name}' returned non-object response",
                retryable=False,
            )
        return data

    def _notify_cancelled(self, request_id: Any) -> None:
        try:
            with self._request_lock:
                self._write_line(
                    {
                        "jsonrpc": "2.0",
                        "method": CANCEL_NOTIFICATION_METHOD,
                        "params": {"requestId": request_id, "reason": "turn_cancelled"},
                    }
                )
        except MCPError:
            # Pipe already dead — the read loop surfaces the failure and the
            # cooperative path converts it into a cancellation outcome.
            logger.warning(
                "mcp cancel notification write failed server=%s", self.server_name
            )

    def _append_stderr_tail(self, line: str) -> None:
        self._request_stderr_evidence().append(line)

    def _set_reader_error(self, error: BaseException) -> None:
        if self._reader_error is None:
            self._reader_error = error

    def _terminate_after_reader_failure(self, reason: str) -> None:
        log_event(
            logger,
            logging.WARNING,
            component="ai.mcp.transport_stdio",
            event="ai.mcp.transport_stdio.stream_bounded",
            message="MCP stdio transport was terminated after a bounded read failure.",
            status="failure",
            data={"reason": reason, "server": self.server_name},
        )
        _terminate_process(self.server_name, self._process, self._containment)

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

    def _raise_for_error(self, response: dict[str, Any]) -> None:
        error = response.get("error")
        if not isinstance(error, dict):
            return
        message = _sanitize_mcp_detail(error.get("message") or "mcp server returned an error")
        error_code = CMP_MCP_SERVER_FAILED
        data = error.get("data")
        retryable = False
        if isinstance(data, dict) and isinstance(data.get("code"), str):
            error_code = str(data["code"])
        if isinstance(data, dict):
            retryable = data.get("retryable") is True
        logger.warning("mcp call failed on server=%s message=%s", self.server_name, message)
        raise MCPError(
            code=error_code,
            message=message,
            retryable=retryable,
            operation_id=data.get("operation_id") if isinstance(data, dict) else None,
            generation_id=data.get("generation_id") if isinstance(data, dict) else None,
            completion_status=(
                str(data.get("completion_status") or "unknown")
                if isinstance(data, dict)
                else "unknown"
            ),
        )
