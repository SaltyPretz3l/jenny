"""First-party MCP call certainty and request-scoped stderr evidence."""

from __future__ import annotations

import threading
import uuid
from typing import Any

from sidecar.ai.mcp.exceptions import MCPError
from sidecar.ai.mcp.process_containment import (
    MCPProcessContainment as _MCPProcessContainment,
)
from sidecar.ai.mcp.transport_command_policy import (
    validate_stdio_command as _validate_stdio_command,
)
from sidecar.ai.tools.sanitization import sanitize_tool_output

TOOL_STARTED_NOTIFICATION_METHOD = "tool/started"
MCP_STDERR_TAIL_MAX_CHARS = 4096
ProcessContainment = _MCPProcessContainment


def validate_stdio_command(config: Any) -> None:
    _validate_stdio_command(config)


def sanitize_mcp_detail(text: object) -> str:
    return sanitize_tool_output(
        str(text or ""),
        max_chars=MCP_STDERR_TAIL_MAX_CHARS,
        tool_name="mcp_stdio",
    )


class ToolLifecycleTracker:
    def __init__(self) -> None:
        self.started_supported = False
        self.generation_id: str | None = None
        self._events: dict[int, threading.Event] = {}
        self._operation_ids: dict[int, str] = {}

    def configure(self, initialize_result: dict[str, object]) -> None:
        capabilities = initialize_result.get("capabilities")
        experimental = (
            capabilities.get("experimental") if isinstance(capabilities, dict) else None
        )
        lifecycle = (
            experimental.get("jenny_tool_lifecycle")
            if isinstance(experimental, dict)
            else None
        )
        self.started_supported = bool(
            isinstance(lifecycle, dict)
            and lifecycle.get("started_notification") == TOOL_STARTED_NOTIFICATION_METHOD
        )
        generation = initialize_result.get("generationId")
        self.generation_id = (
            generation.strip()
            if isinstance(generation, str) and generation.strip()
            else None
        )

    def begin(self, request_id: int) -> tuple[threading.Event, str]:
        event = threading.Event()
        operation_id = f"op_{uuid.uuid4().hex}"
        self._events[request_id] = event
        self._operation_ids[request_id] = operation_id
        return event, operation_id

    def finish(self, request_id: int) -> None:
        self._events.pop(request_id, None)
        self._operation_ids.pop(request_id, None)

    def operation_id(self, request_id: int, fallback: str) -> str:
        return self._operation_ids.get(request_id, fallback)

    def handle_notification(self, response: dict[str, object]) -> bool:
        if "id" in response or response.get("method") != TOOL_STARTED_NOTIFICATION_METHOD:
            return False
        params = response.get("params")
        request_id = params.get("request_id") if isinstance(params, dict) else None
        operation_id = params.get("operation_id") if isinstance(params, dict) else None
        generation_id = params.get("generation_id") if isinstance(params, dict) else None
        if isinstance(request_id, int):
            event = self._events.get(request_id)
            if isinstance(operation_id, str) and operation_id.strip():
                self._operation_ids[request_id] = operation_id.strip()
            if event is not None:
                event.set()
        if isinstance(generation_id, str) and generation_id.strip():
            self.generation_id = generation_id.strip()
        return True

    def classify_error(
        self,
        error: MCPError,
        *,
        operation_id: str,
        started: bool,
    ) -> MCPError:
        status = "unknown"
        if self.started_supported:
            status = "started_response_lost" if started else "not_started"
        return MCPError(
            code=error.code,
            message=error.message,
            retryable=error.retryable,
            operation_id=operation_id,
            generation_id=self.generation_id,
            completion_status=status,
        )


class RequestScopedStderr:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._tail = ""
        self._offset = 0

    def append(self, line: str) -> None:
        with self._lock:
            self._tail = f"{self._tail}{line}"
            self._offset += len(line)
            if len(self._tail) > MCP_STDERR_TAIL_MAX_CHARS:
                self._tail = self._tail[-MCP_STDERR_TAIL_MAX_CHARS:]

    def cursor(self) -> int:
        with self._lock:
            return self._offset

    def since(self, cursor: int) -> str:
        with self._lock:
            tail_start = max(0, self._offset - len(self._tail))
            index = max(0, min(len(self._tail), cursor - tail_start))
            return sanitize_mcp_detail(self._tail[index:].strip())
