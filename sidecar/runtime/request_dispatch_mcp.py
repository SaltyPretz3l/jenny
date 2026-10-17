"""Versioned MCP inspection and prompt request dispatch."""

from __future__ import annotations

import re
import threading
from typing import Any

from sidecar.ai.error_codes import (
    CMP_MCP_CONFIG_INVALID,
    CMP_MCP_SERVER_FAILED,
    CMP_PROTO_VERSION_MISMATCH,
)
from sidecar.protocol import MCP_INSPECT_METHOD, MCP_PROMPT_GET_METHOD
from sidecar.runtime.chat_models import TerminalChatStateError
from sidecar.runtime.multiplexer import TurnCancellationHandle
from sidecar.runtime.outcomes import ProcessOutcome
from sidecar.runtime.rpc import result_response, validate_method_version

_INSPECTION_LOCK = threading.Lock()
_INSPECTION_CANCEL_HANDLES: dict[Any, TurnCancellationHandle] = {}
JSONRPC_CANCEL_REQUEST_METHOD = "$/cancelRequest"
_JENNY_CODE_RE = re.compile(r"^CMP-[A-Z]+-\d{4}$")


def inspect_server(params: Any, **kwargs: Any) -> dict[str, Any]:
    # Keep the replaceable dispatch seam without loading transports at startup.
    from sidecar.ai.mcp.inspection import inspect_server as inspect

    return inspect(params, **kwargs)


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


def _prompt_params_valid(params: Any) -> bool:
    return (
        isinstance(params, dict)
        and isinstance(params.get("server"), str)
        and isinstance(params.get("name"), str)
        and isinstance(params.get("arguments"), dict)
        and all(isinstance(key, str) and isinstance(value, str)
                for key, value in params["arguments"].items())
    )


def _get_prompt_result(params: Any, brain_container: Any, cancel_handle: Any) -> dict[str, Any]:
    if not _prompt_params_valid(params):
        return {"ok": False, "failure": {"code": CMP_MCP_CONFIG_INVALID,
                                          "reason": "params_invalid"}}
    client = getattr(getattr(brain_container, "stack", None), "mcp_client", None)
    if client is None:
        return {"ok": False, "failure": {"code": CMP_MCP_SERVER_FAILED,
                                          "reason": "mcp_unavailable", "retryable": False}}
    return _fetch_prompt_text(client, params, cancel_handle)


def _fetch_prompt_text(client: Any, params: dict[str, Any], cancel_handle: Any) -> dict[str, Any]:
    from sidecar.ai.mcp.exceptions import MCPError
    from sidecar.ai.mcp.tool_surface import ToolSurfaceError

    try:
        text = client.get_prompt(
            params["server"], params["name"], params["arguments"], cancel_handle=cancel_handle,
        )
        return {"ok": True, "server": params["server"], "name": params["name"],
                "text": text, "chars": len(text)}
    except MCPError as error:
        # A stdio server's error.data.code is copied into MCPError.code verbatim; only a
        # Jenny code may leave the sidecar.
        code = error.code if _JENNY_CODE_RE.fullmatch(str(error.code)) else CMP_MCP_SERVER_FAILED
        return {"ok": False, "failure": {"code": code, "reason": "prompt_failed",
                                          "retryable": error.retryable}}
    except ToolSurfaceError as error:
        return {"ok": False, "failure": {"code": CMP_MCP_SERVER_FAILED, "reason": error.reason,
                                          "retryable": False, "detail": error.log_data()}}
    except TerminalChatStateError:
        return {"ok": False, "failure": {"code": CMP_MCP_SERVER_FAILED,
                                          "reason": "prompt_cancelled", "retryable": True}}
    except Exception as error:  # noqa: BLE001
        return {"ok": False, "failure": {"code": CMP_MCP_SERVER_FAILED,
                                          "reason": type(error).__name__[:64]}}


def process_mcp_method(  # noqa: PLR0913 - matches the shared dispatcher seam
    method: str,
    message_id: Any,
    params: Any,
    initialized: bool,
    brain_container: Any,
    logger: Any,
) -> ProcessOutcome | None:
    del logger
    if method not in {MCP_INSPECT_METHOD, MCP_PROMPT_GET_METHOD}:
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
        if method == MCP_PROMPT_GET_METHOD:
            result = _get_prompt_result(params, brain_container, cancel_handle)
        else:
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
