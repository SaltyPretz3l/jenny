"""Reuse of live MCP transports across sidecar stack generations.

Every managed-config refresh builds a new ``MCPClient``. A server whose reuse
key is unchanged keeps its live transport: the new client adopts it and the
previous client hands it off. The previous client keeps serving the transport
to its leased turns until it retires, but never closes it. A candidate that
fails hands its adoptions back, or closes them when the previous client no
longer holds them, so no process is left without an owner.
"""

from __future__ import annotations

import dataclasses
import hashlib
import json
import logging
from typing import TYPE_CHECKING, Any

from sidecar.ai.mcp.exceptions import as_setup_error
from sidecar.ai.mcp.models import MCPServerFailure
from sidecar.runtime.diagnostics import log_event

if TYPE_CHECKING:
    from sidecar.ai.config import MCPServerConfig
    from sidecar.ai.mcp.client import MCPClient
    from sidecar.ai.mcp.transport_base import MCPTransport

# Client events keep the client's logger.
logger = logging.getLogger("sidecar.ai.mcp.client")


@dataclasses.dataclass
class ReuseState:
    """One client's reuse bookkeeping; ``MCPClient.close`` starts a fresh one."""

    keys: dict[str, str] = dataclasses.field(default_factory=dict)
    # Transports this client still lists but no longer owns.
    handed_off: list[MCPTransport] = dataclasses.field(default_factory=list)
    adopted: list[tuple[str, MCPTransport]] = dataclasses.field(default_factory=list)
    source: MCPClient | None = None

    def owns(self, transport: MCPTransport) -> bool:
        return not any(item is transport for item in self.handed_off)


def _sha256(value: Any) -> str:
    text = json.dumps(value, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def reuse_key(
    config: MCPServerConfig,
    *,
    sse_enabled: bool,
    resources_enabled: bool,
    allow_private_addresses: bool,
) -> str:
    """Digest of everything that shapes a server's transport.

    Every config field counts, so a field added later is covered without an
    edit here. The resolved auth (bearer token or client secret included) is
    present only as its own digest; no secret reaches the key or a log.
    """
    fields = {
        field.name: getattr(config, field.name)
        for field in dataclasses.fields(config)
        if field.name != "auth"
    }
    auth = config.auth
    return _sha256(
        {
            "config": fields,
            "auth_sha256": None if auth is None else _sha256(dataclasses.asdict(auth)),
            "sse_enabled": bool(sse_enabled),
            "resources_enabled": bool(resources_enabled),
            "allow_private_addresses": bool(allow_private_addresses),
        }
    )


def adoptable(
    previous: MCPClient, name: str, key: str, *, request_timeout_seconds: float | None
) -> MCPTransport | None:
    """The previous client's live transport for ``name`` when ``key`` still matches."""
    transport = previous._transports.get(name)
    if (
        transport is None
        or previous._reuse.keys.get(name) != key
        or previous._request_timeout_seconds != request_timeout_seconds
        or name not in previous._connected
        or not previous._reuse.owns(transport)
        or getattr(transport, "is_terminated", False) is True
    ):
        return None
    return transport


def connect_servers(
    client: MCPClient, servers: tuple[MCPServerConfig, ...], *, reuse_from: MCPClient | None
) -> None:
    """Adopt or build each server; hand adoptions back if anything escapes."""
    state = client._reuse
    state.source = reuse_from
    try:
        for server in servers:
            key = reuse_key(
                server,
                sse_enabled=client._sse_enabled,
                resources_enabled=client._resources_enabled,
                allow_private_addresses=client._allow_private_addresses,
            )
            state.keys[server.name] = key
            if reuse_from is not None and _adopt(client, reuse_from, server.name, key):
                continue
            try:
                transport = client._build_transport(server, sse_enabled=client._sse_enabled)
                try:
                    client._register_transport(transport)
                except BaseException:
                    if client._transports.get(server.name) is not transport:
                        transport.close()  # built but never registered: nobody else can
                    raise
            except Exception as caught:  # noqa: BLE001 -- isolate each server's setup
                _record_setup_failure(client, server.name, caught)
    except BaseException:
        return_adopted(client)
        raise


def _record_setup_failure(client: MCPClient, server_name: str, caught: Exception) -> None:
    error = as_setup_error(caught)
    client._record_failure(
        MCPServerFailure(name=server_name, code=error.code, message=error.message)
    )
    log_event(
        logger,
        logging.WARNING,
        component="ai.mcp.client",
        event="ai.mcp.server_setup_failed",
        message=f"MCP server setup failed: {server_name}",
        status="failure",
        data={"server": server_name, "code": error.code},
    )


def _adopt(client: MCPClient, previous: MCPClient, name: str, key: str) -> bool:
    with previous._transport_registry_lock:
        transport = adoptable(
            previous, name, key, request_timeout_seconds=client._request_timeout_seconds
        )
        if transport is None:
            return False
        descriptors = {
            tool_name: descriptor
            for tool_name, descriptor in previous._tools_by_name.items()
            if descriptor.server_name == name
        }
        if any(tool_name in client._tools_by_name for tool_name in descriptors):
            return False  # a fresh build reports the namespace collision
        previous._reuse.handed_off.append(transport)
        client._tools_by_name.update(descriptors)
        client._resources_by_id.update(
            {rid: res for rid, res in previous._resources_by_id.items() if res.server_name == name}
        )
        client._failures.extend(row for row in previous._failures if row.name == name)
        from sidecar.ai.mcp.client import MCP_COOLDOWN_NAMESPACE as namespace

        cooldown = previous._cooldowns.status(namespace, name)
        if cooldown.active:
            client._cooldowns.mark(
                namespace,
                name,
                duration_seconds=cooldown.remaining_seconds,
                reason=cooldown.reason,
            )
    client._rebuild_compat_tool_index()
    client._transports[name] = transport
    client._connected.append(name)
    client._reuse.adopted.append((name, transport))
    log_event(
        logger,
        logging.INFO,
        component="ai.mcp.client",
        event="ai.mcp.transport_reused",
        message=f"MCP server transport reused across generations: {name}",
        status="ok",
        data={"server": name},
    )
    return True


def return_adopted(client: MCPClient) -> None:
    """Undo a failed candidate's adoptions; idempotent.

    The candidate stops owning each adopted transport it still holds. The
    source client owns it again while it still lists that transport; otherwise
    nobody does, so it closes here.
    """
    with client._transport_registry_lock:
        state = client._reuse
        adopted, state.adopted = state.adopted, []
        for name, transport in adopted:
            if client._transports.get(name) is not transport or not state.owns(transport):
                continue  # already closed by this client, or already returned
            state.handed_off.append(transport)
            if state.source is None or not _take_back(state.source, name, transport):
                transport.close()


def _take_back(source: MCPClient, name: str, transport: MCPTransport) -> bool:
    with source._transport_registry_lock:
        if source._transports.get(name) is not transport:
            return False
        handed_off = source._reuse.handed_off
        handed_off[:] = [item for item in handed_off if item is not transport]
        return True
