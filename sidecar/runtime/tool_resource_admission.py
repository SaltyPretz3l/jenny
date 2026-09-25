"""Application-owned resource admission for one builtin tool dispatch."""

from __future__ import annotations

import itertools
import json
import math
import re
import threading
import time
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any, Callable, Iterator, Mapping

from sidecar.ai.error_codes import CMP_RESOURCE_EXCEEDED, CMP_TOOL_EXECUTION_FAILED
from sidecar.ai.routing.tool_resource_deferral import ToolResourceDeferred, ToolResourceWait
from sidecar.ai.tools.contracts import ToolExecutionFailure
from sidecar.protocol import API_VERSION, JSONRPC_VERSION, RUNTIME_OPERATION_METHOD
from sidecar.runtime.multiplexer import ApprovalResponseCancelledError

_RPC_IDS = itertools.count(50_000_000)
_MAX_REQUEST_BYTES = 1024 * 1024
_MAX_REQUEST_TOKEN_CHARS = 128
_MAX_OPERATION_TOKEN_CHARS = 256
_MAX_REASON_CHARS = 200
_CONTROL_CODE_BOUNDARY = 32
_TOKEN_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]*$")
_WAIT_RESULT_FIELDS = frozenset({"dependency_id", "resource_class"})
_RESULT_FIELDS = frozenset(
    {"schema_version", "operation_id", "status", "reason", *_WAIT_RESULT_FIELDS}
)
_REQUIRED_RESULT_FIELDS = frozenset({"schema_version", "operation_id", "status"})
_ADMIT_TIMEOUT_SECONDS = 30.0
_SETTLE_TIMEOUT_SECONDS = 5.0


def _failure(reason: Any, *, waiting: bool = False) -> ToolExecutionFailure:
    normalized = _reason(reason, "tool_resource_rejected")
    return ToolExecutionFailure(
        code=CMP_RESOURCE_EXCEEDED if waiting else CMP_TOOL_EXECUTION_FAILED,
        message=(
            f"Tool resource capacity is busy: {normalized}"
            if waiting
            else f"Tool resource admission failed: {normalized}"
        ),
        retryable=waiting,
    )


@dataclass(frozen=True, slots=True)
class RuntimeToolResourceRequest:
    request_id: str
    session_id: str
    authority_revision: str
    operation_id: str
    tool_name: str
    arguments: dict[str, Any]
    write_message: Callable[[dict[str, Any]], None] | None
    response_reader_factory: Callable[..., Callable[[float], dict[str, Any]]] | None
    continuation_enabled: bool = False
    cancel_handle: Any = None
    timeout_seconds: float = _ADMIT_TIMEOUT_SECONDS


def _token(value: Any, field: str, limit: int) -> str:
    token = value if isinstance(value, str) else ""
    if (
        not token
        or token != token.strip()
        or len(token) > limit
        or _TOKEN_PATTERN.fullmatch(token) is None
        or any(ord(char) < _CONTROL_CODE_BOUNDARY for char in token)
    ):
        raise _failure(f"tool_resource_{field}_invalid")
    return token


def _reason(value: Any, fallback: str) -> str:
    reason = value if isinstance(value, str) else ""
    return str(reason or fallback)[:_MAX_REASON_CHARS]


def _timeout(value: Any, maximum: float) -> float:
    try:
        timeout = float(value)
    except (TypeError, ValueError, OverflowError) as error:
        raise _failure("tool_resource_timeout_invalid") from error
    if not math.isfinite(timeout):
        raise _failure("tool_resource_timeout_invalid")
    return min(max(timeout, 0.1), maximum)


@contextmanager
def _closing(reader: Callable[[float], dict[str, Any]]) -> Iterator[None]:
    try:
        yield
    finally:
        close = getattr(reader, "close", None)
        if callable(close):
            close()


def _response_error_reason(response: Mapping[str, Any]) -> str | None:
    error = response.get("error")
    if not isinstance(error, Mapping):
        return None
    data = error.get("data")
    if isinstance(data, Mapping):
        return _reason(data.get("reason") or data.get("message"), "tool_resource_rejected")
    return _reason(error.get("message"), "tool_resource_rejected")


