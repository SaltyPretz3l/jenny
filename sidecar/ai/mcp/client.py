"""MCP client orchestration and dynamic tool registry."""

from __future__ import annotations

import logging
import threading
from typing import TYPE_CHECKING, Any

from sidecar.ai.error_codes import CMP_MCP_TOOL_SURFACE_CHANGED
from sidecar.ai.mcp import (
    client_prompts,
    client_reuse,
    client_support,
    retry_policy,
    transport_base,
    transport_sse,
    transport_stdio,
)
from sidecar.ai.mcp.client_reconnect import (
    MCP_COOLDOWN_NAMESPACE,
    MCP_FAILURE_HISTORY_LIMIT,  # noqa: F401 - stable public re-export.
    ClientReconnectMixin,
)
from sidecar.ai.mcp.exceptions import (
    CMP_MCP_CONFIG_INVALID,
    CMP_MCP_SERVER_FAILED,
    CMP_MCP_SSE_DISABLED,
    CMP_MCP_TOOL_NOT_FOUND,
    MCPError,
)
from sidecar.ai.mcp.models import (
    MCPServerCooldown,
    MCPServerDiagnostics,
    MCPServerFailure,
    MCPToolDescriptor,
    MCPToolResult,
)
from sidecar.ai.mcp.tool_namespace import is_namespaced_mcp_tool_name
from sidecar.ai.mcp.tool_surface import as_log_data, summarize_tools, tools_digest
from sidecar.ai.tools.catalog import reserved_tool_names
from sidecar.ai.tools.tool_actions import effective_side_effecting
from sidecar.runtime.cooldowns import CooldownRegistry
from sidecar.runtime.diagnostics import log_event

if TYPE_CHECKING:
    from sidecar.ai.config import MCPServerConfig

logger = logging.getLogger(__name__)
DEFAULT_MCP_RECONNECT_COOLDOWN_SECONDS = 5.0
_extract_tool_output = client_support.extract_tool_output
_attach_recovery_metadata = client_support.attach_recovery_metadata


def _raise_if_replay_unsafe(error: MCPError | None, descriptor: Any, args: dict[str, Any]) -> None:
    if error is not None and effective_side_effecting(descriptor, args) is not False:
        raise error


