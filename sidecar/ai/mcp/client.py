"""MCP client orchestration and dynamic tool registry."""

from __future__ import annotations

import logging
import threading
from dataclasses import asdict
from typing import TYPE_CHECKING, Any

from sidecar.ai.error_codes import (
    CMP_MCP_RESOURCE_INVALID,
    CMP_MCP_RESOURCE_NOT_FOUND,
    CMP_MCP_RESOURCE_UNSUPPORTED,
    CMP_MCP_TOOL_SURFACE_CHANGED,
)
from sidecar.ai.mcp import (
    client_support,
    retry_policy,
    transport_base,
    transport_sse,
    transport_stdio,
)
from sidecar.ai.mcp.exceptions import (
    CMP_MCP_CONFIG_INVALID,
    CMP_MCP_SERVER_FAILED,
    CMP_MCP_SSE_DISABLED,
    CMP_MCP_TOOL_NOT_FOUND,
    MCPError,
)
from sidecar.ai.mcp.models import (
    MCPResourceDescriptor,
    MCPResourceReadResult,
    MCPServerCooldown,
    MCPServerDiagnostics,
    MCPServerFailure,
    MCPToolDescriptor,
    MCPToolResult,
)
from sidecar.ai.mcp.resource_payloads import (
    MCP_RESOURCE_TEXT_EXCERPT_MAX_CHARS,
    MCP_RESOURCE_TOOL_LIST_RESOURCES,
    MCP_RESOURCE_TOOL_LIST_TEMPLATES,
    MCP_RESOURCE_TOOL_READ_RESOURCE,
    MCP_RESOURCE_URI_MAX_CHARS,
    collect_paginated_resource_items,
    resource_descriptor_from_payload,
    resource_mime_from_payload,
    resource_result_payload,
    resource_size_from_payload,
    resource_template_from_payload,
    sanitize_resource_string,
)
from sidecar.ai.mcp.tool_namespace import (
    is_namespaced_mcp_tool_name,
    namespace_mcp_resource_id,
    namespace_mcp_tool_name,
)
from sidecar.ai.mcp.tool_surface import summarize_tools, tools_digest
from sidecar.ai.tools.catalog import reserved_tool_names
from sidecar.ai.tools.sanitization import sanitize_tool_output
from sidecar.ai.tools.tool_actions import effective_side_effecting
from sidecar.runtime.cooldowns import CooldownRegistry
from sidecar.runtime.diagnostics import log_event

if TYPE_CHECKING:
    from sidecar.ai.config import MCPServerConfig

logger = logging.getLogger(__name__)
MCP_COOLDOWN_NAMESPACE = "mcp"
DEFAULT_MCP_RECONNECT_COOLDOWN_SECONDS = 5.0
MCP_FAILURE_HISTORY_LIMIT = 64
_extract_tool_output = client_support.extract_tool_output
_attach_recovery_metadata = client_support.attach_recovery_metadata
_UNSPECIFIED_TRANSPORT = object()


def _raise_if_replay_unsafe(error: MCPError | None, descriptor: Any, args: dict[str, Any]) -> None:
    if error is not None and effective_side_effecting(descriptor, args) is not False:
        raise error


