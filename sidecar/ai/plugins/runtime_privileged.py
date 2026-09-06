"""Immutable Stage 8 descriptor records kept separate from registry mechanics."""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from sidecar.ai.plugins.runtime_registry import PluginRuntimeAuthority


@dataclass(frozen=True, slots=True)
class PluginNativeToolDescriptor:
    name: str
    description: str
    input_schema: dict[str, Any]
    binding_digest: str
    publisher_id: str
    plugin_id: str
    contribution_id: str
    side_effecting: bool = True
    server_name: str = "electron_tool_bridge"
    source_kind: str = "plugin_native_mcp"
    tool_family: str = "other"
    server_tool_name: str = ""


@dataclass(frozen=True, slots=True)
class PluginEngineBinding:
    authority: "PluginRuntimeAuthority"
    adapter_id: str
    binding_digest: str
    descriptor: dict[str, Any]
