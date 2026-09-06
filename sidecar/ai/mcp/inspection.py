"""One-shot MCP trust inspection that never mutates the live tool catalog."""

from __future__ import annotations

from dataclasses import replace
from time import perf_counter
from typing import Any

from sidecar.ai.config_parsing import _parse_mcp_servers
from sidecar.ai.error_codes import CMP_MCP_SERVER_FAILED, CMP_MCP_SSE_DISABLED
from sidecar.ai.mcp.client import MCPClient
from sidecar.ai.mcp.exceptions import MCPError
from sidecar.ai.mcp.tool_surface import summarize_tools, tools_digest
from sidecar.runtime.chat_models import TerminalChatStateError


def inspect_server(  # noqa: PLR0911 -- explicit bounded validation/failure contract
    params: Any,
    *,
    allow_private_addresses: bool = False,
    cancel_handle: Any = None,
) -> dict[str, Any]:
    started = perf_counter()
    server = params.get("server") if isinstance(params, dict) else None
    if not isinstance(server, dict):
        return {"ok": False, "failure": {"code": CMP_MCP_SSE_DISABLED, "reason": "server_invalid"}}
    transport_kind = str(server.get("transport") or "stdio").strip().lower()
    if transport_kind == "stdio" and params.get("confirmed_stdio") is not True:
        return {
            "ok": False,
            "failure": {"code": CMP_MCP_SSE_DISABLED, "reason": "stdio_confirmation_required"},
        }
    if transport_kind not in {"stdio", "sse"}:
        return {
            "ok": False,
            "failure": {"code": CMP_MCP_SSE_DISABLED, "reason": "transport_unsupported"},
        }
    client = MCPClient(request_timeout_seconds=15.0)
    client._allow_private_addresses = bool(allow_private_addresses)
    probe_transport = None
    try:
        parsed = _parse_mcp_servers([server], sse_enabled=transport_kind == "sse")
        if len(parsed) != 1:
            raise ValueError("server_invalid")
        config = replace(
            parsed[0],
            request_timeout_seconds=min(parsed[0].request_timeout_seconds, 15.0),
            init_timeout_seconds=min(parsed[0].init_timeout_seconds, 15.0),
        )
        probe_transport = client._build_transport(config, sse_enabled=transport_kind == "sse")
        raw_tools = probe_transport.list_tools(cancel_handle=cancel_handle)
        tools, malformed_count = summarize_tools(raw_tools)
        return {
            "ok": True,
            "identity": {"name": config.name},
            "transport": config.transport,
            "tools": tools,
            "tools_digest": tools_digest(tools),
            "tool_count": len(tools),
            "malformed_tool_count": malformed_count,
            "latency_ms": round((perf_counter() - started) * 1000, 3),
        }
    except TerminalChatStateError:
        return {
            "ok": False,
            "failure": {
                "code": CMP_MCP_SERVER_FAILED,
                "reason": "probe_cancelled",
                "retryable": True,
            },
            "latency_ms": round((perf_counter() - started) * 1000, 3),
        }
    except MCPError as error:
        return {
            "ok": False,
            "failure": {"code": error.code, "reason": "probe_failed", "retryable": error.retryable},
            "latency_ms": round((perf_counter() - started) * 1000, 3),
        }
    except Exception as error:  # noqa: BLE001
        return {
            "ok": False,
            "failure": {"code": CMP_MCP_SERVER_FAILED, "reason": type(error).__name__[:64]},
            "latency_ms": round((perf_counter() - started) * 1000, 3),
        }
    finally:
        if probe_transport is not None:
            probe_transport.close()
        client.close()
