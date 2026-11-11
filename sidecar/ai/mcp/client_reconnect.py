"""``MCPClient`` server reconnects: the cooldown-gated respawn and the failure history.

Split from ``client.py`` (at the 1015-line hard cap, row 105).
"""

from __future__ import annotations

import logging
import threading
from typing import TYPE_CHECKING, Any

from sidecar.ai.mcp import transport_base
from sidecar.ai.mcp.exceptions import MCPError
from sidecar.ai.mcp.models import MCPServerFailure, MCPToolDescriptor
from sidecar.runtime.cooldowns import CooldownRegistry
from sidecar.runtime.diagnostics import log_event

if TYPE_CHECKING:
    from sidecar.ai.config import MCPServerConfig

# Records keep the client's logger name (this code moved out of client.py).
logger = logging.getLogger("sidecar.ai.mcp.client")
MCP_COOLDOWN_NAMESPACE = "mcp"
MCP_FAILURE_HISTORY_LIMIT = 64
_UNSPECIFIED_TRANSPORT = object()


class ClientReconnectMixin:
    # Host-state declarations for static type-checking only: ``MCPClient`` sets the
    # attributes in ``__init__`` and defines the methods stubbed under TYPE_CHECKING;
    # neither has any runtime effect.
    _transport_registry_lock: threading.RLock
    _transports: dict[str, transport_base.MCPTransport]
    _tools_by_name: dict[str, MCPToolDescriptor]
    _server_configs: dict[str, MCPServerConfig]
    _sse_enabled: bool
    _failures: list[MCPServerFailure]
    _cooldowns: CooldownRegistry
    _mcp_reconnect_cooldown_seconds: float

    if TYPE_CHECKING:
        def _remove_server_registration(
            self, server_name: str
        ) -> dict[str, MCPToolDescriptor]: ...

        def _build_transport(
            self,
            server: MCPServerConfig,
            *,
            sse_enabled: bool,
            request_timeout_seconds: float | None = None,
        ) -> transport_base.MCPTransport: ...

        def _register_transport(self, transport: transport_base.MCPTransport) -> None: ...

        def _rebuild_compat_tool_index(self) -> None: ...

    def _reconnect_transport(
        self,
        server_name: str,
        *,
        request_timeout_seconds: float | None = None,
        expected_transport: transport_base.MCPTransport | None | object = (
            _UNSPECIFIED_TRANSPORT
        ),
    ) -> bool:
        with self._transport_registry_lock:
            current_transport = self._transports.get(server_name)
            if expected_transport is not _UNSPECIFIED_TRANSPORT:
                if expected_transport is None and current_transport is not None:
                    return True
                if (
                    expected_transport is not None
                    and current_transport is not expected_transport
                ):
                    return current_transport is not None
            config = self._server_configs.get(server_name)
            if config is None:
                return False
            cooldown = self._cooldowns.status(MCP_COOLDOWN_NAMESPACE, server_name)
            if cooldown.active:
                log_event(
                    logger,
                    logging.INFO,
                    component="ai.mcp.client",
                    event="ai.mcp.server_reconnect_deferred",
                    message=f"MCP server reconnect deferred by cooldown: {server_name}",
                    status="cooldown",
                    data={
                        "server": server_name,
                        "remaining_seconds": cooldown.remaining_seconds,
                        "reason": cooldown.reason,
                    },
                )
                return False
            removed_descriptors = self._remove_server_registration(server_name)
            try:
                build_kwargs: dict[str, Any] = {"sse_enabled": self._sse_enabled}
                if request_timeout_seconds is not None:
                    build_kwargs["request_timeout_seconds"] = request_timeout_seconds
                transport = self._build_transport(config, **build_kwargs)
                self._register_transport(transport)
            except Exception as error:  # noqa: BLE001
                self._tools_by_name.update(removed_descriptors)
                self._rebuild_compat_tool_index()
                self._cooldowns.mark(
                    MCP_COOLDOWN_NAMESPACE,
                    server_name,
                    duration_seconds=self._mcp_reconnect_cooldown_seconds,
                    reason="reconnect_failed",
                )
                if isinstance(error, MCPError):
                    self._record_failure(
                        MCPServerFailure(
                            name=server_name,
                            code=error.code,
                            message=error.message,
                        )
                    )
                log_event(
                    logger,
                    logging.WARNING,
                    component="ai.mcp.client",
                    event="ai.mcp.server_reconnect_failed",
                    message=f"MCP server reconnect failed: {server_name}",
                    status="failure",
                    data={
                        "server": server_name,
                        "error_type": type(error).__name__,
                        "code": error.code if isinstance(error, MCPError) else None,
                    },
                )
                return False
            self._cooldowns.clear(MCP_COOLDOWN_NAMESPACE, server_name)
            log_event(
                logger,
                logging.INFO,
                component="ai.mcp.client",
                event="ai.mcp.server_reconnected",
                message=f"MCP server reconnected: {server_name}",
                status="ok",
                data={"server": server_name},
            )
            return True

    def _record_failure(self, failure: MCPServerFailure) -> None:
        self._failures.append(failure)
        overflow = len(self._failures) - MCP_FAILURE_HISTORY_LIMIT
        if overflow > 0:
            self._failures = self._failures[overflow:]
