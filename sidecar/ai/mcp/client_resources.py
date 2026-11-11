"""``MCPClient`` resource adapters: capability probes, adapter descriptors, list payloads.

Split from ``client.py`` (at the 1015-line hard cap, row 105). Dispatching an adapter
call and reading a resource stay in ``client.py``; the list payloads here refresh the
resource-id cache that the read path consults.
"""

from __future__ import annotations

import logging
import threading
from dataclasses import asdict
from typing import Any

from sidecar.ai.mcp import client_support, transport_base
from sidecar.ai.mcp.exceptions import MCPError
from sidecar.ai.mcp.models import MCPResourceDescriptor, MCPToolDescriptor
from sidecar.ai.mcp.resource_payloads import (
    MCP_RESOURCE_TOOL_LIST_RESOURCES,
    MCP_RESOURCE_TOOL_LIST_TEMPLATES,
    MCP_RESOURCE_TOOL_READ_RESOURCE,
    collect_paginated_resource_items,
    resource_descriptor_from_payload,
    resource_result_payload,
    resource_template_from_payload,
)
from sidecar.ai.mcp.tool_namespace import namespace_mcp_tool_name
from sidecar.runtime.diagnostics import log_event

# Records keep the client's logger name (this code moved out of client.py).
logger = logging.getLogger("sidecar.ai.mcp.client")


class ClientResourcesMixin:
    # Host-state declarations for static type-checking only: ``MCPClient`` sets
    # these in ``__init__``; bare annotations have no runtime effect.
    _transport_registry_lock: threading.RLock
    _tools_by_name: dict[str, MCPToolDescriptor]
    _resources_by_id: dict[str, MCPResourceDescriptor]
    _request_timeout_seconds: float | None

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

    def _clear_resource_cache_for_server(self, server_name: str) -> None:
        for resource_id, resource in list(self._resources_by_id.items()):
            if resource.server_name == server_name:
                self._resources_by_id.pop(resource_id, None)
