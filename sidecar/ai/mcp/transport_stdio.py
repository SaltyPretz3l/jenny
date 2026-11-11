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
from itertools import count
from typing import Any

from sidecar.ai.config import MCPServerConfig
from sidecar.ai.mcp.exceptions import (
    CMP_MCP_PROTOCOL_FAILED,
    CMP_MCP_SERVER_FAILED,
    OBSERVED_CHANGES_KEY,
    MCPError,
    failure_log_level,
    mcp_error_data_detail,
)
from sidecar.ai.mcp.transport_base import MCPTransport, StdioPromptsMixin
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
from sidecar.ai.mcp.transport_stdio_channel import (
    CANCEL_NOTIFICATION_METHOD,  # noqa: F401 - stable public re-export.
    MCP_CANCEL_GRACE_SECONDS,  # noqa: F401 - stable public re-export.
    MCP_MAX_STDERR_LINE_CHARS,  # noqa: F401 - stable public re-export.
    MCP_MAX_STDOUT_LINE_CHARS,  # noqa: F401 - builtin cap, kept for importers.
    MCP_QUEUE_PUT_TIMEOUT_SECONDS,  # noqa: F401 - stable public re-export.
    MCP_READER_QUEUE_MAX_BYTES,
    MCP_REQUEST_LOCK_POLL_SECONDS,  # noqa: F401 - stable public re-export.
    MCP_THREAD_JOIN_TIMEOUT_SECONDS,
    OUTPUT_CHUNK_NOTIFICATION_METHOD,  # noqa: F401 - stable public re-export.
    ReaderBudget,
    StdioChannelMixin,
    _CancelObserved,
    _PendingRequest,  # noqa: F401 - stable public re-export.
    _read_bounded_text_line,  # noqa: F401 - stable public re-export.
    _ResponseTimeout,
)
from sidecar.ai.tools.sanitization import redact_error_paths, sanitize_tool_output
from sidecar.runtime import owned_process_tracking
from sidecar.runtime.diagnostics import log_event

logger = logging.getLogger(__name__)
MCP_READER_QUEUE_MAXSIZE = 32
MCP_STDERR_TAIL_MAX_CHARS = 4096
MCP_PROTOCOL_VERSION = "2025-03-26"
_JENNY_CLIENT_NAME = "jenny"
_JENNY_CLIENT_VERSION = "1"


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
    return min(max(float(config.request_timeout_seconds), 1.0), 1800.0)


def _sanitize_mcp_detail(text: object) -> str:
    return sanitize_tool_output(
        str(text or ""),
        max_chars=MCP_STDERR_TAIL_MAX_CHARS,
        tool_name="mcp_stdio",
    )


