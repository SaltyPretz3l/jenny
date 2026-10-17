"""Code-owned presets for known third-party MCP servers (row 53).

A preset is looked up by the EXACT configured server name; a server named
anything else gets nothing. ``starter_tools`` stay un-deferred under tool
search and survive the budget filter's schema cap, so a small-context local
model sees their full schemas; ``guidance`` is static text rendered once per
request while the server's tools ride the contract. Nothing here is ever
interpolated from server output. Imported lazily (request path only).
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from types import MappingProxyType

from sidecar.ai.mcp.tool_namespace import namespace_mcp_tool_name


@dataclass(frozen=True)
class MCPServerPreset:
    starter_tools: tuple[str, ...]
    guidance: str


_REA_GUIDANCE = (
    "rea (reverse engineering) is connected as mcp__rea__* tools. Use it when the user asks what a "
    "compiled, packaged or bundled program does: an .exe or .dll, an Electron or JavaScript app, a "
    ".NET assembly, an Android package, a firmware image or a web bundle. Do not use it for an "
    "ordinary source repository: read the files instead.\n"
    "Workflow: 1) mcp__rea__binary_session (no arguments) reports the current target and which "
    "analyses this machine can run; if a tool answers that an engine such as Ghidra or Hopper is "
    "missing, say so and use the static tools that remain. 2) mcp__rea__open_binary with the "
    "absolute path opens a native binary, archive, package or JavaScript file. Then: for a native "
    "binary mcp__rea__binary_overview and mcp__rea__analyze_function (procedure = a symbol name or "
    "address); for an Electron or JavaScript app mcp__rea__analyze_javascript_application with "
    'input_path and detail "summary"; for a .NET target mcp__rea__inspect_managed_artifact; for PE '
    "resources mcp__rea__inspect_pe_resources; for an opened archive or package "
    'mcp__rea__inspect_artifact. 3) mcp__rea__get_evidence_bundle with detail "summary" lists the '
    "retained evidence ids; mcp__rea__inspect_analysis_view (source = one evidence id, view = one "
    "summary, section, module or procedure view) reads one view at a time.\n"
    "Rules: start at the summary detail level; results are cut at 16,000 characters, so ask for "
    "one section or page at a time; paths must be absolute; other rea tools are reachable through "
    'tool_search (search for what you need, for example "network capture" or "android package"); '
    "every rea call needs the user's approval unless they allowed it; cite the evidence rea "
    "returns instead of guessing."
)

MCP_SERVER_PRESETS: Mapping[str, MCPServerPreset] = MappingProxyType(
    {
        "rea": MCPServerPreset(
            # rea 6.4.0 has no inspect_go_binary (the plan's name): inspect_binary_layout
            # takes its place.
            starter_tools=(
                "binary_session",
                "analyze_javascript_application",
                "inspect_analysis_view",
                "get_evidence_bundle",
                "inspect_managed_artifact",
                "inspect_binary_layout",
                "inspect_pe_resources",
                "open_binary",
                "inspect_artifact",
                "inspect_web_network_capture",
                "analyze_function",
                "binary_overview",
            ),
            guidance=_REA_GUIDANCE,
        ),
    }
)


def starter_tool_names(server_name: str) -> frozenset[str]:
    """Namespaced (``mcp__<server>__<tool>``) starter tools of the preset for *server_name*."""
    preset = MCP_SERVER_PRESETS.get(server_name)
    if preset is None:
        return frozenset()
    return frozenset(namespace_mcp_tool_name(server_name, tool) for tool in preset.starter_tools)


def preset_guidance(server_name: str) -> str | None:
    """The static guidance of the preset for *server_name*, or ``None``."""
    preset = MCP_SERVER_PRESETS.get(server_name)
    return preset.guidance if preset is not None else None