class MCPClient(client_prompts.ClientPromptsMixin, ClientReconnectMixin):
    def __init__(
        self,
        *,
        request_timeout_seconds: float | None = None,
        cooldown_registry: CooldownRegistry | None = None,
        mcp_reconnect_cooldown_seconds: float = DEFAULT_MCP_RECONNECT_COOLDOWN_SECONDS,
    ) -> None:
        self._transport_registry_lock = threading.RLock()
        self._transports: dict[str, transport_base.MCPTransport] = {}
        self._tools_by_name: dict[str, MCPToolDescriptor] = {}
        self._compat_tools_by_name: dict[str, str] = {}
        self._server_configs: dict[str, MCPServerConfig] = {}
        self._sse_enabled = False
        # Mirror tools_web_allow_private_addresses / tools_web_allow_loopback; they
        # relax only the SSRF address-class check on sse transport / oauth token URLs.
        self._allow_private_addresses = self._allow_loopback = False
        self._connected: list[str] = []
        self._failures: list[MCPServerFailure] = []
        self._request_timeout_seconds = request_timeout_seconds
        self._cooldowns = cooldown_registry or CooldownRegistry()
        self._mcp_reconnect_cooldown_seconds = max(float(mcp_reconnect_cooldown_seconds), 0.0)
        self._reuse = client_reuse.ReuseState()

    def close(self) -> None:
        with self._transport_registry_lock:
            # An adopted transport goes back to a source that still lists it (its
            # leased turns may be in flight); otherwise it is closed below.
            client_reuse.return_adopted(self)
            for transport in self._transports.values():
                if self._reuse.owns(transport):  # never one handed to a later generation
                    transport.close()
            self._transports.clear()
            self._tools_by_name.clear()
            self._compat_tools_by_name.clear()
            self._server_configs.clear()
            self._sse_enabled = False
            self._allow_private_addresses = self._allow_loopback = False
            self._connected = []
            self._failures = []
            self._cooldowns.clear_namespace(MCP_COOLDOWN_NAMESPACE)
            self._reuse = client_reuse.ReuseState()

    def configure(
        self,
        servers: tuple[MCPServerConfig, ...],
        *,
        sse_enabled: bool,
        allow_private_addresses: bool = False, allow_loopback: bool = False,
        reuse_from: MCPClient | None = None,
    ) -> None:
        """Connect ``servers``; adopt ``reuse_from``'s live transports whose reuse
        key is unchanged (``client_reuse``)."""
        with self._transport_registry_lock:
            self.close()
            self._server_configs = {server.name: server for server in servers}
            self._sse_enabled = sse_enabled
            self._allow_private_addresses = bool(allow_private_addresses)
            self._allow_loopback = bool(allow_loopback)
            client_reuse.connect_servers(self, servers, reuse_from=reuse_from)

    @property
    def available_tools(self) -> list[MCPToolDescriptor]:
        with self._transport_registry_lock:
            return sorted(self._tools_by_name.values(), key=lambda item: item.name)

    def tool_descriptor(self, tool_name: str) -> MCPToolDescriptor | None:
        with self._transport_registry_lock:
            return self._resolve_tool_descriptor(tool_name, emit_compat_warning=False)

    def server_generation_id(self, server_name: str) -> str | None:
        """Live generation id of a connected server's transport, or None."""
        with self._transport_registry_lock:
            transport = self._transports.get(server_name)
        if transport is None:
            return None
        value = getattr(transport, "server_generation_id", None)
        return value if isinstance(value, str) and value else None

    def server_hosted_files(self, server_name: str) -> dict[str, object] | None:
        """A connected root-boundary worker's file tools state, or None."""
        with self._transport_registry_lock:
            transport = self._transports.get(server_name)
        value = getattr(transport, "server_hosted_files", None)
        return dict(value) if isinstance(value, dict) else None

    def diagnostics(self) -> MCPServerDiagnostics:
        with self._transport_registry_lock:
            return MCPServerDiagnostics(
                connected=tuple(self._connected),
                failures=tuple(self._failures),
                cooldowns=tuple(
                    MCPServerCooldown(
                        name=status.name,
                        remaining_seconds=status.remaining_seconds,
                        reason=status.reason,
                    )
                    for status in self._cooldowns.snapshot(namespace=MCP_COOLDOWN_NAMESPACE)
                ),
            )

    def execute_tool(
        self,
        tool_name: str,
        arguments: dict[str, Any],
        *,
        timeout_seconds: float | None = None,
        cancel_handle: Any = None,
        on_output_chunk: Any = None,
    ) -> MCPToolResult:
        deadline = client_support.tool_deadline(timeout_seconds)
        current_tool_name = tool_name
        attempts_completed = 0
        retry_count = 0
        reconnected_server: str | None = None
        prior_generation_id: str | None = None
        recovered_operation_id: str | None = None
        pending_replay_error: MCPError | None = None
        respawned_terminated = False
        while True:
            client_support.raise_if_cancelled(cancel_handle)
            remaining_timeout = client_support.remaining_tool_timeout(
                deadline, timeout_seconds, spent_error=pending_replay_error
            )
            with self._transport_registry_lock:
                descriptor = self._resolve_tool_descriptor(current_tool_name)
                transport = (
                    self._transports.get(descriptor.server_name)
                    if descriptor is not None
                    else None
                )
            if descriptor is None:
                raise MCPError(
                    code=CMP_MCP_TOOL_NOT_FOUND,
                    message=f"tool '{current_tool_name}' is not registered",
                    retryable=False,
                )
            # F2: a server killed after the last call (a Stop past the cancel grace)
            # stays registered; respawn it once before sending (nothing sent, no replay).
            dead = not respawned_terminated and getattr(transport, "is_terminated", False) is True
            if transport is None or dead:
                respawned_terminated = respawned_terminated or dead
                if self._reconnect_transport(
                    descriptor.server_name,
                    request_timeout_seconds=remaining_timeout,
                    expected_transport=transport,
                ):
                    current_tool_name = descriptor.name
                    continue
                raise MCPError(
                    code=CMP_MCP_SERVER_FAILED,
                    message=f"tool server '{descriptor.server_name}' is unavailable",
                    retryable=False,
                )
            _raise_if_replay_unsafe(pending_replay_error, descriptor, arguments)
            pending_replay_error = None
            server_tool_name = descriptor.server_tool_name or descriptor.name
            try:
                result_payload = client_support.call_transport_tool(
                    transport,
                    server_tool_name,
                    arguments,
                    timeout_seconds=remaining_timeout,
                    cancel_handle=cancel_handle,
                    on_output_chunk=on_output_chunk,
                )
            except MCPError as error:
                attempts_completed += 1
                prior_generation_id = error.generation_id
                recovered_operation_id = error.operation_id
                retry_descriptor, reconnected = self._replay_descriptor_after_failure(
                    error,
                    descriptor,
                    transport,
                    arguments,
                    attempts_completed=attempts_completed,
                    deadline=deadline,
                    timeout_seconds=timeout_seconds,
                    cancel_handle=cancel_handle,
                )
                if reconnected:
                    reconnected_server = descriptor.server_name
                if retry_descriptor is None:
                    raise
                current_tool_name = retry_descriptor.name
                retry_count += 1
                pending_replay_error = error
                continue
            extracted = _extract_tool_output(result_payload)
            if retry_count > 0:
                _attach_recovery_metadata(
                    extracted["metadata"],
                    retry_count=retry_count,
                    reconnected_server=reconnected_server,
                    prior_generation_id=prior_generation_id,
                    current_generation_id=getattr(transport, "server_generation_id", None),
                    operation_id=recovered_operation_id,
                )
            return MCPToolResult(
                tool_name=descriptor.name,
                **extracted,
            )
    def _register_transport(self, transport: transport_base.MCPTransport) -> None:
        config = self._server_configs.get(transport.server_name)
        expected_digest = getattr(config, "approved_tools_digest", None)
        try:
            raw_tools = transport.list_tools()
            # Approved (external) servers register exactly the normalized surface
            # their digest covers. Only the first-party builtin server is
            # forwarded without a digest, and its raw catalog exceeds the
            # review caps by design.
            if expected_digest:
                tools_payload = summarize_tools(raw_tools)
                live_digest = tools_digest(
                    tools_payload,
                    read_only_claims=getattr(config, "read_only_auto_allow", False) is True,
                )
                if live_digest != expected_digest:
                    raise ValueError("tool_surface_changed")
            else:
                tools_payload = raw_tools if isinstance(raw_tools, list) else []
        except Exception as error:
            log_event(
                logger,
                logging.WARNING,
                component="ai.mcp.client",
                event="ai.mcp.transport_list_tools_failed",
                message=f"MCP transport list_tools failed: {transport.server_name}",
                status="failure",
                data={
                    "server": transport.server_name,
                    **as_log_data(error),
                },
            )
            transport.close()
            if isinstance(error, ValueError):
                raise MCPError(
                    code=(
                        CMP_MCP_TOOL_SURFACE_CHANGED if expected_digest else CMP_MCP_CONFIG_INVALID
                    ),
                    message="MCP tool surface is invalid or changed and requires trust review",
                    retryable=False,
                ) from error
            raise
        pending_descriptors: dict[str, MCPToolDescriptor] = {}
        for tool_payload in tools_payload:
            descriptor = client_support.descriptor_from_payload(
                transport.server_name,
                tool_payload,
                # Claims count only on a reviewed surface whose digest bound them.
                read_only_auto_allow=bool(expected_digest)
                and getattr(config, "read_only_auto_allow", False) is True,
            )
            if descriptor is None:
                continue
            existing = pending_descriptors.get(descriptor.name) or self._tools_by_name.get(
                descriptor.name
            )
            if existing is not None:
                if (
                    existing.server_name == descriptor.server_name
                    and existing.server_tool_name == descriptor.server_tool_name
                ):
                    continue
                transport.close()
                if existing.server_name != transport.server_name:
                    self._remove_server_registration(existing.server_name)
                raise MCPError(
                    code=CMP_MCP_CONFIG_INVALID,
                    message="MCP tool namespace collision requires unique server and tool names",
                    retryable=False,
                )
            pending_descriptors[descriptor.name] = descriptor
        self._tools_by_name.update(pending_descriptors)
        self._rebuild_compat_tool_index()
        self._transports[transport.server_name] = transport
        self._connected.append(transport.server_name)
        self._failures = [row for row in self._failures if row.name != transport.server_name]

    def _remove_server_registration(self, server_name: str) -> dict[str, MCPToolDescriptor]:
        transport = self._transports.pop(server_name, None)
        if transport is not None and self._reuse.owns(transport):
            transport.close()
        removed_descriptors = {
            name: descriptor
            for name, descriptor in self._tools_by_name.items()
            if descriptor.server_name == server_name
        }
        for name in removed_descriptors:
            self._tools_by_name.pop(name, None)
        self._connected = [name for name in self._connected if name != server_name]
        self._rebuild_compat_tool_index()
        return removed_descriptors

    def _replay_descriptor_after_failure(  # noqa: PLR0913 - the failure context is irreducible.
        self,
        error: MCPError,
        descriptor: MCPToolDescriptor,
        transport: Any,
        arguments: dict[str, Any],
        *,
        attempts_completed: int,
        deadline: float | None,
        timeout_seconds: float | None,
        cancel_handle: Any,
    ) -> tuple[MCPToolDescriptor | None, bool]:
        """Reconnect after a failed call and resolve a replay-safe descriptor.

        Returns (retry_descriptor, reconnected); retry_descriptor is None when
        the call must not be replayed (the caller re-raises the original error).
        """
        decision = retry_policy.should_retry_tool_call(
            error,
            side_effecting=effective_side_effecting(descriptor, arguments),
            attempts_completed=attempts_completed,
            max_attempts=retry_policy.DEFAULT_MCP_TOOL_CALL_MAX_ATTEMPTS,
        )
        reconnected = False
        if decision.reconnect:
            client_support.raise_if_cancelled(cancel_handle)
            try:
                remaining_timeout = client_support.remaining_tool_timeout(
                    deadline, timeout_seconds
                )
            except MCPError:
                # A transport timeout always spends the whole budget; the
                # caller re-raises the original error with its evidence.
                return None, False
            reconnected = self._reconnect_transport(
                descriptor.server_name,
                request_timeout_seconds=remaining_timeout,
                expected_transport=transport,
            )
        if not (decision.retry and reconnected):
            return None, reconnected
        return self._refreshed_replay_descriptor(descriptor, arguments), reconnected

    def _refreshed_replay_descriptor(
        self, descriptor: MCPToolDescriptor, arguments: dict[str, Any]
    ) -> MCPToolDescriptor | None:
        refreshed_descriptor = self._resolve_tool_descriptor(
            descriptor.name,
            emit_compat_warning=False,
        )
        if refreshed_descriptor is None:
            return None
        if refreshed_descriptor.server_name != descriptor.server_name:
            return None
        if effective_side_effecting(refreshed_descriptor, arguments) is not False:
            return None
        return refreshed_descriptor

    def _resolve_tool_descriptor(
        self,
        tool_name: str,
        *,
        emit_compat_warning: bool = True,
    ) -> MCPToolDescriptor | None:
        normalized_name = str(tool_name or "").strip()
        descriptor = self._tools_by_name.get(normalized_name)
        if descriptor is not None:
            return descriptor
        compat_name = self._compat_tools_by_name.get(normalized_name)
        if compat_name is None:
            return None
        descriptor = self._tools_by_name.get(compat_name)
        if descriptor is None:
            return None
        if emit_compat_warning:
            log_event(
                logger,
                logging.WARNING,
                component="ai.mcp.client",
                event="ai.mcp.bare_tool_name_compat",
                message=f"Resolved legacy bare MCP tool name: {normalized_name}",
                status="degraded",
                data={
                    "requested_tool": normalized_name,
                    "resolved_tool": descriptor.name,
                    "server": descriptor.server_name,
                },
            )
        return descriptor

    def _rebuild_compat_tool_index(self) -> None:
        reserved_names = set(reserved_tool_names())
        candidates: dict[str, str] = {}
        ambiguous_names: set[str] = set()
        for descriptor in self._tools_by_name.values():
            if descriptor.source_kind != "mcp":
                continue
            raw_name = str(descriptor.server_tool_name or "").strip()
            if (
                not raw_name
                or raw_name in reserved_names
                or is_namespaced_mcp_tool_name(raw_name)
                or raw_name in self._tools_by_name
                or raw_name == descriptor.name
            ):
                continue
            existing = candidates.get(raw_name)
            if existing is not None and existing != descriptor.name:
                ambiguous_names.add(raw_name)
                candidates.pop(raw_name, None)
                continue
            if raw_name not in ambiguous_names:
                candidates[raw_name] = descriptor.name
        self._compat_tools_by_name = candidates

    def _build_transport(
        self,
        server: MCPServerConfig,
        *,
        sse_enabled: bool,
        request_timeout_seconds: float | None = None,
    ) -> transport_base.MCPTransport:
        effective_request_timeout = (
            request_timeout_seconds
            if request_timeout_seconds is not None
            else self._request_timeout_seconds
        )
        if server.transport == "stdio":
            return transport_stdio.StdioMCPTransport(
                server, request_timeout_seconds=effective_request_timeout
            )
        if server.transport == "sse":
            if not sse_enabled:
                raise MCPError(
                    code=CMP_MCP_SSE_DISABLED,
                    message=f"sse transport is disabled for server '{server.name}'",
                    retryable=False,
                )
            return transport_sse.SSEMCPTransport(
                server, request_timeout_seconds=effective_request_timeout,
                allow_private_addresses=self._allow_private_addresses,
                allow_loopback=self._allow_loopback,
            )
        raise MCPError(
            code=CMP_MCP_CONFIG_INVALID,
            message=f"unsupported mcp transport '{server.transport}'",
            retryable=False,
        )
