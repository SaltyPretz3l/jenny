"""Read-only summary of the session's configured outbound connections."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any
from urllib.parse import urlsplit, urlunsplit

_LOCAL_ENGINES = frozenset({"mock", "ollama", "openai-compatible", "replay", "vllm"})
_CONNECTION_SERVER_FIELDS = 3


def _value(config: Any | None, key: str, default: object = None) -> object:
    if isinstance(config, dict):
        return config.get(key, default)
    return getattr(config, key, default)


def _clean_label(value: object, *, fallback: str) -> str:
    text = " ".join(str(value or "").split())
    return text[:80] or fallback


def _safe_host(value: object) -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""
    try:
        parts = urlsplit(raw if "://" in raw else f"//{raw}")
        host = parts.hostname or ""
        port = parts.port
    except ValueError:
        return ""
    if not host:
        return ""
    bracketed = f"[{host}]" if ":" in host else host
    return f"{bracketed}:{port}" if port is not None else bracketed


def _safe_base_url(value: object) -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""
    try:
        parts = urlsplit(raw)
        host = _safe_host(raw)
    except ValueError:
        return ""
    if not parts.scheme or not host:
        return ""
    return urlunsplit((parts.scheme.lower(), host, parts.path.rstrip("/"), "", ""))


def _mcp_rows(config: Any | None) -> list[str]:
    raw_servers = _value(config, "connections_mcp_servers")
    if raw_servers is None:
        raw_servers = _value(config, "mcp_servers", ())
    rows: list[tuple[str, str, str]] = []
    for server in raw_servers if isinstance(raw_servers, (list, tuple)) else ():
        if isinstance(server, (list, tuple)) and len(server) == _CONNECTION_SERVER_FIELDS:
            name, transport, raw_url = server
        else:
            name = _value(server, "name", "mcp")
            transport = _value(server, "transport", "unknown")
            raw_url = _value(server, "url", "")
        transport_label = _clean_label(transport, fallback="unknown").lower()
        if transport_label == "stdio":
            continue
        rows.append(
            (
                _clean_label(name, fallback="mcp"),
                transport_label,
                _safe_host(raw_url) or "host unavailable",
            )
        )
    rows.sort(key=lambda row: tuple(part.casefold() for part in row))
    return [f"{name} ({transport}, {host})" for name, transport, host in rows]


def _build_connections_output(
    config: Any | None, *, session_offline_lockdown: bool = False
) -> str:
    """Build a deterministic, secret-free view of the current runtime config."""
    engine_type = _clean_label(
        _value(config, "connections_engine_type", _value(config, "engine_type", "mock")),
        fallback="mock",
    ).lower()
    engine_locality = "local" if engine_type in _LOCAL_ENGINES else "remote"
    engine_host = _safe_host(
        _value(
            config,
            "connections_engine_host",
            _value(config, "chatgpt_base_url")
            if engine_type == "chatgpt"
            else _value(config, "api_url"),
        )
    )
    if engine_locality == "remote":
        engine_host = engine_host or (
            "chatgpt.com" if engine_type == "chatgpt" else "host unavailable"
        )
        engine_line = f"- Engine: {engine_type} — remote ({engine_host})"
    else:
        engine_line = f"- Engine: {engine_type} — local"

    web_enabled = _value(config, "tools_web_enabled", False) is True
    if web_enabled:
        provider = _clean_label(
            _value(config, "tools_web_search_provider", "duckduckgo"),
            fallback="duckduckgo",
        )
        web_detail = provider
        if provider.casefold() == "searxng":
            searxng_url = _safe_base_url(_value(config, "tools_web_searxng_url"))
            if searxng_url:
                web_detail = f"{web_detail}, searxng {searxng_url}"
        web_line = f"- Web tools: on ({web_detail})"
    else:
        web_line = "- Web tools: off"

    mcp_rows = _mcp_rows(config)
    mcp_line = f"- MCP servers: {', '.join(mcp_rows)}" if mcp_rows else "- MCP servers: none"
    lines = [
            engine_line,
            web_line,
            mcp_line,
            "- Plugins with network access: not reported by the host "
            "(needs connections_plugin_network_plugins)",
            "- Remote items above can receive what you type here.",
            "- Background traffic not carrying your messages: model catalog refresh; "
            "app auto-updater (when enabled)",
    ]
    if session_offline_lockdown:
        lines.insert(0, "- Offline lockdown: ON (this session)")
    return "\n".join(lines)


def connections_list_tool(
    arguments: dict[str, object],
    workspace: object,
    *,
    config: Any | None = None,
) -> str:
    """Return the configured outbound-connection summary without probing."""
    session_offline_lockdown = arguments.get("_jenny_session_offline_lockdown") is True
    del workspace
    return _build_connections_output(
        config, session_offline_lockdown=session_offline_lockdown
    )


def build_connections_tool(
    config: Any | None,
) -> Callable[[dict[str, object], object], str]:
    """Bind one registry's config without sharing mutable module state."""

    def configured_connections_list_tool(
        arguments: dict[str, object], workspace: object
    ) -> str:
        return connections_list_tool(arguments, workspace, config=config)

    return configured_connections_list_tool
