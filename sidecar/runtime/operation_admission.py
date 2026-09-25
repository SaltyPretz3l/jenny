"""Live application authority check immediately before one model tool dispatch."""

from __future__ import annotations

import itertools
import json
import time
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any, Callable, Iterator

from sidecar.ai.error_codes import CMP_TOOL_EXECUTION_FAILED, CMP_TOOL_POLICY_DENIED
from sidecar.ai.mcp.exceptions import MCPError
from sidecar.protocol import API_VERSION, JSONRPC_VERSION, RUNTIME_OPERATION_METHOD
from sidecar.runtime.execution_context import ExecutionContext
from sidecar.runtime.multiplexer import ApprovalResponseCancelledError
from sidecar.runtime.tool_resource_admission import (
    RuntimeToolResourceRequest,
    acquire_tool_resource,
)

_RPC_IDS = itertools.count(30_000_000)
_MAX_REQUEST_BYTES = 1024 * 1024
_MAX_REQUEST_TOKEN_CHARS = 128
_MAX_OPERATION_TOKEN_CHARS = 256
_CONTROL_CODE_BOUNDARY = 32
_RESULT_FIELDS = frozenset({"schema_version", "status", "operation_id", "error"})
_REQUIRED_RESULT_FIELDS = _RESULT_FIELDS - {"error"}
_ERROR_FIELDS = frozenset({"code", "reason", "message"})


@dataclass(frozen=True, slots=True)
class RuntimeOperationRequest:
    request_id: str
    session_id: str
    execution_context: ExecutionContext
    operation_id: str
    tool_name: str
    arguments: dict[str, Any]
    write_message: Callable[[dict[str, Any]], None] | None
    response_reader_factory: Callable[..., Callable[[float], dict[str, Any]]] | None
    cancel_handle: Any = None
    timeout_seconds: float = 30.0


def _token(value: Any, field: str, limit: int) -> str:
    token = value if isinstance(value, str) else ""
    if not token or len(token) > limit or any(
        ord(char) < _CONTROL_CODE_BOUNDARY for char in token
    ):
        raise MCPError(
            code=CMP_TOOL_EXECUTION_FAILED,
            message=f"runtime operation {field} is invalid",
            retryable=False,
        )
    return token


@contextmanager
def _closing(reader: Callable[[float], dict[str, Any]]) -> Iterator[None]:
    try:
        yield
    finally:
        close = getattr(reader, "close", None)
        if callable(close):
            close()


def _rejection_error(error: Any) -> MCPError:
    payload = error if isinstance(error, dict) else {}
    code = str(payload.get("code") or CMP_TOOL_POLICY_DENIED)
    if not code.startswith("CMP-"):
        code = CMP_TOOL_POLICY_DENIED
    code = code[:128]
    message = str(payload.get("message") or "Application authority rejected the tool operation.")
    return MCPError(code=code, message=message[:500], retryable=False)