def _exchange(  # noqa: C901, PLR0912, PLR0913
    *,
    params: dict[str, Any],
    operation_id: str,
    expected_statuses: frozenset[str],
    write_message: Callable[[dict[str, Any]], None] | None,
    response_reader_factory: Callable[..., Callable[[float], dict[str, Any]]] | None,
    cancel_handle: Any,
    timeout_seconds: float,
    continuation_enabled: bool = False,
) -> dict[str, Any]:
    if not isinstance(continuation_enabled, bool):
        raise _failure("tool_resource_continuation_enabled_invalid")
    if not callable(write_message) or not callable(response_reader_factory):
        raise _failure("tool_resource_authority_bridge_unavailable")
    bounded_timeout = _timeout(timeout_seconds, 30.0)
    rpc_id = next(_RPC_IDS)
    message = {
        "jsonrpc": JSONRPC_VERSION,
        "api_version": API_VERSION,
        "id": rpc_id,
        "method": RUNTIME_OPERATION_METHOD,
        "params": params,
    }
    try:
        encoded_size = len(
            json.dumps(message, ensure_ascii=False, separators=(",", ":")).encode()
        )
    except (TypeError, ValueError, OverflowError) as error:
        raise _failure("tool_resource_request_not_serializable") from error
    if encoded_size > _MAX_REQUEST_BYTES:
        raise _failure("tool_resource_request_too_large")
    try:
        reader = response_reader_factory(rpc_id, cancel_handle=cancel_handle)
    except Exception as error:
        raise _failure(
            "tool_resource_response_bridge_unavailable"
        ) from error
    with _closing(reader):
        try:
            write_message(message)
        except Exception as error:
            raise _failure("tool_resource_request_write_failed") from error
        deadline = time.monotonic() + bounded_timeout
        while True:
            if cancel_handle is not None and bool(getattr(cancel_handle, "cancelled", False)):
                raise _failure("tool_resource_admission_cancelled")
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise _failure("tool_resource_authority_timeout")
            try:
                response = reader(remaining)
            except (TimeoutError, ApprovalResponseCancelledError) as error:
                raise _failure("tool_resource_authority_incomplete") from error
            except Exception as error:
                raise _failure("tool_resource_response_read_failed") from error
            if not isinstance(response, Mapping) or response.get("id") != rpc_id:
                continue
            response_error = _response_error_reason(response)
            if response_error is not None:
                raise _failure(response_error)
            result = response.get("result")
            result_fields = set(result) if isinstance(result, dict) else set()
            wait_fields = result_fields & _WAIT_RESULT_FIELDS
            if (
                not isinstance(result, dict)
                or not _REQUIRED_RESULT_FIELDS.issubset(result)
                or set(result) - _RESULT_FIELDS
                or isinstance(result.get("schema_version"), bool)
                or result.get("schema_version") != 1
                or result.get("operation_id") != operation_id
                or result.get("status") not in expected_statuses
                or (wait_fields and wait_fields != _WAIT_RESULT_FIELDS)
                or (
                    wait_fields == _WAIT_RESULT_FIELDS
                    and (
                        not continuation_enabled
                        or result.get("status") != "waiting"
                        or result.get("dependency_id") is not None
                        or not isinstance(result.get("resource_class"), str)
                    )
                )
                or (
                    "reason" in result
                    and (
                        not isinstance(result["reason"], str)
                        or len(result["reason"]) > _MAX_REASON_CHARS
                    )
                )
            ):
                raise _failure(
                    "tool_resource_authority_response_malformed"
                )
            return result


