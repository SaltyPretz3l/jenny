"""Transport contract for MCP server communication."""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any

from sidecar.runtime.chat_models import TerminalChatStateError
from sidecar.runtime.turn_state import TURN_STATE_CANCELLED


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


class MCPTransport(ABC):
    @property
    @abstractmethod
    def server_name(self) -> str:
        raise NotImplementedError

    @abstractmethod
    def list_tools(self, *, cancel_handle: Any = None) -> list[dict[str, Any]]:
        raise NotImplementedError

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
