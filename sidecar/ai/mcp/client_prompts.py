"""`MCPClient.get_prompt`: a bounded, uncached prompt fetch from a connected transport."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, cast

from sidecar.ai.mcp.exceptions import (
    CMP_MCP_CONFIG_INVALID,
    CMP_MCP_SERVER_FAILED,
    CMP_MCP_TOOL_NOT_FOUND,
    MCPError,
)
from sidecar.ai.mcp.prompt_surface import (
    MAX_PROMPT_ARGUMENT_VALUE_CHARS,
    MAX_PROMPT_ARGUMENTS,
    PROMPT_NAME_RE,
    prompt_text_from_messages,
    summarize_prompts,
)

if TYPE_CHECKING:
    from sidecar.ai.mcp.client import MCPClient


class ClientPromptsMixin:
    def get_prompt(
        self,
        server_name: str,
        name: str,
        arguments: dict[str, str],
        *,
        cancel_handle: Any = None,
    ) -> str:
        client = cast("MCPClient", self)
        with client._transport_registry_lock:
            transport = client._transports.get(server_name)
            config = client._server_configs.get(server_name)
        if transport is None:
            raise MCPError(code=CMP_MCP_SERVER_FAILED, retryable=False,
                           message=f"MCP server '{server_name}' is not connected")
        if not isinstance(name, str) or PROMPT_NAME_RE.fullmatch(name) is None:
            raise MCPError(code=CMP_MCP_CONFIG_INVALID, retryable=False,
                           message="MCP prompt name is invalid")
        if (not isinstance(arguments, dict) or len(arguments) > MAX_PROMPT_ARGUMENTS or any(
            not isinstance(key, str) or PROMPT_NAME_RE.fullmatch(key) is None
            or not isinstance(value, str) or len(value) > MAX_PROMPT_ARGUMENT_VALUE_CHARS
            for key, value in arguments.items()
        )):
            raise MCPError(code=CMP_MCP_CONFIG_INVALID, retryable=False,
                           message="MCP prompt arguments must be bounded, named strings")
        prompts, _malformed = summarize_prompts(transport.list_prompts(cancel_handle=cancel_handle))
        row = next((prompt for prompt in prompts if prompt["name"] == name), None)
        if row is None:
            raise MCPError(code=CMP_MCP_TOOL_NOT_FOUND, retryable=False,
                           message=f"prompt '{name}' is not advertised")
        advertised = {argument["name"] for argument in row["arguments"]}
        unknown = sorted(set(arguments) - advertised)
        if unknown:
            raise MCPError(code=CMP_MCP_CONFIG_INVALID, retryable=False,
                           message=f"MCP prompt does not take argument '{unknown[0]}'")
        for argument in row["arguments"]:
            if argument["required"] and not arguments.get(argument["name"], "").strip():
                raise MCPError(code=CMP_MCP_CONFIG_INVALID, retryable=False,
                               message=f"MCP prompt requires argument '{argument['name']}'")
        # The shared MCP worker slot is held for this fetch: never longer than the server's
        # own request timeout, even when the client-wide tool budget is larger.
        candidates = [client._request_timeout_seconds,
                      config.request_timeout_seconds if config is not None else None]
        bounded = [value for value in candidates if value is not None]
        timeout_seconds = min(bounded) if bounded else None
        result = transport.get_prompt(name, arguments, timeout_seconds=timeout_seconds,
                                      cancel_handle=cancel_handle)
        return prompt_text_from_messages(result)