class RuntimeToolResourceLease:
    """Settle a granted tool resource without inheriting request cancellation."""

    def __init__(
        self,
        *,
        base_params: dict[str, Any],
        operation_id: str,
        write_message: Callable[[dict[str, Any]], None] | None,
        response_reader_factory: Callable[..., Callable[[float], dict[str, Any]]] | None,
    ) -> None:
        self._base_params = dict(base_params)
        self._operation_id = operation_id
        self._write_message = write_message
        self._response_reader_factory = response_reader_factory
        self._lock = threading.Lock()
        self._outcome: tuple[str, str] | None = None

    def settle(self, status: str, cleanup: str) -> None:
        if status not in {"succeeded", "failed", "cancelled"} or cleanup not in {
            "confirmed",
            "uncertain",
        }:
            raise _failure("tool_resource_settlement_invalid")
        with self._lock:
            previous = self._outcome
            if previous == (status, cleanup):
                return
            if previous is not None and not (
                previous == (status, "uncertain") and cleanup == "confirmed"
            ):
                raise _failure("tool_resource_settlement_conflict")
            result = _exchange(
                params={
                    **self._base_params,
                    "phase": "settle",
                    "status": status,
                    "cleanup": cleanup,
                },
                operation_id=self._operation_id,
                expected_statuses=frozenset({"settled", "rejected"}),
                write_message=self._write_message,
                response_reader_factory=self._response_reader_factory,
                cancel_handle=None,
                timeout_seconds=_SETTLE_TIMEOUT_SECONDS,
            )
            if result["status"] == "rejected":
                raise _failure(
                    _reason(result.get("reason"), "tool_resource_settlement_rejected")
                )
            self._outcome = (status, cleanup)


def acquire_tool_resource(request: RuntimeToolResourceRequest) -> RuntimeToolResourceLease:
    """Acquire one application-selected resource bracket for a trusted builtin call."""

    request_id = _token(request.request_id, "request_id", _MAX_REQUEST_TOKEN_CHARS)
    session_id = _token(request.session_id, "session_id", _MAX_REQUEST_TOKEN_CHARS)
    authority_revision = _token(
        request.authority_revision, "authority_revision", _MAX_REQUEST_TOKEN_CHARS
    )
    operation_id = _token(request.operation_id, "operation_id", _MAX_OPERATION_TOKEN_CHARS)
    tool_name = _token(request.tool_name, "tool_name", _MAX_OPERATION_TOKEN_CHARS)
    if not isinstance(request.arguments, dict):
        raise _failure("tool_resource_arguments_invalid")
    if not isinstance(request.continuation_enabled, bool):
        raise _failure("tool_resource_continuation_enabled_invalid")
    base_params = {
        "api_version": API_VERSION,
        "schema_version": 1,
        "kind": "tool",
        "request_id": request_id,
        "session_id": session_id,
        "authority_revision": authority_revision,
        "operation_id": operation_id,
    }
    result = _exchange(
        params={
            **base_params,
            "phase": "admit",
            "tool_name": tool_name,
            "arguments": dict(request.arguments),
        },
        operation_id=operation_id,
        expected_statuses=frozenset({"granted", "waiting", "rejected"}),
        write_message=request.write_message,
        response_reader_factory=request.response_reader_factory,
        cancel_handle=request.cancel_handle,
        timeout_seconds=request.timeout_seconds,
        continuation_enabled=request.continuation_enabled,
    )
    if result["status"] == "waiting":
        if request.continuation_enabled and _WAIT_RESULT_FIELDS.issubset(result):
            try:
                wait = ToolResourceWait(
                    operation_id=operation_id,
                    resource_class=result["resource_class"],
                    dependency_id=result["dependency_id"],
                    reason=result.get("reason"),
                )
            except ValueError as error:
                raise _failure("tool_resource_authority_response_malformed") from error
            raise ToolResourceDeferred(wait)
        raise _failure(
            _reason(result.get("reason"), "tool_resource_capacity_waiting"),
            waiting=True,
        )
    if result["status"] == "rejected":
        raise _failure(
            _reason(result.get("reason"), "tool_resource_capacity_rejected")
        )
    return RuntimeToolResourceLease(
        base_params=base_params,
        operation_id=operation_id,
        write_message=request.write_message,
        response_reader_factory=request.response_reader_factory,
    )


__all__ = [
    "RuntimeToolResourceLease",
    "RuntimeToolResourceRequest",
    "acquire_tool_resource",
]