def admit_runtime_operation(request: RuntimeOperationRequest) -> None:  # noqa: C901
    """Require a closed granted response correlated to this request and tool call."""

    if not callable(request.write_message) or not callable(request.response_reader_factory):
        raise MCPError(
            code=CMP_TOOL_EXECUTION_FAILED,
            message="runtime operation authority bridge is unavailable",
            retryable=False,
        )
    request_id = _token(request.request_id, "request_id", _MAX_REQUEST_TOKEN_CHARS)
    session_id = _token(request.session_id, "session_id", _MAX_REQUEST_TOKEN_CHARS)
    operation_id = _token(request.operation_id, "operation_id", _MAX_OPERATION_TOKEN_CHARS)
    tool_name = _token(request.tool_name, "tool_name", _MAX_OPERATION_TOKEN_CHARS)
    if not isinstance(request.arguments, dict):
        raise MCPError(
            code=CMP_TOOL_EXECUTION_FAILED,
            message="runtime operation arguments are invalid",
            retryable=False,
        )
    params = {
        "schema_version": 1,
        "request_id": request_id,
        "session_id": session_id,
        "authority_revision": request.execution_context.authority_revision,
        "operation_id": operation_id,
        "phase": "check",
        "tool_name": tool_name,
        "arguments": dict(request.arguments),
    }
    rpc_id = next(_RPC_IDS)
    message = {
        "jsonrpc": JSONRPC_VERSION,
        "api_version": API_VERSION,
        "id": rpc_id,
        "method": RUNTIME_OPERATION_METHOD,
        "params": {**params, "api_version": API_VERSION},
    }
    try:
        encoded_size = len(json.dumps(message, ensure_ascii=False, separators=(",", ":")).encode())
    except (TypeError, ValueError, OverflowError) as error:
        raise MCPError(
            code=CMP_TOOL_EXECUTION_FAILED,
            message="runtime operation request is not JSON serializable",
            retryable=False,
        ) from error
    if encoded_size > _MAX_REQUEST_BYTES:
        raise MCPError(
            code=CMP_TOOL_EXECUTION_FAILED,
            message="runtime operation request exceeds the size limit",
            retryable=False,
        )
    reader = request.response_reader_factory(rpc_id, cancel_handle=request.cancel_handle)
    with _closing(reader):
        request.write_message(message)
        deadline = time.monotonic() + min(max(float(request.timeout_seconds), 0.1), 30.0)
        while True:
            if request.cancel_handle is not None and request.cancel_handle.cancelled:
                raise MCPError(
                    code=CMP_TOOL_EXECUTION_FAILED,
                    message="runtime operation authority check was cancelled",
                    retryable=True,
                )
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise MCPError(
                    code=CMP_TOOL_EXECUTION_FAILED,
                    message="runtime operation authority check timed out",
                    retryable=True,
                )
            try:
                response = reader(remaining)
            except (TimeoutError, ApprovalResponseCancelledError) as error:
                raise MCPError(
                    code=CMP_TOOL_EXECUTION_FAILED,
                    message="runtime operation authority check did not complete",
                    retryable=True,
                ) from error
            if not isinstance(response, dict) or response.get("id") != rpc_id:
                continue
            if isinstance(response.get("error"), dict):
                raise _rejection_error(response["error"].get("data"))
            result = response.get("result")
            if (
                not isinstance(result, dict)
                or not _REQUIRED_RESULT_FIELDS.issubset(result)
                or set(result) - _RESULT_FIELDS
                or result.get("schema_version") != 1
                or result.get("operation_id") != operation_id
                or result.get("status") not in {"granted", "rejected"}
                or (
                    "error" in result
                    and (
                        not isinstance(result["error"], dict)
                        or set(result["error"]) - _ERROR_FIELDS
                        or any(
                            not isinstance(item, str)
                            for item in result["error"].values()
                        )
                    )
                )
            ):
                raise MCPError(
                    code=CMP_TOOL_EXECUTION_FAILED,
                    message="runtime operation authority response is malformed",
                    retryable=False,
                )
            if result["status"] == "rejected":
                raise _rejection_error(result.get("error"))
            return


def build_operation_admission_callback(  # noqa: PLR0913
    *,
    request_id: str,
    session_id: str | None,
    execution_context: ExecutionContext | None,
    write_message: Callable[[dict[str, Any]], None] | None,
    response_reader_factory: Callable[..., Callable[[float], dict[str, Any]]] | None,
    cancel_handle: Any,
    continuation_enabled: bool = False,
) -> Callable[..., dict[str, Any]] | None:
    """Build the runtime-edge callback injected into the AI tool loop."""

    if not isinstance(continuation_enabled, bool):
        raise TypeError("continuation_enabled must be a bool")
    if execution_context is None:
        return None

    def _admit(
        *, operation_id: str, tool_name: str, arguments: dict[str, Any],
        timeout_seconds: float | None = None,
    ) -> dict[str, Any]:
        admit_runtime_operation(RuntimeOperationRequest(
            request_id=request_id,
            session_id=str(session_id or ""),
            execution_context=execution_context,
            operation_id=operation_id,
            tool_name=tool_name,
            arguments=arguments,
            write_message=write_message,
            response_reader_factory=response_reader_factory,
            cancel_handle=cancel_handle,
            timeout_seconds=timeout_seconds or 30.0,
        ))
        return execution_context.to_wire()

    def _acquire_resource(
        *, operation_id: str, tool_name: str, arguments: dict[str, Any],
        timeout_seconds: float | None = None,
    ):
        return acquire_tool_resource(RuntimeToolResourceRequest(
            request_id=request_id,
            session_id=str(session_id or ""),
            authority_revision=execution_context.authority_revision,
            operation_id=operation_id,
            tool_name=tool_name,
            arguments=arguments,
            write_message=write_message,
            response_reader_factory=response_reader_factory,
            continuation_enabled=continuation_enabled,
            cancel_handle=cancel_handle,
            timeout_seconds=timeout_seconds or 30.0,
        ))

    _admit.acquire_resource = _acquire_resource  # type: ignore[attr-defined]
    return _admit


__all__ = [
    "RuntimeOperationRequest", "admit_runtime_operation",
    "build_operation_admission_callback",
]