class MCPClient:
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
        self._resources_by_id: dict[str, MCPResourceDescriptor] = {}
        self._server_configs: dict[str, MCPServerConfig] = {}
        self._sse_enabled = False
        self._resources_enabled = False
        # Mirrors the owner's tools_web_allow_private_addresses decision; relaxes
        # only the SSRF address-class check on sse transport / oauth token URLs.
        self._allow_private_addresses = False
        self._connected: list[str] = []
        self._failures: list[MCPServerFailure] = []
        self._request_timeout_seconds = request_timeout_seconds
        self._cooldowns = cooldown_registry or CooldownRegistry()
        self._mcp_reconnect_cooldown_seconds = max(float(mcp_reconnect_cooldown_seconds), 0.0)

    def close(self) -> None:
        with self._transport_registry_lock:
            for transport in self._transports.values():
                transport.close()
            self._transports.clear()
            self._tools_by_name.clear()
            self._compat_tools_by_name.clear()
            self._resources_by_id.clear()
            self._server_configs.clear()
            self._sse_enabled = False
            self._resources_enabled = False
            self._allow_private_addresses = False
            self._connected = []
            self._failures = []
            self._cooldowns.clear_namespace(MCP_COOLDOWN_NAMESPACE)

    def configure(
        self,
        servers: tuple[MCPServerConfig, ...],
        *,
        sse_enabled: bool,
        resources_enabled: bool = False,
        allow_private_addresses: bool = False,
    ) -> None:
        with self._transport_registry_lock:
            self.close()
            self._server_configs = {server.name: server for server in servers}
            self._sse_enabled = sse_enabled
            self._resources_enabled = resources_enabled
            self._allow_private_addresses = bool(allow_private_addresses)
            for server in servers:
                try:
                    transport = self._build_transport(server, sse_enabled=sse_enabled)
                    self._register_transport(transport)
                except MCPError as error:
                    self._record_failure(
                        MCPServerFailure(name=server.name, code=error.code, message=error.message)
                    )
                    log_event(
                        logger,
                        logging.WARNING,
                        component="ai.mcp.client",
                        event="ai.mcp.server_setup_failed",
                        message=f"MCP server setup failed: {server.name}",
                        status="failure",
                        data={"server": server.name, "code": error.code},
                    )

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
        while True:
            client_support.raise_if_cancelled(cancel_handle)
            remaining_timeout = client_support.remaining_tool_timeout(deadline, timeout_seconds)
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
            if transport is None:
                if self._reconnect_transport(
                    descriptor.server_name,
                    request_timeout_seconds=remaining_timeout,
                    expected_transport=None,
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
                if descriptor.synthetic_resource_tool:
                    resource_budget = client_support.ToolCallBudget(
                        deadline=deadline,
                        fallback_timeout_seconds=timeout_seconds,
                        cancel_handle=cancel_handle,
                    )
                    result_payload = self._execute_resource_tool_payload(
                        transport,
                        descriptor,
                        arguments,
                        budget=resource_budget,
                    )
                else:
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
        try:
            tools_payload = transport.list_tools()
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
                    "error_type": type(error).__name__,
                },
            )
            transport.close()
            raise
        config = self._server_configs.get(transport.server_name)
        expected_digest = getattr(config, "approved_tools_digest", None)
        if expected_digest:
            summary, _malformed_count = summarize_tools(tools_payload)
            if tools_digest(summary) != expected_digest:
                transport.close()
                raise MCPError(
                    code=CMP_MCP_TOOL_SURFACE_CHANGED,
                    message="MCP tool surface changed and requires trust review",
                    retryable=False,
                )
        pending_descriptors: dict[str, MCPToolDescriptor] = {}
        for tool_payload in tools_payload:
            descriptor = client_support.descriptor_from_payload(
                transport.server_name,
                tool_payload,
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
        if self._resources_enabled:
            self._register_resource_tools(transport)
        self._rebuild_compat_tool_index()
        self._transports[transport.server_name] = transport
        self._connected.append(transport.server_name)

    def _register_resource_tools(self, transport: transport_base.MCPTransport) -> None:
        resources_supported = self._probe_resource_capability(
            transport,
            MCP_RESOURCE_TOOL_LIST_RESOURCES,
        )
        templates_supported = self._probe_resource_capability(
            transport,
            MCP_RESOURCE_TOOL_LIST_TEMPLATES,
        )
        if resources_supported:
            for raw_tool_name in (
                MCP_RESOURCE_TOOL_LIST_RESOURCES,
                MCP_RESOURCE_TOOL_READ_RESOURCE,
            ):
                self._add_resource_tool_descriptor(transport.server_name, raw_tool_name)
        if templates_supported:
            self._add_resource_tool_descriptor(
                transport.server_name,
                MCP_RESOURCE_TOOL_LIST_TEMPLATES,
            )

    def _probe_resource_capability(
        self,
        transport: transport_base.MCPTransport,
        raw_tool_name: str,
    ) -> bool:
        try:
            if raw_tool_name == MCP_RESOURCE_TOOL_LIST_RESOURCES:
                result = transport.list_resources(timeout_seconds=self._request_timeout_seconds)
            else:
                result = transport.list_resource_templates(
                    timeout_seconds=self._request_timeout_seconds
                )
        except MCPError as error:
            log_event(
                logger,
                logging.INFO,
                component="ai.mcp.client",
                event="ai.mcp.resource_capability_unavailable",
                message=f"MCP resource capability unavailable: {transport.server_name}",
                status="unavailable",
                data={
                    "server": transport.server_name,
                    "resource_tool": raw_tool_name,
                    "code": error.code,
                },
            )
            return False
        except Exception as error:  # noqa: BLE001
            log_event(
                logger,
                logging.WARNING,
                component="ai.mcp.client",
                event="ai.mcp.resource_capability_probe_failed",
                message=f"MCP resource capability probe failed: {transport.server_name}",
                status="failure",
                data={
                    "server": transport.server_name,
                    "resource_tool": raw_tool_name,
                    "error_type": type(error).__name__,
                },
            )
            return False
        return isinstance(result, dict)

    def _add_resource_tool_descriptor(self, server_name: str, raw_tool_name: str) -> None:
        tool_name = namespace_mcp_tool_name(server_name, raw_tool_name)
        description, input_schema = self._resource_tool_contract(raw_tool_name)
        self._tools_by_name[tool_name] = MCPToolDescriptor(
            name=tool_name,
            description=description,
            input_schema=input_schema,
            side_effecting=False,
            server_name=server_name,
            source_kind="mcp",
            tool_family="discovery",
            server_tool_name=raw_tool_name,
            synthetic_resource_tool=True,
        )

    def _resource_tool_contract(self, raw_tool_name: str) -> tuple[str, dict[str, Any]]:
        if raw_tool_name == MCP_RESOURCE_TOOL_READ_RESOURCE:
            return (
                "Read a text MCP resource from this server by resource_id or uri.",
                {
                    "type": "object",
                    "properties": {
                        "resource_id": {"type": "string"},
                        "uri": {"type": "string"},
                    },
                },
            )
        schema = {
            "type": "object",
            "properties": {"cursor": {"type": "string"}},
        }
        if raw_tool_name == MCP_RESOURCE_TOOL_LIST_TEMPLATES:
            return ("List MCP resource URI templates for this server.", schema)
        return ("List MCP resources advertised by this server.", schema)

    def _execute_resource_tool_payload(
        self,
        transport: transport_base.MCPTransport,
        descriptor: MCPToolDescriptor,
        arguments: dict[str, Any],
        *,
        budget: client_support.ToolCallBudget,
    ) -> dict[str, Any]:
        raw_tool_name = descriptor.server_tool_name or descriptor.name
        if raw_tool_name == MCP_RESOURCE_TOOL_LIST_RESOURCES:
            return self._list_resources_tool_payload(
                transport,
                arguments,
                budget=budget,
            )
        if raw_tool_name == MCP_RESOURCE_TOOL_READ_RESOURCE:
            return self._read_resource_tool_payload(
                transport,
                arguments,
                budget=budget,
            )
        if raw_tool_name == MCP_RESOURCE_TOOL_LIST_TEMPLATES:
            return self._list_resource_templates_tool_payload(
                transport,
                arguments,
                budget=budget,
            )
        raise MCPError(
            code=CMP_MCP_TOOL_NOT_FOUND,
            message=f"resource tool '{raw_tool_name}' is not registered",
            retryable=False,
        )

    def _list_resources_tool_payload(
        self,
        transport: transport_base.MCPTransport,
        arguments: dict[str, Any],
        *,
        budget: client_support.ToolCallBudget,
    ) -> dict[str, Any]:
        resources, next_cursor, truncated, page_count, malformed_count = (
            collect_paginated_resource_items(
                arguments,
                load_page=lambda cursor: client_support.call_transport_resource(
                    transport.list_resources,
                    timeout_seconds=budget.remaining_timeout(),
                    cancel_handle=budget.cancel_handle,
                    cursor=cursor,
                ),
                page_item_keys=("resources",),
                normalize_item=lambda item: resource_descriptor_from_payload(
                    transport.server_name,
                    item,
                ),
            )
        )
        refreshed_resources = {resource.resource_id: resource for resource in resources}
        with self._transport_registry_lock:
            self._clear_resource_cache_for_server(transport.server_name)
            self._resources_by_id.update(refreshed_resources)
        payload = {
            "server_name": transport.server_name,
            "resources": [asdict(resource) for resource in resources],
            "next_cursor": next_cursor,
            "truncated": truncated,
            "page_count": page_count,
            "malformed_count": malformed_count,
        }
        return resource_result_payload(
            payload,
            metadata={
                "result_kind": "mcp_resources_list",
                "server_name": transport.server_name,
                "malformed_count": malformed_count,
                "truncated": truncated,
            },
        )

    def _list_resource_templates_tool_payload(
        self,
        transport: transport_base.MCPTransport,
        arguments: dict[str, Any],
        *,
        budget: client_support.ToolCallBudget,
    ) -> dict[str, Any]:
        templates, next_cursor, truncated, page_count, malformed_count = (
            collect_paginated_resource_items(
                arguments,
                load_page=lambda cursor: client_support.call_transport_resource(
                    transport.list_resource_templates,
                    timeout_seconds=budget.remaining_timeout(),
                    cancel_handle=budget.cancel_handle,
                    cursor=cursor,
                ),
                page_item_keys=("resourceTemplates", "resource_templates"),
                normalize_item=lambda item: resource_template_from_payload(
                    transport.server_name,
                    item,
                ),
            )
        )
        payload = {
            "server_name": transport.server_name,
            "templates": [asdict(template) for template in templates],
            "next_cursor": next_cursor,
            "truncated": truncated,
            "page_count": page_count,
            "malformed_count": malformed_count,
        }
        return resource_result_payload(
            payload,
            metadata={
                "result_kind": "mcp_resource_templates_list",
                "server_name": transport.server_name,
                "malformed_count": malformed_count,
                "truncated": truncated,
            },
        )

    def _read_resource_tool_payload(
        self,
        transport: transport_base.MCPTransport,
        arguments: dict[str, Any],
        *,
        budget: client_support.ToolCallBudget,
    ) -> dict[str, Any]:
        resource_id = arguments.get("resource_id")
        resource_id = resource_id.strip() if isinstance(resource_id, str) else ""
        uri = arguments.get("uri")
        uri = uri.strip() if isinstance(uri, str) else ""
        if uri and len(uri) > MCP_RESOURCE_URI_MAX_CHARS:
            return resource_result_payload(
                {
                    "server_name": transport.server_name,
                    "status": "invalid",
                    "reason": "resource uri exceeds maximum length",
                    "resource_id": resource_id,
                    "uri": sanitize_resource_string(uri, max_chars=256),
                    "artifact_ref": None,
                },
                success=False,
                error_code=CMP_MCP_RESOURCE_INVALID,
                metadata={"result_kind": "mcp_resource_read"},
            )
        with self._transport_registry_lock:
            descriptor = self._resources_by_id.get(resource_id) if resource_id else None
        if descriptor is not None and descriptor.server_name != transport.server_name:
            descriptor = None
        if descriptor is not None:
            uri = descriptor.uri
        elif resource_id and not uri:
            return resource_result_payload(
                {
                    "server_name": transport.server_name,
                    "status": "not_found",
                    "reason": "resource_id is not known for this server",
                    "resource_id": resource_id,
                    "uri": uri,
                    "artifact_ref": None,
                },
                success=False,
                error_code=CMP_MCP_RESOURCE_NOT_FOUND,
                metadata={"result_kind": "mcp_resource_read"},
            )
        elif resource_id:
            resource_id = ""
        if not uri:
            return resource_result_payload(
                {
                    "server_name": transport.server_name,
                    "status": "invalid",
                    "reason": "read_resource requires resource_id or uri",
                    "resource_id": resource_id,
                    "uri": uri,
                    "artifact_ref": None,
                },
                success=False,
                error_code=CMP_MCP_RESOURCE_INVALID,
                metadata={"result_kind": "mcp_resource_read"},
            )
        result = client_support.call_transport_resource(
            transport.read_resource,
            uri,
            timeout_seconds=budget.remaining_timeout(),
            cancel_handle=budget.cancel_handle,
        )
        contents = result.get("contents")
        if not isinstance(contents, list):
            contents = []
        content = next((item for item in contents if isinstance(item, dict)), None)
        if content is None:
            return resource_result_payload(
                {
                    "server_name": transport.server_name,
                    "status": "unsupported",
                    "reason": "resource returned no readable content",
                    "resource_id": resource_id
                    or namespace_mcp_resource_id(transport.server_name, uri),
                    "uri": uri,
                    "artifact_ref": None,
                },
                success=False,
                error_code=CMP_MCP_RESOURCE_UNSUPPORTED,
                metadata={"result_kind": "mcp_resource_read"},
            )
        return self._resource_read_content_payload(
            transport.server_name,
            resource_id=resource_id,
            uri=uri,
            descriptor=descriptor,
            content=content,
        )

    def _resource_read_content_payload(
        self,
        server_name: str,
        *,
        resource_id: str,
        uri: str,
        descriptor: MCPResourceDescriptor | None,
        content: dict[str, Any],
    ) -> dict[str, Any]:
        effective_resource_id = resource_id or namespace_mcp_resource_id(server_name, uri)
        mime_type = resource_mime_from_payload(content) or (
            descriptor.mime_type if descriptor else ""
        )
        raw_text = content.get("text")
        if not isinstance(raw_text, str):
            return resource_result_payload(
                {
                    "server_name": server_name,
                    "status": "unsupported",
                    "reason": "binary or non-text MCP resources are not supported yet",
                    "resource_id": effective_resource_id,
                    "uri": uri,
                    "mime_type": mime_type,
                    "artifact_ref": None,
                    "trust": MCPResourceReadResult(
                        server_name=server_name,
                        resource_id=effective_resource_id,
                        uri=uri,
                        mime_type=mime_type,
                    ).trust,
                },
                success=False,
                error_code=CMP_MCP_RESOURCE_UNSUPPORTED,
                metadata={"result_kind": "mcp_resource_read", "status": "unsupported"},
            )
        text_excerpt = sanitize_tool_output(
            raw_text,
            max_chars=MCP_RESOURCE_TEXT_EXCERPT_MAX_CHARS,
            tool_name="mcp_resource_read",
        )
        read_result = MCPResourceReadResult(
            server_name=server_name,
            resource_id=effective_resource_id,
            uri=uri,
            mime_type=mime_type,
            text_excerpt=text_excerpt,
            artifact_ref=None,
            truncated=len(raw_text) > MCP_RESOURCE_TEXT_EXCERPT_MAX_CHARS,
            size_bytes=resource_size_from_payload(content)
            or len(raw_text.encode("utf-8", errors="replace")),
        )
        payload = asdict(read_result)
        payload["status"] = "ok"
        return resource_result_payload(
            payload,
            metadata={
                "result_kind": "mcp_resource_read",
                "server_name": server_name,
                "truncated": read_result.truncated,
            },
        )

    def _clear_resource_cache_for_server(self, server_name: str) -> None:
        for resource_id, resource in list(self._resources_by_id.items()):
            if resource.server_name == server_name:
                self._resources_by_id.pop(resource_id, None)

    def _remove_server_registration(self, server_name: str) -> dict[str, MCPToolDescriptor]:
        transport = self._transports.pop(server_name, None)
        if transport is not None:
            transport.close()
        removed_descriptors = {
            name: descriptor
            for name, descriptor in self._tools_by_name.items()
            if descriptor.server_name == server_name
        }
        for name in removed_descriptors:
            self._tools_by_name.pop(name, None)
        self._clear_resource_cache_for_server(server_name)
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
            remaining_timeout = client_support.remaining_tool_timeout(
                deadline, timeout_seconds
            )
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
                server,
                request_timeout_seconds=effective_request_timeout,
            )
        if server.transport == "sse":
            if not sse_enabled:
                raise MCPError(
                    code=CMP_MCP_SSE_DISABLED,
                    message=f"sse transport is disabled for server '{server.name}'",
                    retryable=False,
                )
            return transport_sse.SSEMCPTransport(
                server,
                request_timeout_seconds=effective_request_timeout,
                allow_private_addresses=self._allow_private_addresses,
            )
        raise MCPError(
            code=CMP_MCP_CONFIG_INVALID,
            message=f"unsupported mcp transport '{server.transport}'",
            retryable=False,
        )
