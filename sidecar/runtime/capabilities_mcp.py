"""The MCP-derived parts of the initialize result: the configured servers, and the
built-in worker's hosted file state on a host with a root boundary."""

from __future__ import annotations

from typing import Any

from sidecar.ai.tools.catalog import BUILTIN_MCP_SERVER_NAME


def configured_mcp_servers_payload(runtime_config: Any) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for config in getattr(runtime_config, "mcp_servers", ()) or ():
        name = str(getattr(config, "name", "") or "").strip()
        if not name:
            continue
        rows.append(
            {
                "name": name,
                "transport": str(getattr(config, "transport", "") or "").strip() or "stdio",
            }
        )
    return rows


def hosted_files_result(runtime_config: Any, mcp_client: Any) -> dict[str, Any]:
    """`{"hosted_files": {available, reason}}` on a root-boundary host, else nothing.

    No answer from the worker (not connected, an older worker) is not available."""
    if getattr(runtime_config, "hosted_root_boundary", None) is None:
        return {}
    lookup = getattr(mcp_client, "server_hosted_files", None)
    state = lookup(BUILTIN_MCP_SERVER_NAME) if callable(lookup) else None
    if not isinstance(state, dict):
        return {"hosted_files": {"available": False, "reason": None}}
    reason = state.get("reason")
    reason = reason if isinstance(reason, str) else None
    available = state.get("available") is True and reason is None
    return {"hosted_files": {"available": available, "reason": reason}}
