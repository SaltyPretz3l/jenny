"""Versioned one-shot MCP inspection request dispatch."""

from __future__ import annotations

import threading
from typing import Any

from sidecar.ai.error_codes import CMP_PROTO_VERSION_MISMATCH
from sidecar.ai.mcp.inspection import inspect_server
from sidecar.protocol import MCP_INSPECT_METHOD
from sidecar.runtime.multiplexer import TurnCancellationHandle
from sidecar.runtime.outcomes import ProcessOutcome
from sidecar.runtime.rpc import result_response, validate_method_version

_INSPECTION_LOCK = threading.Lock()
_INSPECTION_CANCEL_HANDLES: dict[Any, TurnCancellationHandle] = {}
JSONRPC_CANCEL_REQUEST_METHOD = "$/cancelRequest"


def prepare_mcp_inspection(message_id: Any) -> tuple[TurnCancellationHandle, bool]:
    with _INSPECTION_LOCK:
        existing = _INSPECTION_CANCEL_HANDLES.get(message_id)
        if existing is not None:
            return existing, False
        handle = TurnCancellationHandle(request_id=str(message_id))
        _INSPECTION_CANCEL_HANDLES[message_id] = handle
    return handle, True


def complete_mcp_inspection(message_id: Any, handle: TurnCancellationHandle) -> None:
    with _INSPECTION_LOCK:
        if _INSPECTION_CANCEL_HANDLES.get(message_id) is handle:
            _INSPECTION_CANCEL_HANDLES.pop(message_id, None)


def cancel_mcp_inspection(message_id: Any, *, reason: str = "sidecar_cancel") -> bool:
    with _INSPECTION_LOCK:
        handle = _INSPECTION_CANCEL_HANDLES.get(message_id)
    return handle.cancel(reason=reason) if handle is not None else False


def cancel_all_mcp_inspections(*, reason: str = "sidecar_shutdown") -> int:
    with _INSPECTION_LOCK:
        handles = list(_INSPECTION_CANCEL_HANDLES.values())
    return sum(handle.cancel(reason=reason) for handle in handles)


def process_mcp_cancel_notification(message: dict[str, Any]) -> bool:
    if message.get("method") != JSONRPC_CANCEL_REQUEST_METHOD:
        return False
    params = message.get("params")
    if isinstance(params, dict):
        cancel_mcp_inspection(params.get("id"))
    return True


def process_mcp_method(  # noqa: PLR0913 - matches the shared dispatcher seam
    method: str,
    message_id: Any,
    params: Any,
    initialized: bool,
    brain_container: Any,
    logger: Any,
) -> ProcessOutcome | None:
    del logger
    if method != MCP_INSPECT_METHOD:
        return None
    with _INSPECTION_LOCK:
        cancel_handle = _INSPECTION_CANCEL_HANDLES.get(message_id)
    if cancel_handle is None:
        cancel_handle, _created = prepare_mcp_inspection(message_id)
    try:
        version_error = validate_method_version(
            method=method,
            message_id=message_id,
            params=params,
            invalid_params_code=-32602,
            version_mismatch_code=CMP_PROTO_VERSION_MISMATCH,
        )
        if version_error is not None:
            return ProcessOutcome(initialized, False, version_error, [])
        if message_id is None:
            return ProcessOutcome(initialized, False, None, [])
        runtime_config = brain_container.stack.config
        result = inspect_server(
            params,
            allow_private_addresses=bool(
                getattr(runtime_config, "tools_web_allow_private_addresses", False)
            ),
            cancel_handle=cancel_handle,
        )
        return ProcessOutcome(initialized, False, result_response(message_id, result), [])
    finally:
        complete_mcp_inspection(message_id, cancel_handle)
