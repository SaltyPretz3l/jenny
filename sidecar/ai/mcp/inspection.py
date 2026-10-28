"""One-shot MCP trust inspection that never mutates the live tool catalog."""

from __future__ import annotations

from dataclasses import replace
from time import perf_counter
from typing import Any

from sidecar.ai.config_parsing import _parse_mcp_servers
from sidecar.ai.error_codes import CMP_MCP_SERVER_FAILED, CMP_MCP_SSE_DISABLED
from sidecar.ai.mcp.client import MCPClient
from sidecar.ai.mcp.exceptions import MCPError
from sidecar.ai.mcp.prompt_surface import prompts_digest, summarize_prompts
from sidecar.ai.mcp.tool_surface import ToolSurfaceError, summarize_tools, tools_digest
from sidecar.runtime.chat_models import TerminalChatStateError


def _list_inspection_prompts(transport: Any, *,
                            cancel_handle: Any) -> list[dict[str, Any]]:
    # A server without the prompts capability answers prompts/list with a JSON-RPC error
    # (-32601 in the SDKs, other codes and wordings elsewhere); the stdio transport keeps
    # only the message, so any error *reply* counts as "no prompts". A transport failure,
    # timeout or cancellation (no reply) still fails the inspection.
    try:
        return transport.list_prompts(cancel_handle=cancel_handle)
    except MCPError as error:
        if not error.response_received:
            raise
        return []


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
    sse_enabled = params.get("mcp_sse_enabled") is True
    if transport_kind == "sse" and not sse_enabled:
        return {"ok": False, "failure": {"code": CMP_MCP_SSE_DISABLED, "reason": "sse_disabled"}}
    client = None
    probe_transport = None
    try:
        parsed = _parse_mcp_servers([server], sse_enabled=sse_enabled)
        if len(parsed) != 1:
            raise ValueError("server_invalid")
        inspect_timeout = parsed[0].inspect_timeout_seconds
        client = MCPClient(request_timeout_seconds=inspect_timeout)
        client._allow_private_addresses = bool(allow_private_addresses)
        config = replace(
            parsed[0],
            request_timeout_seconds=min(parsed[0].request_timeout_seconds, inspect_timeout),
            init_timeout_seconds=min(parsed[0].init_timeout_seconds, inspect_timeout),
        )
        probe_transport = client._build_transport(config, sse_enabled=sse_enabled)
        raw_tools = probe_transport.list_tools(cancel_handle=cancel_handle)
        tools = summarize_tools(raw_tools)
        raw_prompts = _list_inspection_prompts(probe_transport, cancel_handle=cancel_handle)
        prompts, malformed_prompt_count = summarize_prompts(raw_prompts)
        return {
            "ok": True,
            "identity": {"name": config.name},
            "transport": config.transport,
            # The digest covers the full rows; the reply carries display rows only, so a
            # large schema surface cannot exceed the Electron frame limit.
            "tools": [{k: v for k, v in row.items() if k != "inputSchema"} for row in tools],
            "tools_digest": tools_digest(tools, read_only_claims=config.read_only_auto_allow),
            "tool_count": len(tools),
            "prompts": prompts,
            "prompts_digest": prompts_digest(prompts),
            "prompt_count": len(prompts),
            "malformed_prompt_count": malformed_prompt_count,
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
    except ToolSurfaceError as error:
        # The detail is bounded: a tool name capped at MAX_NAME_CHARS plus ints.
        return {
            "ok": False,
            "failure": {
                "code": CMP_MCP_SERVER_FAILED,
                "reason": error.reason,
                "retryable": False,
                "detail": error.log_data(),
            },
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
        if client is not None:
            client.close()
