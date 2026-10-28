"""Background MCP connect during candidate-stack construction.

Spawning the builtin MCP server and completing its handshake costs ~0.5 s in a
dev checkout and ~1.1 s packaged. ``BrainContainer`` plans that connection from
the parsed config before ``create_engine`` and runs ``MCPClient.configure`` on a
worker thread, so it overlaps the engine probe, memory open and context build.

Once the effective config is known the plan is recomputed. An equal plan keeps
the running connect; a changed one (engine fallback, an app-profile tool
override) is discarded and connected again from the effective plan, so the
stack never serves a client built from a stale config. The worker is joined
before ``ChatRouter`` construction and its exception, if any, is re-raised there
unchanged; on an unwinding failure it is joined before the client is closed.
"""

from __future__ import annotations

import threading
from contextvars import copy_context
from dataclasses import dataclass
from typing import Any

from sidecar.ai.config import MCPServerConfig


@dataclass(frozen=True)
class MCPConnectPlan:
    """Every input ``MCPClient`` construction and ``configure`` read."""

    servers: tuple[MCPServerConfig, ...]
    request_timeout_seconds: float
    sse_enabled: bool
    resources_enabled: bool
    allow_private_addresses: bool


class MCPConnectTask:
    """One ``MCPClient.configure`` call running on a worker thread."""

    def __init__(self, client: Any, plan: MCPConnectPlan, *, reuse_from: Any) -> None:
        self.client = client
        self.plan = plan
        self._error: BaseException | None = None
        # The copied context keeps diagnostics correlation on the worker's log lines.
        self._thread = threading.Thread(
            target=copy_context().run,
            args=(self._run, reuse_from),
            name="jenny-mcp-connect",
            daemon=True,
        )
        self._thread.start()

    def _run(self, reuse_from: Any) -> None:
        try:
            self.client.configure(
                self.plan.servers,
                sse_enabled=self.plan.sse_enabled,
                resources_enabled=self.plan.resources_enabled,
                allow_private_addresses=self.plan.allow_private_addresses,
                reuse_from=reuse_from,
            )
        except BaseException as error:  # noqa: BLE001 - re-raised by result() in the joining thread
            self._error = error

    def result(self) -> Any:
        """Wait for the connect; return the client or re-raise its exception unchanged."""
        self._thread.join()
        error, self._error = self._error, None
        if error is not None:
            raise error
        return self.client

    def settle(self) -> None:
        """Wait without raising, for discard and unwinding.

        A failure already in flight wins, exactly as before this connect ran in
        the background, when a failing earlier step meant it never started.
        """
        self._thread.join()
        self._error = None