class StdioMCPTransport(StdioChannelMixin, StdioPromptsMixin, MCPTransport):
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
                [self._containment.spawn_command(), *config.args],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                errors="replace",
                bufsize=1,
                **spawn_kwargs,
            )
        except Exception as error:
            raise MCPError(
                code=CMP_MCP_SERVER_FAILED,
                message=f"failed to spawn mcp server '{config.name}': {error}",
                retryable=False,
            ) from error
        try:
            self._containment.after_spawn(self._process)
        except Exception as error:
            self._containment.terminate(self._process)
            self._containment.close()
            raise MCPError(
                code=CMP_MCP_SERVER_FAILED,
                message=f"failed to apply mcp containment for '{config.name}': {error}",
                retryable=False,
            ) from error
        self._owned_ledger_ticket = owned_process_tracking.record(self._process.pid, "mcp_stdio", handoff_host=config.name == "jenny_local_tools")
        _register_active_process(config.name, self._process, self._containment)
        self._request_timeout_seconds = (
            request_timeout_seconds
            if request_timeout_seconds is not None
            else _request_timeout_from_config(config)
        )
        self._reader_queue: queue.Queue[object] = queue.Queue(maxsize=MCP_READER_QUEUE_MAXSIZE)
        self._reader_budget = ReaderBudget(MCP_READER_QUEUE_MAX_BYTES)
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

    is_terminated = property(lambda self: self._closed.is_set() or self._process.poll() is not None)

    def list_tools(self, *, cancel_handle: Any = None) -> list[dict[str, Any]]:
        self._ensure_initialized(cancel_handle=cancel_handle)
        return self._list_tool_pages(self._send_request, cancel_handle=cancel_handle,
                                     timeout_seconds=self._request_timeout_seconds)

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
        if self._initialized:
            return
        with self._initialize_lock:
            if self._initialized:
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
            self._tool_lifecycle.configure(result)
            with self._request_lock:
                self._write_line(
                    {
                        "jsonrpc": "2.0",
                        "method": "notifications/initialized",
                        "params": {},
                    },
                    cancel_handle=cancel_handle,
                )
            self._initialized = True

    def _require_result(self, response: dict[str, Any], method: str) -> dict[str, Any]:
        result = response.get("result")
        if not isinstance(result, dict):
            raise MCPError(
                code=CMP_MCP_PROTOCOL_FAILED, retryable=False,
                message=f"mcp server '{self.server_name}' returned invalid {method} result",
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
        handed_off = owned_process_tracking.close_transport(
            getattr(self, "_owned_ledger_ticket", None),
            lambda: _terminate_process(self.server_name, process, self._containment),
        )
        self._containment.close()
        # A handed-off host reads EOF, then drains its existing jobs. Closing
        # TextIOWrapper stdout here can block on its reader lock until those
        # jobs finish. The retiring process releases those descriptors at exit.
        pipes = (process.stdin,) if handed_off else (process.stdin, process.stdout, process.stderr)
        for pipe in pipes:
            if pipe is not None:
                try:
                    pipe.close()
                except OSError:
                    pass
        if handed_off:
            return
        self._queue_reader_item(self._SENTINEL, retry_until_available=False)
        if self._reader_thread.is_alive():
            self._reader_thread.join(timeout=MCP_THREAD_JOIN_TIMEOUT_SECONDS)
        if self._stderr_thread.is_alive():
            self._stderr_thread.join(timeout=MCP_THREAD_JOIN_TIMEOUT_SECONDS)

    @property
    def server_generation_id(self) -> str | None:
        return self._tool_lifecycle.generation_id

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
        self._reader_budget.release_item(item)

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
            stderr_text = self._stderr_evidence.since(scoped_cursor)
            if stderr_text:
                message = f"{message}: {stderr_text}"
            # The pipe stays dead: leave the sentinel for every other pending caller.
            self._queue_reader_item(self._SENTINEL, retry_until_available=False)
            raise MCPError(
                code=CMP_MCP_SERVER_FAILED,
                message=message,
                retryable=True,
            )
        if not isinstance(item, str):
            raise MCPError(
                code=CMP_MCP_PROTOCOL_FAILED, retryable=False,
                message=f"mcp server '{self.server_name}' returned non-text response",
            )

        detail = "non-object response"
        try:
            data = json.loads(item)
        except (json.JSONDecodeError, RecursionError) as error:
            data, detail = None, f"invalid json: {type(error).__name__}"
        if not isinstance(data, dict):
            # A stream that carried a non-frame can't be re-framed: end it for every caller.
            self._terminate_after_reader_failure("protocol")
            raise MCPError(code=CMP_MCP_PROTOCOL_FAILED, retryable=True, transport_terminated=True,
                           message=f"mcp server '{self.server_name}' returned {detail}")
        return data

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

    def _raise_for_error(self, response: dict[str, Any]) -> None:
        error = response.get("error")
        if not isinstance(error, dict):
            return
        message = _sanitize_mcp_detail(error.get("message") or "mcp server returned an error")
        error_code = CMP_MCP_SERVER_FAILED
        data = error.get("data")
        if isinstance(data, dict) and isinstance(data.get("code"), str):
            error_code = str(data["code"])
        retryable = isinstance(data, dict) and data.get("retryable") is True
        logged = redact_error_paths(message)  # HB-017: the log never keeps real paths.
        level = failure_log_level(error_code, retryable=retryable)  # a model's own miss is INFO
        logger.log(level, "mcp call failed on server=%s message=%s", self.server_name, logged)
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
            response_received=True,
            resource_cleanup=data.get("resource_cleanup") if isinstance(data, dict) else None,
            detail=_sanitize_mcp_detail(mcp_error_data_detail(data)),
            # Row 34: typed and bounded by MCPError; routing trusts it only
            # from the builtin server.
            observed_changes=data.get(OBSERVED_CHANGES_KEY) if isinstance(data, dict) else None,
        )
