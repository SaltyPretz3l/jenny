"""Name normalization for external MCP tools."""

from __future__ import annotations

import hashlib
import re

from sidecar.ai.tools.catalog import BUILTIN_MCP_SERVER_NAME

MCP_TOOL_NAMESPACE_PREFIX = "mcp__"
MCP_RESOURCE_NAMESPACE_PREFIX = "mcp_resource__"
_COMPONENT_PATTERN = re.compile(r"[^a-z0-9_]+")
_UNDERSCORE_RUN_PATTERN = re.compile(r"_+")


def normalize_mcp_name_component(value: str, *, fallback: str = "server") -> str:
    """Return a safe snake-like namespace component."""
    lowered = str(value or "").strip().lower()
    normalized = _COMPONENT_PATTERN.sub("_", lowered)
    normalized = _UNDERSCORE_RUN_PATTERN.sub("_", normalized).strip("_")
    return normalized or fallback


def namespace_mcp_tool_name(server_name: str, raw_tool_name: str) -> str:
    """Namespace external MCP tool names while preserving Jenny builtins."""
    tool_name = str(raw_tool_name or "").strip()
    if str(server_name or "").strip() == BUILTIN_MCP_SERVER_NAME:
        return tool_name
    server_component = normalize_mcp_name_component(server_name, fallback="server")
    tool_component = normalize_mcp_name_component(tool_name, fallback="tool")
    return f"{MCP_TOOL_NAMESPACE_PREFIX}{server_component}__{tool_component}"


def is_namespaced_mcp_tool_name(tool_name: str) -> bool:
    return str(tool_name or "").strip().startswith(MCP_TOOL_NAMESPACE_PREFIX)


def namespace_mcp_resource_id(server_name: str, uri: str) -> str:
    """Return a stable per-server resource id for an MCP resource URI."""
    server_component = normalize_mcp_name_component(server_name, fallback="server")
    digest = hashlib.sha256(str(uri or "").encode("utf-8", errors="replace")).hexdigest()[:16]
    return f"{MCP_RESOURCE_NAMESPACE_PREFIX}{server_component}__{digest}"
