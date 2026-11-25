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
    # Optional per-action side-effect metadata (W6): resolved by
    # sidecar.ai.tools.tool_actions.effective_side_effecting at call sites.
    actions: dict[str, ToolActionSpec] | None = None
    # tool_search ranking hint; empty = derived from the description's first
    # sentence when the search index is built (tool_search.build_search_index).
    search_hint: str = ""


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
    # Live Electron preview only; consumed before outcomes/events are formed.
    preview_image: dict[str, Any] | None = field(default=None, repr=False, compare=False)


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
