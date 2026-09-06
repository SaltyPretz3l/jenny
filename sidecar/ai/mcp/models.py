"""Data contracts for MCP client/server interactions."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from sidecar.ai.tools.tool_actions import ToolActionSpec


@dataclass(frozen=True)
class MCPToolDescriptor:
    name: str
    description: str
    input_schema: dict[str, Any]
    side_effecting: bool
    server_name: str
    source_kind: str = "mcp"
    tool_family: str = "other"
    server_tool_name: str | None = None
    synthetic_resource_tool: bool = False
    # Optional per-action side-effect metadata (W6): resolved by
    # sidecar.ai.tools.tool_actions.effective_side_effecting at call sites.
    actions: dict[str, ToolActionSpec] | None = None


@dataclass(frozen=True)
class MCPToolResult:
    tool_name: str
    output: str
    success: bool
    content_type: str = "text"
    ui_payload: dict[str, Any] | None = None
    generated_artifacts: tuple[dict[str, Any], ...] = ()
    error_code: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)
    # WIDE-019: typed trusted-attachment payloads (snake_case wire dicts).
    # Transport-shaped only at this layer — the fail-closed admission gate
    # (builtin read_file/python_execute only) runs in routing.tool_execution.
    trusted_attachments: tuple[dict[str, Any], ...] = ()


@dataclass(frozen=True)
class MCPServerFailure:
    name: str
    code: str
    message: str


@dataclass(frozen=True)
class MCPServerCooldown:
    name: str
    remaining_seconds: float
    reason: str


@dataclass(frozen=True)
class MCPServerDiagnostics:
    connected: tuple[str, ...]
    failures: tuple[MCPServerFailure, ...]
    cooldowns: tuple[MCPServerCooldown, ...] = ()


# ---------------------------------------------------------------------------
# MCP resources.
#
# Every resource descriptor carries a ``trust`` label so renderer surfaces and
# rule matchers can treat MCP resource content as untrusted by default.
# ---------------------------------------------------------------------------

# Sentinel for resource content that originated from an MCP server. Renderers
# should label it as untrusted; the policy evaluator's source_kind matcher
# can scope rules to it.
RESOURCE_TRUST_UNTRUSTED_MCP = "untrusted_mcp_resource"


@dataclass(frozen=True)
class MCPResourceDescriptor:
    """A resource advertised by an MCP server's ``resources/list`` reply.

    ``resource_id`` is the namespaced id used inside Jenny
    (``mcp://<server>/<uri-slug>``); the raw server-supplied ``uri`` is
    preserved separately so the transport layer can issue ``resources/read``
    calls with the exact string the server expects.
    """

    server_name: str
    resource_id: str
    uri: str
    name: str
    description: str = ""
    mime_type: str = ""
    size_bytes: int | None = None
    annotations: dict[str, Any] = field(default_factory=dict)
    trust: str = RESOURCE_TRUST_UNTRUSTED_MCP


@dataclass(frozen=True)
class MCPResourceTemplate:
    """A URI template advertised by ``resources/templates/list``."""

    server_name: str
    name: str
    uri_template: str
    description: str = ""
    mime_type: str = ""
    annotations: dict[str, Any] = field(default_factory=dict)
    trust: str = RESOURCE_TRUST_UNTRUSTED_MCP


@dataclass(frozen=True)
class MCPResourceReadResult:
    """A bounded read of one MCP resource.

    For text resources, ``text_excerpt`` carries the (capped + sanitized)
    inline content. For binary or oversized resources, ``artifact_ref``
    carries a Jenny artifact id created by the eventual Electron handoff
    described in Section 18 of the rich-file plan (Option A: extend
    ``create_artifact_tool``).
    """

    server_name: str
    resource_id: str
    uri: str
    mime_type: str
    text_excerpt: str | None = None
    artifact_ref: str | None = None
    truncated: bool = False
    size_bytes: int | None = None
    trust: str = RESOURCE_TRUST_UNTRUSTED_MCP
