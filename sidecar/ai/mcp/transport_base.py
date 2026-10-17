"""Transport contract for MCP server communication."""

from __future__ import annotations

import time
from abc import ABC, abstractmethod
from collections.abc import Callable
from typing import Any, Protocol, cast

from sidecar.ai.error_codes import CMP_MCP_PROTOCOL_FAILED
from sidecar.ai.mcp.exceptions import MCPError
from sidecar.runtime.chat_models import TerminalChatStateError
from sidecar.runtime.turn_state import TURN_STATE_CANCELLED

_MAX_TOOL_PAGES = 32
_MAX_TOOL_CURSOR_CHARS = 4096


def raise_if_cancelled(
    cancel_handle: Any,
    *,
    message: str = "MCP tool call cancelled",
) -> None:
    if cancel_handle is None:
        return
    raise_method = getattr(cancel_handle, "raise_if_cancelled", None)
    if callable(raise_method):
        raise_method()
        return
    if getattr(cancel_handle, "cancelled", False):
        raise TerminalChatStateError(
            status=TURN_STATE_CANCELLED,
            message=message,
        )


def raise_cancelled_keeping_reply(
    cancel_handle: Any,
    raise_for_error: Callable[[dict[str, Any]], Any],
    response: dict[str, Any],
    *,
    message: str = "MCP stdio request cancelled",
) -> None:
    """Raise for a server error reply that arrived while the call was cancelled.

    The cancellation wins, but the reply stays attached as its ``__cause__``:
    for a process-backed tool it carries the server's kill verdict, the only
    proof that lets the caller release the tool's workspace lease (HB-034).
    """
    reply_error: MCPError | None = None
    try:
        raise_for_error(response)
    except MCPError as error:
        reply_error = error
    try:
        raise_if_cancelled(cancel_handle, message=message)
    except TerminalChatStateError as cancelled:
        if reply_error is None:
            raise
        raise cancelled from reply_error
    if reply_error is not None:
        raise reply_error


class MCPTransport(ABC):
    @property
    @abstractmethod
    def server_name(self) -> str:
        raise NotImplementedError

    @abstractmethod
    def list_tools(self, *, cancel_handle: Any = None) -> list[dict[str, Any]]:
        raise NotImplementedError

    @abstractmethod
    def list_prompts(self, *, cancel_handle: Any = None) -> list[dict[str, Any]]:
        raise NotImplementedError

    @abstractmethod
    def get_prompt(
        self,
        name: str,
        arguments: dict[str, str],
        *,
        timeout_seconds: float | None = None,
        cancel_handle: Any = None,
    ) -> dict[str, Any]:
        raise NotImplementedError

    def _list_prompt_pages(self, request: Callable[..., dict[str, Any]], *,
                           cancel_handle: Any, timeout_seconds: float) -> list[dict[str, Any]]:
        return self._list_pages(request, "prompts/list", "prompts",
                                cancel_handle=cancel_handle, timeout_seconds=timeout_seconds)

    def _list_tool_pages(self, request: Callable[..., dict[str, Any]], *,
                         cancel_handle: Any, timeout_seconds: float) -> list[dict[str, Any]]:
        return self._list_pages(request, "tools/list", "tools",
                                cancel_handle=cancel_handle, timeout_seconds=timeout_seconds)

    def _list_pages(self, request: Callable[..., dict[str, Any]], method: str, key: str, *,
                    cancel_handle: Any, timeout_seconds: float) -> list[dict[str, Any]]:
        """Page through a `*/list` method under one deadline, page cap and cursor guards."""
        label = key[:-1]  # "tools" -> "tool", "prompts" -> "prompt"
        deadline = time.monotonic() + timeout_seconds
        rows: list[dict[str, Any]] = []
        params: dict[str, Any] = {}
        cursors: set[str] = set()
        for _page in range(_MAX_TOOL_PAGES):
            raise_if_cancelled(cancel_handle)
            response = request(method, params, cancel_handle=cancel_handle,
                               timeout_seconds=max(0.0, deadline - time.monotonic()))
            result = response.get("result")
            if not isinstance(result, dict):
                raise MCPError(code=CMP_MCP_PROTOCOL_FAILED, retryable=False,
                               message=f"MCP server returned an invalid {method} result")
            page = result.get(key)
            if isinstance(page, list):
                rows.extend(row for row in page if isinstance(row, dict))
            cursor = result.get("nextCursor")
            if cursor is None or cursor == "":
                return rows
            if (not isinstance(cursor, str) or len(cursor) > _MAX_TOOL_CURSOR_CHARS
                    or cursor in cursors):
                break
            cursors.add(cursor)
            params = {"cursor": cursor}
        raise MCPError(code=CMP_MCP_PROTOCOL_FAILED, retryable=False,
                       message=f"MCP {label} pagination exceeded its bounds")

    @abstractmethod
    def call_tool(
        self,
        tool_name: str,
        arguments: dict[str, Any],
        *,
        timeout_seconds: float | None = None,
        cancel_handle: Any = None,
        on_output_chunk: Any = None,
    ) -> dict[str, Any]:
        raise NotImplementedError

    @abstractmethod
    def list_resources(
        self,
        *,
        cursor: str | None = None,
        timeout_seconds: float | None = None,
        cancel_handle: Any = None,
    ) -> dict[str, Any]:
        raise NotImplementedError

    @abstractmethod
    def read_resource(
        self,
        uri: str,
        *,
        timeout_seconds: float | None = None,
        cancel_handle: Any = None,
    ) -> dict[str, Any]:
        raise NotImplementedError

    @abstractmethod
    def list_resource_templates(
        self,
        *,
        cursor: str | None = None,
        timeout_seconds: float | None = None,
        cancel_handle: Any = None,
    ) -> dict[str, Any]:
        raise NotImplementedError

    @abstractmethod
    def close(self) -> None:
        raise NotImplementedError

    @property
    def is_terminated(self) -> bool:
        """True once the transport can no longer carry a request."""
        return False


class _RequestTransport(Protocol):
    """What the stdio prompt mixin needs from its host transport."""

    _request_timeout_seconds: float

    def _ensure_initialized(self, *, cancel_handle: Any = None) -> None: ...

    def _send_request(self, method: str, params: dict[str, Any], *,
                      timeout_seconds: float | None = None,
                      cancel_handle: Any = None) -> dict[str, Any]: ...

    def _require_result(self, response: dict[str, Any], method: str) -> dict[str, Any]: ...

    def _list_prompt_pages(self, request: Any, *, cancel_handle: Any,
                           timeout_seconds: float) -> list[dict[str, Any]]: ...


class StdioPromptsMixin:
    """`prompts/list` and `prompts/get` for a transport with `_send_request`; adds no state."""

    def list_prompts(self, *, cancel_handle: Any = None) -> list[dict[str, Any]]:
        transport = cast(_RequestTransport, self)
        transport._ensure_initialized(cancel_handle=cancel_handle)
        return transport._list_prompt_pages(transport._send_request, cancel_handle=cancel_handle,
                                            timeout_seconds=transport._request_timeout_seconds)

    def get_prompt(
        self,
        name: str,
        arguments: dict[str, str],
        *,
        timeout_seconds: float | None = None,
        cancel_handle: Any = None,
    ) -> dict[str, Any]:
        transport = cast(_RequestTransport, self)
        transport._ensure_initialized(cancel_handle=cancel_handle)
        response = transport._send_request(
            "prompts/get", {"name": name, "arguments": arguments},
            timeout_seconds=timeout_seconds, cancel_handle=cancel_handle,
        )
        return transport._require_result(response, "prompts/get")
